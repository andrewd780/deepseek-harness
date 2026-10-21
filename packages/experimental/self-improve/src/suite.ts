/**
 * A task suite on disk: one JSON file naming each task's prompt, the files it
 * starts from, and the checks that score it, plus the texts that brief the
 * search roles about the suite.
 *
 * ```json
 * {
 *   "briefs": { "analyst": "...", "proposer": "...", "critic": "..." },
 *   "criticPatterns": [{ "pattern": "fixtures/", "reason": "names a task fixture" }],
 *   "smoke": ["hello"],
 *   "tasks": [{
 *     "id": "hello",
 *     "split": "evolve",
 *     "prompt": "Create hello.txt containing a greeting.",
 *     "workspace": "fixtures/hello",
 *     "checks": [{ "file": "hello.txt", "matches": "hello" }, { "command": ["node", "check.mjs"], "timeoutMs": 60000 }]
 *   }]
 * }
 * ```
 *
 * A trial's reward is the fraction of its task's checks that pass. An
 * `answer` check matches the final response, a `file` check matches a file
 * the trial left in its workspace, and a `command` check passes when the
 * command exits 0 in that workspace.
 *
 * @module @deepseek-ai/dsh-experimental-self-improve/suite
 */

import { readFile, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, resolve, sep } from 'node:path'

import { TaskId } from './brand.ts'
import type { CriticPattern, DomainBriefs } from './types.ts'

/** The final response matches `answer`. */
export interface AnswerCheck {
  readonly answer: RegExp
}

/** The workspace file `file` exists and matches `matches`. */
export interface FileCheck {
  readonly file: string
  readonly matches: RegExp
}

/** `command` exits 0 in the workspace within `timeoutMs`. */
export interface CommandCheck {
  readonly command: readonly [string, ...string[]]
  readonly timeoutMs: number
}

/** One way a task is scored. */
export type SuiteCheck = AnswerCheck | FileCheck | CommandCheck

/** One task of the suite. */
export interface SuiteTask {
  readonly id: TaskId
  readonly split: 'evolve' | 'heldout'
  readonly prompt: string
  /** Absolute directory copied into each trial's workspace; absent starts empty. */
  readonly workspace?: string
  readonly checks: readonly [SuiteCheck, ...SuiteCheck[]]
}

/** A validated suite. */
export interface Suite {
  readonly briefs: DomainBriefs
  readonly criticPatterns: readonly CriticPattern[]
  readonly smoke: readonly TaskId[]
  readonly tasks: ReadonlyMap<TaskId, SuiteTask>
}

/** Runs a check command in a workspace and reports whether it exited 0. */
export type CommandRunner = (argv: readonly [string, ...string[]], cwd: string, timeoutMs: number, signal?: AbortSignal) => Promise<boolean>

/** One check's outcome. */
export interface CheckResult {
  readonly check: string
  readonly passed: boolean
}

const TASK_ID = /^[\w.-]+$/

/**
 * Read and validate a suite file. Relative workspaces resolve against the file's directory.
 * @param path - absolute path of the suite file.
 * @returns the suite.
 * @throws Error naming every problem found.
 */
export async function loadSuite(path: string): Promise<Suite> {
  const text = await readFile(path, 'utf8')
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new Error(`self-improve suite ${path} is not JSON`, { cause: error })
  }
  const problems: string[] = []
  const suite = await suiteOf(value, dirname(path), problems)
  if (suite === undefined || problems.length > 0) throw new Error(`self-improve suite ${path} is invalid:\n- ${problems.join('\n- ')}`)
  return suite
}

/**
 * Run a task's checks against one trial.
 * @param task - the task.
 * @param response - the trial's final response.
 * @param workspace - the trial's workspace.
 * @param run - runs command checks.
 * @param signal - cancellation.
 * @returns one result per check, in order.
 */
export async function runChecks(
  task: SuiteTask,
  response: string,
  workspace: string,
  run: CommandRunner,
  signal?: AbortSignal,
): Promise<readonly CheckResult[]> {
  const results: CheckResult[] = []
  for (const check of task.checks) {
    if ('answer' in check) {
      results.push({ check: `answer ${check.answer.source}`, passed: check.answer.test(response) })
    } else if ('file' in check) {
      results.push({ check: `file ${check.file} ${check.matches.source}`, passed: await fileMatches(workspace, check) })
    } else {
      results.push({ check: `command ${check.command.join(' ')}`, passed: await run(check.command, workspace, check.timeoutMs, signal) })
    }
  }
  return results
}

async function fileMatches(workspace: string, check: FileCheck): Promise<boolean> {
  const root = await realpath(workspace)
  const target = await realpath(resolve(root, check.file)).catch(() => undefined)
  if (target === undefined || !target.startsWith(`${root}${sep}`)) return false
  const content = await readFile(target, 'utf8').catch(() => undefined)
  return content !== undefined && check.matches.test(content)
}

async function suiteOf(value: unknown, base: string, problems: string[]): Promise<Suite | undefined> {
  if (!isRecord(value)) {
    problems.push('the suite must be a JSON object')
    return undefined
  }
  const briefs = isRecord(value['briefs']) ? value['briefs'] : {}
  if (value['briefs'] !== undefined && !isRecord(value['briefs'])) problems.push('briefs must be an object')
  const brief = (role: string): string => {
    const text = briefs[role]
    if (text === undefined) return ''
    if (typeof text !== 'string') problems.push(`briefs.${role} must be a string`)
    return typeof text === 'string' ? text : ''
  }
  const briefTexts = { analyst: brief('analyst'), proposer: brief('proposer'), critic: brief('critic') }
  const tasks = new Map<TaskId, SuiteTask>()
  const entries = Array.isArray(value['tasks']) ? value['tasks'] : []
  if (entries.length === 0) problems.push('tasks must be a non-empty array')
  for (const [index, entry] of entries.entries()) {
    const task = await taskOf(entry, `tasks[${index}]`, base, problems)
    if (task === undefined) continue
    if (tasks.has(task.id)) problems.push(`tasks[${index}].id ${task.id} repeats an earlier task`)
    tasks.set(task.id, task)
  }
  if (![...tasks.values()].some(task => task.split === 'evolve')) problems.push('at least one task must have split "evolve"')
  const smoke = stringsAt(value, 'smoke', problems).map(id => TaskId(id))
  for (const id of smoke) if (!tasks.has(id)) problems.push(`smoke names unknown task ${id}`)
  const criticPatterns: CriticPattern[] = []
  const patterns = Array.isArray(value['criticPatterns']) ? value['criticPatterns'] : []
  if (value['criticPatterns'] !== undefined && !Array.isArray(value['criticPatterns'])) problems.push('criticPatterns must be an array')
  for (const [index, entry] of patterns.entries()) {
    const at = `criticPatterns[${index}]`
    if (!isRecord(entry)) {
      problems.push(`${at} must be an object`)
      continue
    }
    const pattern = regexAt(entry, 'pattern', at, problems)
    const reason = entry['reason']
    if (typeof reason !== 'string') problems.push(`${at}.reason must be a string`)
    if (pattern !== undefined && typeof reason === 'string') criticPatterns.push({ pattern, reason })
  }
  return { briefs: briefTexts, criticPatterns, smoke, tasks }
}

async function taskOf(value: unknown, at: string, base: string, problems: string[]): Promise<SuiteTask | undefined> {
  if (!isRecord(value)) {
    problems.push(`${at} must be an object`)
    return undefined
  }
  const { id, split, prompt, workspace } = value
  const before = problems.length
  if (typeof id !== 'string' || !TASK_ID.test(id)) problems.push(`${at}.id must be letters, digits, '.', '_', or '-'`)
  if (split !== 'evolve' && split !== 'heldout') problems.push(`${at}.split must be "evolve" or "heldout"`)
  if (typeof prompt !== 'string' || prompt.trim().length === 0) problems.push(`${at}.prompt must be non-empty text`)
  const directory = workspace === undefined ? undefined : await workspaceOf(workspace, base)
  if (workspace !== undefined && directory === undefined) problems.push(`${at}.workspace must name an existing directory`)
  const checks: SuiteCheck[] = []
  const entries = Array.isArray(value['checks']) ? value['checks'] : []
  if (entries.length === 0) problems.push(`${at}.checks must be a non-empty array`)
  for (const [index, entry] of entries.entries()) {
    const check = checkOf(entry, `${at}.checks[${index}]`, problems)
    if (check !== undefined) checks.push(check)
  }
  const [first, ...rest] = checks
  if (problems.length > before || first === undefined || typeof id !== 'string' || typeof prompt !== 'string') return undefined
  return {
    id: TaskId(id),
    split: split === 'heldout' ? 'heldout' : 'evolve',
    prompt,
    ...directory === undefined ? {} : { workspace: directory },
    checks: [first, ...rest],
  }
}

/** The absolute directory a task's `workspace` names, or `undefined` when it names none. */
async function workspaceOf(workspace: unknown, base: string): Promise<string | undefined> {
  if (typeof workspace !== 'string') return undefined
  const directory = resolve(base, workspace)
  return await stat(directory).then(entry => (entry.isDirectory() ? directory : undefined), () => undefined)
}

function checkOf(value: unknown, at: string, problems: string[]): SuiteCheck | undefined {
  if (!isRecord(value)) {
    problems.push(`${at} must be an object`)
    return undefined
  }
  if ('answer' in value) {
    const answer = regexAt(value, 'answer', at, problems)
    return answer === undefined ? undefined : { answer }
  }
  if ('file' in value) {
    const file = value['file']
    const matches = regexAt(value, 'matches', at, problems)
    if (typeof file !== 'string' || file.length === 0 || isAbsolute(file)) {
      problems.push(`${at}.file must be a relative path`)
      return undefined
    }
    return matches === undefined ? undefined : { file, matches }
  }
  if ('command' in value) {
    const command: unknown = value['command']
    const parts: readonly unknown[] = Array.isArray(command) ? command : []
    const [program, ...args] = parts
    const timeoutMs = value['timeoutMs']
    if (typeof program !== 'string' || !args.every((arg): arg is string => typeof arg === 'string')) {
      problems.push(`${at}.command must be a non-empty array of strings`)
      return undefined
    }
    if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      problems.push(`${at}.timeoutMs must be a positive integer`)
      return undefined
    }
    return { command: [program, ...args], timeoutMs }
  }
  problems.push(`${at} must have one of answer, file, or command`)
  return undefined
}

function regexAt(value: Readonly<Record<string, unknown>>, key: string, at: string, problems: string[]): RegExp | undefined {
  const source = value[key]
  if (typeof source !== 'string') {
    problems.push(`${at}.${key} must be a regular expression string`)
    return undefined
  }
  try {
    return new RegExp(source)
  } catch (error) {
    problems.push(`${at}.${key} is not a valid regular expression: ${(error as Error).message}`)
    return undefined
  }
}

function stringsAt(value: Readonly<Record<string, unknown>>, key: string, problems: string[]): readonly string[] {
  const entries = value[key]
  if (entries === undefined) return []
  if (!Array.isArray(entries) || !entries.every((entry): entry is string => typeof entry === 'string')) {
    problems.push(`${key} must be an array of strings`)
    return []
  }
  return entries
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
