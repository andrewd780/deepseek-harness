/**
 * The analyst and the proposer over a text model. The analyst writes one
 * report per round from the incumbent's evidence; the proposer edits the
 * evolved directory of one candidate checkout through a JSON action protocol,
 * one action per model request, and finishes by declaring its edits.
 *
 * @module @deepseek-ai/dsh-experimental-self-improve/roles
 */

import { lstat, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { taskMean } from './evaluate.ts'
import type { CandidateEdit } from './selection.ts'
import type { AnalysisRequest, Analyst, Proposal, ProposalRequest, Proposer, TextModel } from './types.ts'

/** Settings of the proposer's action loop. */
export interface ProposerSettings {
  readonly model: TextModel
  /** Model requests one draft may make before it fails. */
  readonly maxTurns: number
  /** Longest file, listing, or trace returned to the model by one action. */
  readonly maxReadCharacters: number
  /** File extensions `write_file` may create. */
  readonly writableExtensions: readonly string[]
}

const ACTION_ECHO_CHARACTERS = 1_500
const RESULT_CHARACTERS = 4_000

/**
 * An analyst that asks the model once per round.
 * @param model - the text model.
 * @returns the analyst.
 */
export function createAnalyst(model: TextModel): Analyst {
  return {
    async analyze(request: AnalysisRequest): Promise<string> {
      const system = analystSystemPrompt(request.briefs.analyst)
      return await model.complete({ system, prompt: analystPrompt(request), signal: request.signal })
    },
  }
}

/**
 * The model-facing system text of the analyst.
 * @param brief - the domain's paragraph for the analyst.
 * @returns the system text.
 */
export function analystSystemPrompt(brief: string): string {
  return [
    'You analyze how an agent harness performs on a task suite, so that another engineer can change the harness. The model that runs the harness is fixed; only the harness can change.',
    brief,
    'From the trajectories, report three things in plain text:',
    '1. Failure modes: recurring ways the weak trajectories go wrong, ranked by how many tasks they affect, each with the tasks that show it and the moment in the trajectory where it starts.',
    '2. Capability gaps: what the harness never gives the model (a tool, a piece of context, a check) that the failures needed.',
    '3. Success habits: behaviors in the strong trajectories that a change must not break.',
    'Name general mechanisms, never task-specific answers. When a previous report is given, keep its names for findings that recur.',
  ].filter(paragraph => paragraph.length > 0).join('\n\n')
}

/**
 * The model-facing analysis request.
 * @param request - the evidence, the incumbent, and the previous report.
 * @returns the prompt.
 */
export function analystPrompt(request: AnalysisRequest): string {
  return [
    `Round ${request.round}. Incumbent score ${request.incumbent.score.toFixed(4)} over ${request.incumbent.perTask.size} task(s).`,
    request.previous.length > 0 ? `Previous report:\n${request.previous}` : 'There is no previous report.',
    ...request.evidence.map(trace => `=== ${trace.kind} trial: task ${trace.task}, trial ${trace.trial}, reward ${trace.reward} ===\n${trace.text}`),
  ].join('\n\n')
}

/**
 * A proposer that edits the checkout's evolved directory through a JSON action protocol.
 * @param settings - the model and the loop's limits.
 * @returns the proposer.
 */
export function createProposer(settings: ProposerSettings): Proposer {
  return {
    async propose(request: ProposalRequest): Promise<Proposal> {
      return await new ProposerSession(settings, request).run()
    },
  }
}

/**
 * The model-facing system text of the proposer.
 * @param brief - the domain's paragraph for the proposer.
 * @param components - the component set.
 * @returns the system text.
 */
export function proposerSystemPrompt(brief: string, components: readonly string[]): string {
  return [
    'You improve an agent harness by editing its configuration files in your working directory. The model that runs the harness is fixed and differs from you: improve the harness for that model, using its trajectories as evidence of how it behaves. Only the files in your working directory can change; the tasks, the grader, and the model cannot.',
    brief,
    [
      'Reply with exactly one JSON object per turn and nothing else. Actions:',
      '{"action": "list_files"}',
      '{"action": "read_file", "path": "relative/path"}',
      '{"action": "read_trace", "task": "<task id from the evidence list>"}',
      '{"action": "edit_file", "path": "relative/path", "old": "exact text that occurs once", "new": "replacement"}',
      '{"action": "write_file", "path": "relative/path", "content": "complete content of a new file"}',
      `{"action": "done", "summary": "one line", "edits": [{"id": "E1", "component": "one of: ${components.join(', ')}", "hypothesis": "one sentence: the mechanism and why it should raise the score"}]}`,
    ].join('\n'),
    'An edit is one independent change whose effect can be measured on its own; parts that only work together are one edit. Declare at most the edit budget the context gives. Name each edit\'s component from the list; it is checked against your changes. A candidate holding a reserved exploration slot must change at least one of the untried components it lists. Removing machinery listed under the prune set is a legitimate edit.',
    'Never encode task names, task-specific values, or expected answers: the harness is scored on these tasks, and a reviewer rejects such changes before they are measured. There is no abort action: make the best change you can, then call done.',
  ].filter(paragraph => paragraph.length > 0).join('\n\n')
}

type Action = Readonly<Record<string, unknown>>

/** One draft: the model's turns, the interaction log, and the file changes made. */
class ProposerSession {
  private transcript = ''
  private changes = 0
  private root = ''

  constructor(private readonly settings: ProposerSettings, private readonly request: ProposalRequest) {}

  async run(): Promise<Proposal> {
    this.root = await realpath(this.request.checkout.evolvedDirectory)
    const system = proposerSystemPrompt(this.request.briefs.proposer, this.request.componentSet.names)
    const context = await this.context()
    for (let turn = 0; turn < this.settings.maxTurns; turn += 1) {
      const answer = await this.settings.model.complete({
        system,
        prompt: `${context}\n\n=== Interaction log ===${this.transcript}\n\nReply with exactly one JSON action object.`,
        signal: this.request.signal,
      })
      const action = parseAction(answer)
      if (action === undefined) {
        this.record(answer.slice(0, ACTION_ECHO_CHARACTERS), 'ERROR: reply with exactly one JSON object')
        continue
      }
      if (action['action'] === 'done') {
        const finished = this.finish(action)
        if (finished !== undefined) return { ...finished, transcript: this.transcript }
        continue
      }
      const result = await this.act(action)
      this.record(JSON.stringify(action).slice(0, ACTION_ECHO_CHARACTERS), result)
    }
    return { status: 'failed', summary: `no candidate after ${this.settings.maxTurns} model request(s)`, edits: [], transcript: this.transcript }
  }

  private record(action: string, result: string): void {
    this.transcript += `\n[action] ${action}\n[result] ${result}`
  }

  private finish(action: Action): Omit<Proposal, 'transcript'> | undefined {
    const edits = editsOf(action['edits'])
    const summary = typeof action['summary'] === 'string' ? action['summary'] : ''
    const problems: string[] = []
    if (this.changes === 0) problems.push('no file was changed; change files with edit_file or write_file first')
    if (edits === undefined || edits.length === 0) problems.push('edits must list at least one {id, component, hypothesis}')
    else {
      if (edits.length > this.request.budget) problems.push(`${edits.length} edits exceed this round's budget of ${this.request.budget}`)
      const unknown = edits.filter(edit => !this.request.componentSet.names.includes(edit.component))
      if (unknown.length > 0) problems.push(`unknown component(s): ${unknown.map(edit => edit.component).join(', ')}`)
      const untried = this.request.exploration.untried
      if (this.request.reserved && !edits.some(edit => untried.includes(edit.component))) {
        problems.push(`this candidate holds a reserved exploration slot: change at least one of ${untried.join(', ')}`)
      }
    }
    if (problems.length > 0 || edits === undefined) {
      this.record('done', `ERROR: ${problems.join('; ')}. Fix this and call done again.`)
      return undefined
    }
    return { status: 'done', summary, edits }
  }

  private async act(action: Action): Promise<string> {
    try {
      switch (action['action']) {
        case 'list_files':
          return capped(await this.listFiles(), this.settings.maxReadCharacters)
        case 'read_file':
          return capped(await readFile(await this.path(action['path']), 'utf8'), this.settings.maxReadCharacters)
        case 'read_trace': {
          const trace = this.request.evidence.find(entry => entry.task === action['task'])
          return trace === undefined ? `ERROR: no evidence trial for task ${String(action['task'])}` : capped(trace.text, this.settings.maxReadCharacters)
        }
        case 'edit_file':
          return capped(await this.edit(action), RESULT_CHARACTERS)
        case 'write_file':
          return capped(await this.write(action), RESULT_CHARACTERS)
        default:
          return `ERROR: unknown action ${JSON.stringify(action['action'])}`
      }
    } catch (error) {
      this.request.signal?.throwIfAborted()
      // Every failure here is a filesystem or validation Error.
      return capped(`ERROR: ${(error as Error).message}`, RESULT_CHARACTERS)
    }
  }

  private async edit(action: Action): Promise<string> {
    const { old, new: replacement } = action
    if (typeof old !== 'string' || typeof replacement !== 'string' || old.length === 0) return 'ERROR: old and new must be strings, old not empty'
    const path = await this.path(action['path'])
    const content = await readFile(path, 'utf8')
    const occurrences = content.split(old).length - 1
    if (occurrences !== 1) return `ERROR: old text occurs ${occurrences} times; it must occur exactly once`
    await writeFile(path, content.replace(old, () => replacement))
    this.changes += 1
    return `OK: edited ${relative(this.root, path)}`
  }

  private async write(action: Action): Promise<string> {
    const content = action['content']
    if (typeof content !== 'string') return 'ERROR: content must be a string'
    const path = await this.path(action['path'])
    if (!this.settings.writableExtensions.includes(extname(path))) {
      return `ERROR: write_file creates only ${this.settings.writableExtensions.join(', ')} files`
    }
    await mkdir(dirname(path), { recursive: true })
    await this.contain(dirname(path))
    await writeFile(path, content, { flag: 'wx' })
    this.changes += 1
    return `OK: created ${relative(this.root, path)}`
  }

  private async listFiles(): Promise<string> {
    const entries = await readdir(this.root, { recursive: true, withFileTypes: true })
    const files = entries.filter(entry => entry.isFile()).map(entry => relative(this.root, join(entry.parentPath, entry.name))).sort()
    return files.length === 0 ? '(no files)' : files.join('\n')
  }

  /** A model-supplied path inside the evolved directory; symbolic links may not lead out of it. */
  private async path(value: unknown): Promise<string> {
    if (typeof value !== 'string' || value.length === 0 || isAbsolute(value)) throw new Error('path must be a relative path')
    const path = resolve(this.root, value)
    if (!inside(this.root, path)) throw new Error(`${value} is outside the working directory`)
    const parent = await existingAncestor(dirname(path))
    await this.contain(parent)
    if ((await lstat(path).catch(() => undefined))?.isSymbolicLink() === true) throw new Error(`${value} is a symbolic link`)
    return path
  }

  private async contain(directory: string): Promise<void> {
    if (!inside(this.root, await realpath(directory))) throw new Error(`${relative(this.root, directory)} leads outside the working directory`)
  }

  private async context(): Promise<string> {
    const { request } = this
    const perTask = [...request.incumbent.perTask].map(([task, result]) => `${task}: ${taskMean(result).toFixed(3)}`).join('\n')
    return [
      `=== Variant ===\nYou draft candidate ${request.variant} of round ${request.round + 1} of ${request.rounds}. ${request.variants} candidate(s) are drafted independently from the same incumbent this round; each is measured on the whole task suite, and the best admissible one becomes the next incumbent.`,
      `=== Edit budget ===\nDeclare at most ${request.budget} edit(s). The budget shrinks over the run: early rounds may bundle coordinated changes, late rounds make single changes whose effect can be attributed.`,
      `=== Exploration ===\n${request.exploration.directive}${request.reserved ? `\nThis candidate holds a reserved exploration slot: at least one edit must change one of ${request.exploration.untried.join(', ')}.` : ''}`,
      `=== Prune set (components whose recent edits gained nothing, with the accepted machinery you may remove) ===\n${JSON.stringify(request.prune, undefined, 1)}`,
      `=== Edit history (measured outcomes; a rejected mechanism is evidence against redrawing it unchanged) ===\n${JSON.stringify(request.history, undefined, 1)}`,
      `=== Analysis of the incumbent ===\n${request.analysis}`,
      `=== Incumbent mean reward per task ===\n${perTask}`,
      `=== Evidence trials (read with read_trace) ===\n${request.evidence.map(trace => `${trace.task} (${trace.kind}, reward ${trace.reward})`).join('\n')}`,
      `=== Files ===\n${capped(await this.listFiles(), this.settings.maxReadCharacters)}`,
      ...request.repair === undefined ? [] : [`=== Rejected draft ===\nThe reviewer rejected your previous draft of this candidate. Reasons: ${request.repair.reasons.join('; ')}. Risk notes: ${request.repair.riskNotes.join('; ') || 'none'}. Your declared edits were: ${JSON.stringify(request.repair.declared)}. The files still hold that draft: revise them, then call done again.`],
    ].join('\n\n')
  }
}

function parseAction(text: string): Action | undefined {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end < start) return undefined
  let value: unknown
  try {
    value = JSON.parse(text.slice(start, end + 1))
  } catch (error) {
    // A SyntaxError means the reply is not one JSON object; the caller asks again.
    void error
    return undefined
  }
  // A span from `{` to `}` that parses is a JSON object.
  return value as Action
}

function editsOf(value: unknown): readonly CandidateEdit[] | undefined {
  if (!Array.isArray(value)) return undefined
  const edits: CandidateEdit[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) return undefined
    const { id, component, hypothesis } = entry as Readonly<Record<string, unknown>>
    if (typeof id !== 'string' || typeof component !== 'string' || typeof hypothesis !== 'string') return undefined
    edits.push({ id, component: component.trim().toLowerCase(), hypothesis })
  }
  return edits
}

function capped(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n...[${text.length - limit} more characters]`
}

function inside(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`)
}

async function existingAncestor(path: string): Promise<string> {
  for (let current = path; ; current = dirname(current)) {
    if (await lstat(current).then(() => true, () => false)) return current
  }
}
