/**
 * The starter run the automatic mode creates on first use: a run spec, a
 * suite of small Node.js coding tasks with their starting files, the frozen
 * policy patch that routes every trial to one OpenAI-compatible endpoint, and
 * the seed of the evolved directory. The files are kept in source so the
 * bundled plugin carries them; no solution is part of the run.
 *
 * Every check is an inline Node script run in the trial's workspace, so a
 * trial cannot edit its own grader. Checks import the workspace's modules,
 * run its tests with `node --test`, and compare files the task must not
 * change with their starting contents.
 *
 * @module @deepseek-ai/dsh-experimental-self-improve/template
 */

/** The route and constants a starter run is created with. */
export interface StarterRoute {
  /** Provider key of the trials' and the search roles' route. */
  readonly provider: string
  readonly model: string
  /** OpenAI-compatible base URL the trials' policy patch routes to. */
  readonly baseUrl: string
  /** Context window the trials' route declares. */
  readonly contextWindow: number
  /** Rounds of one run. */
  readonly rounds: number
}

/** One check of a starter task: an inline Node module that exits 0 when the check passes. */
interface StarterCheck {
  readonly script: string
}

/** One task of the starter suite. */
export interface StarterTask {
  readonly id: string
  readonly split: 'evolve' | 'heldout'
  readonly prompt: string
  /** The task's starting workspace, keyed by relative path. */
  readonly files: Readonly<Record<string, string>>
  readonly checks: readonly StarterCheck[]
}

/** Deadline of one starter check. */
const CHECK_TIMEOUT_MS = 60_000

/** Helpers every check script starts with. */
const PRELUDE = `import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
const fail = (message) => { console.error(message); process.exit(1) }
const read = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : fail(\`missing \${path}\`))
const load = async (path) => await import(pathToFileURL(resolve(path)).href)
const same = (path, expected) => { if (read(path).trim() !== expected.trim()) fail(\`\${path} changed\`) }
const nodeTest = (cwd, files = []) => spawnSync(process.execPath, ['--test', ...files], { cwd, encoding: 'utf8', timeout: 50000 }).status === 0
const withCopy = (mutate, action) => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-check-'))
  try {
    cpSync('.', directory, { recursive: true })
    mutate(directory)
    return action(directory)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
const equal = (actual, expected, label) => { if (!isDeepStrictEqual(actual, expected)) fail(\`\${label} is \${JSON.stringify(actual)}, expected \${JSON.stringify(expected)}\`) }
`

const MODULE_PACKAGE = '{\n  "private": true,\n  "type": "module"\n}\n'

/** A JavaScript string literal holding `text`. */
const literal = (text: string): string => JSON.stringify(text)

const RANGE = `/** Integers from \`start\` to \`end\`, both included; empty when \`end\` is less than \`start\`. */
export function range(start, end) {
  const result = []
  for (let value = start; value < end; value += 1) result.push(value)
  return result
}
`

const RANGE_TEST = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { range } from '../src/range.mjs'

test('includes both ends', () => {
  assert.deepEqual(range(1, 4), [1, 2, 3, 4])
})

test('a single value', () => {
  assert.deepEqual(range(5, 5), [5])
})

test('empty when the end comes first', () => {
  assert.deepEqual(range(3, 1), [])
})
`

const DURATION = `/**
 * Seconds in a duration written as hours, minutes, and seconds, such as
 * \`1h30m\`, \`45s\`, or \`2h5m10s\`. Throws on any other text.
 */
export function parseDuration(text) {
  const match = /^(?:(\\d+)h)?(?:(\\d+)m)?(?:(\\d+)s)?$/.exec(text)
  if (match === null || text === '') throw new Error(\`not a duration: \${text}\`)
  const [, hours = '0', minutes = '0', seconds = '0'] = match
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds)
}
`

const INVOICE = `export function lineTotal(item) {
  const cents = item.quantity * item.unitCents
  return '$' + (cents / 100).toFixed(2)
}

export function subtotal(items) {
  const cents = items.reduce((sum, item) => sum + item.quantity * item.unitCents, 0)
  return '$' + (cents / 100).toFixed(2)
}

export function tax(items, rate) {
  const cents = Math.round(items.reduce((sum, item) => sum + item.quantity * item.unitCents, 0) * rate)
  return '$' + (cents / 100).toFixed(2)
}
`

const INVOICE_TEST = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lineTotal, subtotal, tax } from '../src/invoice.mjs'

const items = [{ quantity: 2, unitCents: 1250 }, { quantity: 1, unitCents: 99 }]

test('line total', () => {
  assert.equal(lineTotal(items[0]), '$25.00')
})

test('subtotal', () => {
  assert.equal(subtotal(items), '$25.99')
})

test('tax', () => {
  assert.equal(tax(items, 0.1), '$2.60')
})
`

const CONTRIBUTING = `# Contributing

## Changelog entries

Each user-visible change adds one entry to CHANGELOG.md, as the first line under the \`## Unreleased\` heading.

An entry is one line of this form:

    - <Kind>: <What changed, as one sentence in the present tense.> (#<pull request number>)

\`<Kind>\` is one of Added, Changed, Fixed, or Removed. The sentence starts with a capital letter and ends with a period, and the pull request number follows it in parentheses. Do not edit other entries.
`

const CHANGELOG = `# Changelog

## Unreleased

- Fixed: The build command no longer stops when the output directory is missing. (#479)

## 1.4.0

- Added: The build command accepts --watch to rebuild on changes. (#455)
- Changed: Progress output goes to standard error. (#451)
`

const APP_JSON = `{
  "host": "localhost",
  "port": 8080,
}
`

const START = `import { readFileSync } from 'node:fs'

const config = JSON.parse(readFileSync(new URL('../config/app.json', import.meta.url), 'utf8'))
console.log(\`listening on \${config.host}:\${config.port}\`)
`

const WRAP = `/**
 * Wrap \`text\` into lines of at most \`width\` characters, breaking only at
 * spaces. Words are separated by single spaces in the result, and a word
 * longer than \`width\` stays whole on a line of its own. Returns the lines
 * joined with "\\n"; text without words returns "".
 */
export function wrap(text, width) {
  throw new Error('not implemented')
}
`

const WRAP_TEST = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { wrap } from '../src/wrap.mjs'

test('breaks at spaces', () => {
  assert.equal(wrap('the quick brown fox', 10), 'the quick\\nbrown fox')
})

test('keeps a short text on one line', () => {
  assert.equal(wrap('hello', 10), 'hello')
})
`

const LEADERBOARD = `/** The \`count\` entries with the highest scores, highest first; entries with equal scores keep their order. */
export function topScores(entries, count) {
  return [...entries].sort((left, right) => String(right.score).localeCompare(String(left.score))).slice(0, count)
}
`

const LEADERBOARD_TEST = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { topScores } from '../src/leaderboard.mjs'

test('highest first', () => {
  const entries = [{ name: 'ada', score: 3 }, { name: 'bo', score: 7 }, { name: 'cy', score: 5 }]
  assert.deepEqual(topScores(entries, 2).map(entry => entry.name), ['bo', 'cy'])
})
`

const STYLE = `# Documentation style

Each command-line option has its own section under \`## Options\` in README.md, and the sections are in alphabetical order of the option name.

A section starts with a level-3 heading that holds only the option name in backticks, as the existing sections do. One paragraph follows that says what the option does, then one example in a fenced code block marked \`sh\`.
`

const TIDY_README = `# tidy

tidy formats the files you name.

## Usage

\`\`\`sh
tidy [options] <file...>
\`\`\`

## Options

### \`--check\`

Reports the files tidy would change, and changes nothing.

\`\`\`sh
tidy --check src/*.js
\`\`\`

### \`--write\`

Rewrites each file in place.

\`\`\`sh
tidy --write src/*.js
\`\`\`
`

/** The starter suite: six evolve tasks and two held-out tasks. */
export const STARTER_TASKS: readonly StarterTask[] = [
  {
    id: 'range-bug',
    split: 'evolve',
    prompt: 'The tests of this project fail. Find the bug in src/range.mjs and fix it, so that `node --test` passes. Do not change the tests.',
    files: { 'package.json': MODULE_PACKAGE, 'src/range.mjs': RANGE, 'test/range.test.mjs': RANGE_TEST },
    checks: [
      {
        script: `const { range } = await load('src/range.mjs')
for (const [start, end, expected] of [[1, 4, [1, 2, 3, 4]], [5, 5, [5]], [3, 1, []], [-2, 0, [-2, -1, 0]]]) equal(range(start, end), expected, \`range(\${start}, \${end})\`)`,
      },
      { script: `same('test/range.test.mjs', ${literal(RANGE_TEST)})\nif (!nodeTest('.')) fail('node --test fails')` },
    ],
  },
  {
    id: 'duration-tests',
    split: 'evolve',
    prompt: 'src/duration.mjs has no tests. Add test/duration.test.mjs, using node:test and node:assert, that checks parseDuration with a value that has hours, minutes, and seconds, a value with one unit, and text that must throw. Run the tests with `node --test` before you finish, and do not change src/duration.mjs.',
    files: { 'package.json': MODULE_PACKAGE, 'src/duration.mjs': DURATION },
    checks: [
      { script: `same('src/duration.mjs', ${literal(DURATION)})\nif (!nodeTest('.', ['test/duration.test.mjs'])) fail('the tests fail or are missing')` },
      ...[
        ['Number(minutes) * 60', 'Number(minutes) * 0'],
        ['Number(hours) * 3600', 'Number(hours) * 60'],
        ['throw new Error(`not a duration: ${text}`)', 'return 0'],
      ].map(([from = '', to = '']) => ({
        script: `const original = ${literal(DURATION)}
const mutant = original.replace(${literal(from)}, ${literal(to)})
if (mutant === original) fail('the mutant did not apply')
if (!nodeTest('.', ['test/duration.test.mjs'])) fail('the tests fail or are missing')
const caught = withCopy(directory => writeFileSync(join(directory, 'src/duration.mjs'), mutant), directory => !nodeTest(directory, ['test/duration.test.mjs']))
if (!caught) fail('the tests still pass when parseDuration is broken')`,
      })),
    ],
  },
  {
    id: 'invoice-refactor',
    split: 'evolve',
    prompt: 'src/invoice.mjs repeats the same money formatting in three functions. Refactor it: export a new function formatCents(cents) that formats an amount in cents as dollars, such as $12.50, and use it in lineTotal, subtotal, and tax. The behavior must stay the same, and `node --test` must still pass without changing the tests.',
    files: { 'package.json': MODULE_PACKAGE, 'src/invoice.mjs': INVOICE, 'test/invoice.test.mjs': INVOICE_TEST },
    checks: [
      {
        script: `const invoice = await load('src/invoice.mjs')
const items = [{ quantity: 3, unitCents: 250 }, { quantity: 1, unitCents: 1999 }, { quantity: 2, unitCents: 5 }]
equal(invoice.lineTotal(items[0]), '$7.50', 'lineTotal')
equal(invoice.lineTotal(items[2]), '$0.10', 'lineTotal')
equal(invoice.subtotal(items), '$27.59', 'subtotal')
equal(invoice.subtotal([]), '$0.00', 'an empty subtotal')
equal(invoice.tax(items, 0.08), '$2.21', 'tax')`,
      },
      {
        script: `const { formatCents } = await load('src/invoice.mjs')
if (typeof formatCents !== 'function') fail('formatCents is not exported')
for (const [cents, text] of [[1250, '$12.50'], [0, '$0.00'], [7, '$0.07'], [123456, '$1234.56']]) equal(formatCents(cents), text, \`formatCents(\${cents})\`)`,
      },
      {
        script: `const source = read('src/invoice.mjs')
const calls = source.split('formatCents(').length - 1 - (source.split('function formatCents(').length - 1)
if (calls < 3) fail(\`formatCents is called \${calls} time(s); lineTotal, subtotal, and tax must use it\`)
if (source.split('toFixed').length - 1 > 1) fail('the money formatting still appears more than once')`,
      },
      { script: `same('test/invoice.test.mjs', ${literal(INVOICE_TEST)})\nif (!nodeTest('.')) fail('node --test fails')` },
    ],
  },
  {
    id: 'changelog-entry',
    split: 'evolve',
    prompt: 'Pull request #482 adds a --quiet option to the build command that hides progress output. Record it in the changelog, following the rules in CONTRIBUTING.md.',
    files: { 'CONTRIBUTING.md': CONTRIBUTING, 'CHANGELOG.md': CHANGELOG },
    checks: [
      {
        script: `const lines = read('CHANGELOG.md').split('\\n')
const start = lines.indexOf('## Unreleased')
if (start < 0) fail('CHANGELOG.md has no Unreleased heading')
const entries = []
for (const line of lines.slice(start + 1)) {
  if (line.startsWith('## ')) break
  if (line.trim() !== '') entries.push(line)
}
const first = entries[0] ?? ''
if (!/^- (?:Added|Changed): [A-Z].*\\. \\(#482\\)$/.test(first)) fail(\`the first Unreleased entry is \${JSON.stringify(first)}\`)
if (!first.includes('--quiet')) fail('the entry does not name --quiet')`,
      },
      {
        script: `const kept = (text) => text.split('\\n').filter(line => line.trim() !== '' && !line.includes('(#482)'))
equal(kept(read('CHANGELOG.md')), kept(${literal(CHANGELOG)}), 'the other changelog lines')`,
      },
    ],
  },
  {
    id: 'config-crash',
    split: 'evolve',
    prompt: 'Running `node src/start.mjs` crashes. Find the cause and fix it without changing any file under src/. When it works, it prints the address it would listen on.',
    files: { 'package.json': MODULE_PACKAGE, 'config/app.json': APP_JSON, 'src/start.mjs': START },
    checks: [
      {
        script: `const run = spawnSync(process.execPath, ['src/start.mjs'], { encoding: 'utf8', timeout: 20000 })
if (run.status !== 0) fail(\`node src/start.mjs exits \${run.status}: \${run.stderr}\`)
equal(run.stdout.trim(), 'listening on localhost:8080', 'the output')`,
      },
      { script: `same('src/start.mjs', ${literal(START)})` },
    ],
  },
  {
    id: 'wrap-implement',
    split: 'evolve',
    prompt: 'Implement wrap in src/wrap.mjs as its comment describes, and make `node --test` pass without changing the tests.',
    files: { 'package.json': MODULE_PACKAGE, 'src/wrap.mjs': WRAP, 'test/wrap.test.mjs': WRAP_TEST },
    checks: [
      {
        script: `const { wrap } = await load('src/wrap.mjs')
const cases = [
  ['the quick brown fox', 10, 'the quick\\nbrown fox'],
  ['a b c d e f', 3, 'a b\\nc d\\ne f'],
  ['extraordinarily long word here', 8, 'extraordinarily\\nlong\\nword\\nhere'],
  ['  spaced   out  ', 20, 'spaced out'],
  ['', 5, ''],
  ['exactly ten', 11, 'exactly ten'],
]
for (const [text, width, expected] of cases) equal(wrap(text, width), expected, \`wrap(\${JSON.stringify(text)}, \${width})\`)`,
      },
      { script: `same('test/wrap.test.mjs', ${literal(WRAP_TEST)})\nif (!nodeTest('.')) fail('node --test fails')` },
    ],
  },
  {
    id: 'leaderboard-bug',
    split: 'heldout',
    prompt: 'topScores in src/leaderboard.mjs sometimes returns players in the wrong order. Fix it, and add a test to test/leaderboard.test.mjs that fails on the old code and passes on the fixed one. Run `node --test` before you finish.',
    files: { 'package.json': MODULE_PACKAGE, 'src/leaderboard.mjs': LEADERBOARD, 'test/leaderboard.test.mjs': LEADERBOARD_TEST },
    checks: [
      {
        script: `const { topScores } = await load('src/leaderboard.mjs')
const entries = [{ name: 'ada', score: 9 }, { name: 'bo', score: 100 }, { name: 'cy', score: 20 }, { name: 'di', score: 100 }]
equal(topScores(entries, 3).map(entry => entry.name), ['bo', 'di', 'cy'], 'topScores(entries, 3)')
equal(topScores(entries, 10).map(entry => entry.name), ['bo', 'di', 'cy', 'ada'], 'topScores(entries, 10)')`,
      },
      {
        script: `if (!nodeTest('.')) fail('node --test fails')
const caught = withCopy(directory => writeFileSync(join(directory, 'src/leaderboard.mjs'), ${literal(LEADERBOARD)}), directory => !nodeTest(directory))
if (!caught) fail('the tests still pass on the old topScores')`,
      },
    ],
  },
  {
    id: 'readme-option',
    split: 'heldout',
    prompt: 'tidy now has a --dry-run option that prints the formatted output instead of writing it. Document it in README.md, following docs/STYLE.md.',
    files: { 'docs/STYLE.md': STYLE, 'README.md': TIDY_README },
    checks: [
      {
        script: `const lines = read('README.md').split('\\n')
const options = lines.indexOf('## Options')
if (options < 0) fail('README.md has no Options section')
const headings = lines.slice(options + 1).filter(line => line.startsWith('### '))
equal(headings, ['### \`--check\`', '### \`--dry-run\`', '### \`--write\`'], 'the option headings')
const start = lines.indexOf('### \`--dry-run\`')
const end = lines.indexOf('### \`--write\`')
const body = lines.slice(start + 1, end).filter(line => line.trim() !== '')
if (body.length < 4 || body[0].startsWith('\`\`\`')) fail('the --dry-run section has no paragraph before its example')
const fence = body.indexOf('\`\`\`sh')
if (fence < 1 || !body[fence + 1]?.includes('--dry-run') || body.at(-1) !== '\`\`\`') fail('the --dry-run section does not end with one sh example that uses --dry-run')`,
      },
      {
        script: `const text = read('README.md')
const start = text.indexOf('### \`--dry-run\`')
const end = text.indexOf('### \`--write\`')
const rest = start < 0 || end < start ? text : text.slice(0, start) + text.slice(end)
equal(rest.trim(), ${literal(TIDY_README)}.trim(), 'README.md outside the --dry-run section')`,
      },
    ],
  },
]

const STARTER_AGENTS = 'Work carefully. Check your result before you answer.\n'

const STARTER_README = `# dsh self-improve automatic run

\`/self-improve\` created this repository for its automatic mode and never overwrites it. It holds:

- \`run.json\`: the run spec; \`run-<n>.json\` files are later generations, each starting from the previous one's result.
- \`suite.json\` and \`tasks/\`: the starter tasks and their starting files; \`evolve\` tasks drive the search, \`heldout\` tasks only report.
- \`policy.patch.yml\`: the frozen route and sandbox of every trial.
- \`evolved/\`: the configuration the run improves; accepted candidates are commits on the \`self-improve/<name>\` branches.

Run state lives under \`.agents/self-improve/\`, which git ignores. Edit the suite or the spec, then commit, to change what the next generation measures.
`

/**
 * The files of a starter run, keyed by path relative to its repository root.
 * @param route - the route and constants the run is created with.
 * @returns every file of the run, contents included.
 */
export function starterFiles(route: StarterRoute): ReadonlyMap<string, string> {
  const files = new Map<string, string>()
  files.set('README.md', STARTER_README)
  files.set('evolved/AGENTS.md', STARTER_AGENTS)
  files.set('policy.patch.yml', policyPatch(route))
  files.set('run.json', `${JSON.stringify(runSpec(route), undefined, 2)}\n`)
  files.set('suite.json', `${JSON.stringify(suite(), undefined, 2)}\n`)
  for (const task of STARTER_TASKS) {
    for (const [path, content] of Object.entries(task.files)) files.set(`tasks/${task.id}/${path}`, content)
  }
  return files
}

/**
 * The command that runs one inline check script.
 * @param script - the check's body, after the shared helpers.
 * @returns the argv of the check's `command`.
 */
export function checkCommand(script: string): readonly [string, ...string[]] {
  return ['node', '--input-type=module', '-e', `${PRELUDE}${script}\n`]
}

function suite(): Record<string, unknown> {
  return {
    briefs: {
      analyst: 'Tasks are small Node.js coding exercises (fix a bug, add a test, refactor without changing behavior, follow a project\'s written rules) worked by a local model with a 32k-token context window. Checks import the task\'s modules, run its tests with node --test, and compare files the task must not change.',
      proposer: 'The policy model works with a 32k-token context window, so every instruction costs it room: prefer short, general working habits, such as reading the project\'s rules and tests before editing and running the tests before finishing, over long text.',
      critic: 'Tasks are small Node.js coding exercises. Reject an edit that names a task, its files, functions, or option names, or its expected output.',
    },
    criticPatterns: [{
      pattern: 'range\\.mjs|duration\\.mjs|invoice\\.mjs|start\\.mjs|wrap\\.mjs|leaderboard\\.mjs|app\\.json|STYLE\\.md|formatCents|parseDuration|topScores|--quiet|--dry-run|#482',
      reason: 'names a starter task\'s file, function, or expected content',
    }],
    tasks: STARTER_TASKS.map(task => ({
      id: task.id,
      split: task.split,
      prompt: task.prompt,
      workspace: `tasks/${task.id}`,
      checks: task.checks.map(check => ({ command: checkCommand(check.script), timeoutMs: CHECK_TIMEOUT_MS })),
    })),
  }
}

function runSpec(route: StarterRoute): Record<string, unknown> {
  return {
    name: 'auto',
    suite: 'suite.json',
    evolvedDirectory: 'evolved',
    trial: {
      policyPatches: ['policy.patch.yml'],
      provider: route.provider,
      model: route.model,
      env: { OLLAMA_API_KEY: 'ollama' },
      concurrency: 1,
      maxTraceCharacters: 400,
    },
    roles: {
      provider: route.provider,
      model: route.model,
      maxOutputTokens: 4096,
      maxReadCharacters: 20_000,
      maxDiffCharacters: 20_000,
      maxHistoryDiffCharacters: 4000,
      proposerTurns: 12,
    },
    delta: 'calibrate',
    calibration: { method: 'spread' },
    historyLimit: 8,
    failureTraces: 3,
    successTraces: 1,
    rounds: route.rounds,
    variants: 1,
    trials: 1,
    repairRounds: 1,
  }
}

function policyPatch(route: StarterRoute): string {
  return `# Frozen policy of the automatic run's trials, applied after each candidate's
# overlay. Each trial starts with a fresh Harness home, so this route is the
# only one a trial sees. The sandbox stays at workspace-write whatever a
# candidate does: a trial's tools write only inside its own workspace and the
# temporary area. Reads and network access are not confined.
- id: sandbox-policy
  config:
    mode: workspace-write

- id: llm-pi-ai
  config:
    providers:
      ${JSON.stringify(route.provider)}:
        api: openai-completions
        baseURL: ${JSON.stringify(route.baseUrl)}
        apiKeyEnv: OLLAMA_API_KEY
        defaultContextWindow: ${route.contextWindow}
        defaultMaxTokens: 8192
        timeoutMs: 900000
        streamIdleTimeoutMs: 300000
        compat:
          supportsDeveloperRole: false
          maxTokensField: max_tokens
        models:
          - id: ${JSON.stringify(route.model)}
`
}
