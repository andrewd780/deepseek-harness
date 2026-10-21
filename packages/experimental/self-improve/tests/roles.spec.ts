import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TaskId } from '../src/brand.ts'
import { analystPrompt, analystSystemPrompt, createAnalyst, createProposer, proposerSystemPrompt } from '../src/roles.ts'
import type { ProposalRequest, TextModel, TextRequest } from '../src/types.ts'
import { evaluation, componentSet } from './fixtures.ts'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function evolvedDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-self-improve-roles-'))
  roots.push(root)
  const path = join(root, 'evolved')
  await mkdir(path)
  await writeFile(join(path, 'AGENTS.md'), 'Work carefully.\n')
  return path
}

function scripted(...answers: (string | object)[]): TextModel & { readonly requests: TextRequest[] } {
  const requests: TextRequest[] = []
  return {
    requests,
    complete: async (request) => {
      requests.push(request)
      const answer = answers.shift() ?? { action: 'list_files' }
      return typeof answer === 'string' ? answer : `Here you go: ${JSON.stringify(answer)}`
    },
  }
}

function request(path: string, overrides: Partial<ProposalRequest> = {}): ProposalRequest {
  return {
    round: 0,
    rounds: 3,
    variant: 'A',
    variants: 2,
    checkout: { name: 'r0A', branch: 'b', base: 'c0', root: path, evolvedDirectory: path, diff: async () => '', commit: async () => 'c1' },
    budget: 2,
    exploration: { stalled: false, untried: ['skill'], reservedSlots: 0, directive: 'Components this run has not changed yet: skill.' },
    reserved: false,
    prune: [],
    history: [],
    analysis: 'weak tasks stop early',
    evidence: [{ task: TaskId('a'), trial: 0, kind: 'failure', reward: 0, text: 'trace of a' }],
    incumbent: evaluation('base', { a: [0, 1] }),
    componentSet,
    briefs: { analyst: 'analyst brief', proposer: 'proposer brief', critic: 'critic brief' },
    ...overrides,
  }
}

const settings = (model: TextModel, maxTurns = 20) => ({ model, maxTurns, maxReadCharacters: 400, writableExtensions: ['.md'] })

describe('createAnalyst', () => {
  it('sends the evidence and the previous report', async () => {
    const model = scripted('the report')
    const analyst = createAnalyst(model)
    const signal = new AbortController().signal
    const base = { round: 2, incumbent: evaluation('base', { a: [1, 0] }), briefs: request('/x').briefs, signal }
    const evidence = [{ task: TaskId('a'), trial: 1, kind: 'failure' as const, reward: 0, text: 'trace' }]
    expect(await analyst.analyze({ ...base, evidence, previous: 'old report' })).toBe('the report')
    expect(model.requests[0]).toEqual({ system: analystSystemPrompt('analyst brief'), prompt: analystPrompt({ ...base, evidence, previous: 'old report' }), signal })
    expect(model.requests[0]?.prompt).toContain('Previous report:\nold report')
    expect(model.requests[0]?.prompt).toContain('=== failure trial: task a, trial 1, reward 0 ===\ntrace')
    expect(analystPrompt({ ...base, evidence: [], previous: '' })).toContain('There is no previous report.')
    expect(analystSystemPrompt('')).not.toContain('\n\n\n\n')
  })
})

describe('createProposer', () => {
  it('edits the evolved directory through actions and declares its edits', async () => {
    const path = await evolvedDirectory()
    const model = scripted(
      { action: 'list_files' },
      { action: 'read_file', path: 'AGENTS.md' },
      { action: 'read_trace', task: 'a' },
      { action: 'edit_file', path: 'AGENTS.md', old: 'carefully', new: 'carefully and verify each step' },
      { action: 'write_file', path: 'skills/check/SKILL.md', content: '# Check\n' },
      { action: 'done', summary: 'verify steps', edits: [{ id: 'E1', component: ' Prompt ', hypothesis: 'verification catches early stops' }] },
    )
    const proposal = await createProposer(settings(model)).propose(request(path))
    expect(proposal).toMatchObject({ status: 'done', summary: 'verify steps', edits: [{ id: 'E1', component: 'prompt', hypothesis: 'verification catches early stops' }] })
    expect(await readFile(join(path, 'AGENTS.md'), 'utf8')).toBe('Work carefully and verify each step.\n')
    expect(await readFile(join(path, 'skills', 'check', 'SKILL.md'), 'utf8')).toBe('# Check\n')
    expect(proposal.transcript).toContain('[result] AGENTS.md')
    expect(proposal.transcript).toContain('[result] trace of a')
    expect(proposal.transcript).toContain('[result] OK: created skills/check/SKILL.md')
    const first = model.requests[0]
    expect(first?.system).toBe(proposerSystemPrompt('proposer brief', componentSet.names))
    expect(first?.prompt).toContain('You draft candidate A of round 1 of 3. 2 candidate(s)')
    expect(first?.prompt).toContain('Declare at most 2 edit(s).')
    expect(first?.prompt).toContain('a: 0.500')
    expect(first?.prompt).toContain('a (failure, reward 0)')
    expect(first?.prompt).not.toContain('reserved exploration slot')
    expect(first?.prompt).not.toContain('=== Rejected draft ===')
  })

  it('answers invalid actions with errors and keeps every write inside the evolved directory', async () => {
    const path = await evolvedDirectory()
    const outside = join(path, '..', 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'secret.md'), 'secret')
    await symlink(join(outside, 'secret.md'), join(path, 'link.md'))
    await symlink(outside, join(path, 'escape'))
    await writeFile(join(path, 'twice.md'), 'x x')
    await writeFile(join(path, 'big.md'), 'y'.repeat(500))
    const model = scripted(
      'no json here',
      '[1, 2]',
      '{"action": broken}',
      { action: 'dance' },
      { action: 'read_file', path: 'missing.md' },
      { action: 'read_file', path: '../outside/secret.md' },
      { action: 'read_file', path: join(path, 'AGENTS.md') },
      { action: 'read_file', path: 7 },
      { action: 'read_file', path: 'link.md' },
      { action: 'write_file', path: 'escape/new.md', content: 'x' },
      { action: 'read_file', path: 'big.md' },
      { action: 'read_trace', task: 'zzz' },
      { action: 'edit_file', path: 'twice.md', old: 'x', new: 'y' },
      { action: 'edit_file', path: 'twice.md', old: 'absent', new: 'y' },
      { action: 'edit_file', path: 'twice.md', old: '', new: 'y' },
      { action: 'write_file', path: 'AGENTS.md', content: 'overwrite' },
      { action: 'write_file', path: 'tool.ts', content: 'code' },
      { action: 'write_file', path: 'notes.md', content: 3 },
      { action: 'done', summary: 'nothing', edits: [{ id: 'E1', component: 'prompt', hypothesis: 'h' }] },
    )
    const proposal = await createProposer(settings(model, 19)).propose(request(path))
    expect(proposal).toMatchObject({ status: 'failed', summary: 'no candidate after 19 model request(s)', edits: [] })
    const results = [...(proposal.transcript ?? '').matchAll(/\[result\] (.*)/g)].map(match => match[1])
    expect(results).toEqual([
      'ERROR: reply with exactly one JSON object',
      'ERROR: reply with exactly one JSON object',
      'ERROR: reply with exactly one JSON object',
      'ERROR: unknown action "dance"',
      expect.stringMatching(/^ERROR: ENOENT/),
      'ERROR: ../outside/secret.md is outside the working directory',
      'ERROR: path must be a relative path',
      'ERROR: path must be a relative path',
      'ERROR: link.md is a symbolic link',
      'ERROR: escape leads outside the working directory',
      'y'.repeat(400),
      'ERROR: no evidence trial for task zzz',
      'ERROR: old text occurs 2 times; it must occur exactly once',
      'ERROR: old text occurs 0 times; it must occur exactly once',
      'ERROR: old and new must be strings, old not empty',
      expect.stringMatching(/^ERROR: EEXIST/),
      'ERROR: write_file creates only .md files',
      'ERROR: content must be a string',
      'ERROR: no file was changed; change files with edit_file or write_file first. Fix this and call done again.',
    ])
    expect(proposal.transcript).toContain('...[100 more characters]')
    expect(await readFile(join(outside, 'secret.md'), 'utf8')).toBe('secret')
  })

  it('bounces a done that breaks the budget, the componentSet, or a reserved slot', async () => {
    const path = await evolvedDirectory()
    const model = scripted(
      { action: 'edit_file', path: 'AGENTS.md', old: 'Work', new: 'Plan, then work' },
      { action: 'done', summary: 's', edits: 'many' },
      { action: 'done', summary: 's', edits: [{ id: 'E1' }] },
      { action: 'done', summary: 's', edits: [7] },
      { action: 'done', summary: 's', edits: [] },
      { action: 'done', summary: 's', edits: [1, 2, 3].map(index => ({ id: `E${index}`, component: 'prompt', hypothesis: 'h' })) },
      { action: 'done', summary: 's', edits: [{ id: 'E1', component: 'telepathy', hypothesis: 'h' }] },
      { action: 'done', edits: [{ id: 'E1', component: 'skill', hypothesis: 'a new skill' }] },
    )
    const repair = { reasons: ['names a task'], riskNotes: [], declared: [{ id: 'E0', component: 'prompt', hypothesis: 'h' }] }
    const exploration = { stalled: true, untried: ['skill'], reservedSlots: 1, directive: 'The incumbent has not improved.' }
    const proposal = await createProposer(settings(model)).propose(request(path, { reserved: true, exploration, repair }))
    expect(proposal).toMatchObject({ status: 'done', summary: '', edits: [{ id: 'E1', component: 'skill' }] })
    const results = [...(proposal.transcript ?? '').matchAll(/\[result\] ERROR: (.*)\. Fix this/g)].map(match => match[1])
    const missing = 'edits must list at least one {id, component, hypothesis}'
    const slot = 'this candidate holds a reserved exploration slot: change at least one of skill'
    expect(results).toEqual([
      missing,
      missing,
      missing,
      missing,
      `3 edits exceed this round's budget of 2; ${slot}`,
      `unknown component(s): telepathy; ${slot}`,
    ])
    const prompt = model.requests[0]?.prompt ?? ''
    expect(prompt).toContain('This candidate holds a reserved exploration slot: at least one edit must change one of skill.')
    expect(prompt).toContain('=== Rejected draft ===\nThe reviewer rejected your previous draft of this candidate. Reasons: names a task. Risk notes: none.')
  })

  it('rethrows cancellation from a failed action', async () => {
    const path = await evolvedDirectory()
    const controller = new AbortController()
    const model: TextModel = {
      complete: vi.fn(async () => {
        controller.abort(new Error('stopped'))
        return JSON.stringify({ action: 'read_file', path: 'missing.md' })
      }),
    }
    await expect(createProposer(settings(model)).propose(request(path, { signal: controller.signal }))).rejects.toThrow('stopped')
  })

  it('lists an empty evolved directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-self-improve-empty-'))
    roots.push(root)
    const model = scripted({ action: 'list_files' })
    const proposal = await createProposer(settings(model, 1)).propose(request(root))
    expect(proposal.transcript).toContain('[result] (no files)')
  })
})
