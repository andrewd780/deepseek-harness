/** One correct solution per starter task: the files a solving trial leaves, keyed by path relative to the workspace. */
export const STARTER_SOLUTIONS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'range-bug': {
    'src/range.mjs': `/** Integers from \`start\` to \`end\`, both included; empty when \`end\` is less than \`start\`. */
export function range(start, end) {
  const result = []
  for (let value = start; value <= end; value += 1) result.push(value)
  return result
}
`,
  },
  'duration-tests': {
    'test/duration.test.mjs': `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseDuration } from '../src/duration.mjs'

test('hours, minutes, and seconds', () => {
  assert.equal(parseDuration('2h5m10s'), 7510)
})

test('one unit', () => {
  assert.equal(parseDuration('45s'), 45)
})

test('other text throws', () => {
  assert.throws(() => parseDuration('soon'))
})
`,
  },
  'invoice-refactor': {
    'src/invoice.mjs': `export function formatCents(cents) {
  return '$' + (cents / 100).toFixed(2)
}

const totalCents = (items) => items.reduce((sum, item) => sum + item.quantity * item.unitCents, 0)

export function lineTotal(item) {
  return formatCents(item.quantity * item.unitCents)
}

export function subtotal(items) {
  return formatCents(totalCents(items))
}

export function tax(items, rate) {
  return formatCents(Math.round(totalCents(items) * rate))
}
`,
  },
  'changelog-entry': {
    'CHANGELOG.md': `# Changelog

## Unreleased

- Added: The build command accepts --quiet to hide progress output. (#482)
- Fixed: The build command no longer stops when the output directory is missing. (#479)

## 1.4.0

- Added: The build command accepts --watch to rebuild on changes. (#455)
- Changed: Progress output goes to standard error. (#451)
`,
  },
  'config-crash': {
    'config/app.json': `{
  "host": "localhost",
  "port": 8080
}
`,
  },
  'wrap-implement': {
    'src/wrap.mjs': `export function wrap(text, width) {
  const lines = []
  let line = ''
  for (const word of text.split(' ').filter(part => part !== '')) {
    if (line === '') line = word
    else if (line.length + 1 + word.length <= width) line += ' ' + word
    else {
      lines.push(line)
      line = word
    }
  }
  if (line !== '') lines.push(line)
  return lines.join('\\n')
}
`,
  },
  'leaderboard-bug': {
    'src/leaderboard.mjs': `/** The \`count\` entries with the highest scores, highest first; entries with equal scores keep their order. */
export function topScores(entries, count) {
  return [...entries].sort((left, right) => right.score - left.score).slice(0, count)
}
`,
    'test/leaderboard.test.mjs': `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { topScores } from '../src/leaderboard.mjs'

test('highest first', () => {
  const entries = [{ name: 'ada', score: 3 }, { name: 'bo', score: 7 }, { name: 'cy', score: 5 }]
  assert.deepEqual(topScores(entries, 2).map(entry => entry.name), ['bo', 'cy'])
})

test('compares scores as numbers', () => {
  const entries = [{ name: 'ada', score: 9 }, { name: 'bo', score: 10 }]
  assert.deepEqual(topScores(entries, 2).map(entry => entry.name), ['bo', 'ada'])
})
`,
  },
  'readme-option': {
    'README.md': `# tidy

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

### \`--dry-run\`

Prints the formatted output instead of writing it.

\`\`\`sh
tidy --dry-run src/*.js
\`\`\`

### \`--write\`

Rewrites each file in place.

\`\`\`sh
tidy --write src/*.js
\`\`\`
`,
  },
}
