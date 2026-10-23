import './isolated-home.ts'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { JobHooks, JobOutcome, JobSpec } from '@deepseek-ai/dsh-jobs'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { generations, nextGeneration, nextStartPoint, readAutoRecord } from '../src/auto.ts'
import { INSTRUCTIONS_SECTION, PATCH_SECTION } from '../src/apply.ts'
import { internals, openRun } from '../src/command.ts'
import { RunDirectory } from '../src/directory.ts'
import * as SelfImprove from '../src/index.ts'
import { useFakeRuntime } from './fake-runtime.ts'
import * as RoleModel from './fixtures/role-model.ts'
import { repository } from './repository.ts'

const roots: string[] = []
const contexts: Context[] = []
let fake: ReturnType<typeof useFakeRuntime> | undefined
const defaults = { ...internals }

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  fake?.restore()
  fake = undefined
  Object.assign(internals, defaults)
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

type Handler = (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>

interface StartedJob {
  readonly spec: JobSpec
  readonly hooks: JobHooks
  readonly output: string[]
}

/** Answers `listModels` for the `listed` provider with one model, so the route check has a catalog to read. */
class ListedAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([{ provider, id: 'listed-model', name: 'listed-model' }])
  }

  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield* []
  }
}

interface HarnessOptions {
  /** Overrides of the fixture run's spec. */
  readonly spec?: Record<string, unknown>
  /** Plugin configuration beyond the defaults the harness sets. */
  readonly config?: Record<string, unknown>
  /** Files committed into the fixture's evolved directory before the run starts. */
  readonly evolved?: Readonly<Record<string, string>>
  readonly jobs?: 'present' | 'absent' | 'throws'
  /** A profile context the launcher would provide. */
  readonly profile?: { readonly home: string; readonly patchPath: string }
  /** Whether the harness sets `home`; without it the plugin resolves the home itself. */
  readonly home?: boolean
}

async function harness(options: HarnessOptions = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-self-improve-auto-')))
  roots.push(root)
  const { repo, git } = await repository(root, options.spec)
  if (options.evolved !== undefined) {
    for (const [path, content] of Object.entries(options.evolved)) {
      await mkdir(join(repo, 'harness', 'evolved', path, '..'), { recursive: true })
      await writeFile(join(repo, 'harness', 'evolved', path), content)
    }
    await git('add', '.')
    await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-q', '-m', 'evolved')
  }
  fake ??= useFakeRuntime()
  const ctx = new Context()
  contexts.push(ctx)
  const handlers = new Map<string, Handler>()
  ctx.provide('commands', {
    register: (definition: { readonly name: string; readonly handler: Handler }) => {
      handlers.set(definition.name, definition.handler)
      return () => {
        handlers.delete(definition.name)
      }
    },
  } as never)
  ctx.provide('workingDirectory', { ensure: async () => repo } as never)
  if (options.profile !== undefined) ctx.provide('profileContext', options.profile as never)
  const started: StartedJob[] = []
  if (options.jobs !== 'absent') {
    ctx.provide('jobs', {
      start: (spec: JobSpec) => {
        if (options.jobs === 'throws') throw new Error('session "agent-1" has no live agent (background job owner must be live)')
        const output: string[] = []
        const hooks = spec.run({ id: `job-${started.length}`, append: (text: string) => output.push(text), updateProgress: () => {} } as never)
        started.push({ spec, hooks, output })
        return `job-${started.length - 1}`
      },
    } as never)
  }
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(RoleModel)
  ctx.effect(() => ctx.llm.registerAdapter(['listed'], new ListedAdapter()))
  await ctx.plugin(LocalSubprocessRuntime)
  const home = join(root, 'home')
  await ctx.plugin(SelfImprove, {
    scratchDirectory: join(root, 'scratch'),
    sandboxChecks: process.platform === 'darwin',
    ...options.home === false ? {} : { home },
    ...options.config,
    auto: { directory: repo, ...options.config?.['auto'] as object },
  })
  const run = async (line: string): Promise<CommandResult> => {
    const handler = handlers.get('self-improve')
    if (handler === undefined) throw new Error('self-improve is not registered')
    return await handler({ commandId: 'c' as never, agent: { id: 'agent-1' } as never, rawInput: line, attachments: [], signal: new AbortController().signal })
  }
  /** Run a command that starts a job and wait for the job. */
  const job = async (line: string): Promise<{ readonly reply: string; readonly outcome: JobOutcome; readonly output: string }> => {
    const before = started.length
    const reply = await run(line)
    expect(reply).toMatchObject({ kind: 'success', text: expect.stringMatching(/^started job job-\d+: self-improve /) as string })
    const entry = started[before]!
    const outcome = await entry.hooks.done
    return { reply: reply.text ?? '', outcome, output: entry.output.join('') }
  }
  return { root, repo, git, home, run, job, started }
}

const runDirectory = (repo: string, name = 'loader') => new RunDirectory(join(repo, '.agents', 'self-improve', name))
// A day no test runs on, so a record written at the real time shows its date.
const fixedNow = new Date(2001, 0, 2, 3, 0)

describe('the automatic pipeline', () => {
  it('runs every stage of a new run, applies the accepted skill, and records the summary', async () => {
    internals.now = () => fixedNow
    const { job, repo, home, git, run } = await harness({ spec: { delta: 'calibrate', calibration: { method: 'spread' } } })
    const head = await git('rev-parse', 'HEAD')
    const { reply, outcome, output } = await job('')
    expect(reply.split('\n')).toEqual([
      'started job job-0: self-improve auto loader',
      `Continuing generation 1 in ${repo}.`,
      'Stages: baseline, noise band, 1 round(s), held-out tasks, apply to your dsh configuration, then a summary. Stages already done are skipped.',
      'The job\'s output narrates each stage; /self-improve status shows where the run stands.',
    ])
    const evolved = await git('rev-parse', 'self-improve/loader')
    const backup = join(home, 'self-improve', 'backups', fixedNow.toISOString().replace(/[:.]/g, '-'))
    const summary = [
      'Self-improvement run loader finished 1 round(s) and accepted 1 change(s).',
      'Score on the 2 practice task(s): 0.500 before, 0.500 after; differences up to 0.000 count as noise.',
      'Score on the 1 held-out task(s), which the search never sees: 1.000 before, 1.000 after.',
      'What changed:',
      '- Round 1, candidate A: add a verification skill (skill: a checklist catches unverified answers)',
      '- Files in harness/evolved/: skills/verify/SKILL.md (+5 -0)',
      `Applied to your dsh configuration: ${join(home, 'AGENTS.md')}, ${join(home, 'skills', 'verify')}. New sessions use it. Undo with /self-improve undo, which restores the backup in ${backup}.`,
    ].join('\n')
    expect(outcome).toEqual({ status: 'completed', result: summary })
    expect(output.split('\n')).toEqual(expect.arrayContaining([
      `self-improve auto: generation 1, run loader in ${repo}`,
      'stage 1/5, baseline: measuring',
      `baseline ${head}: score 0.5000, cost not reported`,
      'stage 2/5, noise band: measuring the baseline 1 more time(s)',
      'stage 3/5, rounds: 0 of 1 done',
      'round 1 of 1: accepted candidate A, score 0.5000',
      'stage 4/5, held-out tasks',
      'stage 5/5, apply',
    ]))
    expect(await git('rev-parse', 'self-improve/loader--apply')).toBe(evolved)
    expect(await readFile(join(home, 'AGENTS.md'), 'utf8')).toBe(`${INSTRUCTIONS_SECTION.start}\nWork carefully.\n${INSTRUCTIONS_SECTION.end}\n`)
    expect(await readAutoRecord(runDirectory(repo))).toEqual({ completedAt: expect.any(String) as string, summary, applied: summary.split('\n').at(-1) })
    const status = (await run('status')).text?.split('\n') ?? []
    expect(status.slice(0, 5)).toEqual([
      `Automatic run in ${repo}, generation 1 (run loader): finished; /self-improve starts the next generation from its result.`,
      'Stages: baseline measured; noise band 0.0000; all 1 round(s) done; held-out score 1.0000.',
      `H0: score 0.5000, cost not reported, ${head}`,
      `H1: score 0.5000, cost not reported, ${evolved} (A)`,
      'This run uses mock model mock-role; the plugin settings name ollama model qwen38-27b-abliterated-mlx-q4:latest, which only a new automatic run directory picks up.',
    ])
    expect(status).toContain(summary.split('\n')[0])
    expect(status.at(-3)).toBe('schedule: off (set by the plugin settings)')
  })

  it('resumes a run: stages it already finished are skipped, not measured again', async () => {
    const { job, run } = await harness({ spec: { delta: 'calibrate', calibration: { method: 'spread' } } })
    expect((await job('baseline run.json')).outcome).toMatchObject({ status: 'completed' })
    const status = (await run('status')).text ?? ''
    expect(status).toContain('generation 1 (run loader): stopped before it finished; /self-improve resumes it.')
    expect(status).toContain('Stages: baseline measured; noise band not calibrated; round 1 of 1 next; held-out not measured.')
    expect((await job('calibrate run.json 1')).outcome).toMatchObject({ status: 'completed' })
    const launches = fake!.launches.length
    const { output, outcome } = await job('auto')
    expect(outcome).toMatchObject({ status: 'completed' })
    expect(output).toContain('stage 1/5, baseline: already measured\n')
    expect(output).toContain('stage 2/5, noise band: already calibrated\n')
    // One smoke trial, two evolve trials of the candidate, and the held-out task for each end of the trajectory.
    expect(fake!.launches.length - launches).toBe(1 + 2 + 1 + 1)
  })

  it('finishes a run its explicit actions advanced and a hand apply already applied', async () => {
    const { job, run, repo } = await harness()
    expect(await run('apply run.json')).toEqual({ kind: 'success', text: 'Nothing to apply: run loader has accepted no candidate.' })
    expect((await job('baseline run.json')).outcome).toMatchObject({ status: 'completed' })
    expect((await job('round run.json')).outcome).toMatchObject({ status: 'completed' })
    expect((await run('apply')).text).toMatch(/^Applied run loader at /)
    await rm(join(repo, '.agents', 'self-improve', 'loader', 'rounds', '0', 'A', 'candidate.json'))
    const { outcome, output } = await job('')
    expect(output).toContain('stage 3/5, rounds: 1 of 1 done\n')
    const lines = (outcome.status === 'completed' ? outcome.result ?? '' : '').split('\n')
    expect(lines).toContain('- Round 1, candidate A: its candidate record is missing')
    expect(lines.at(-1)).toBe('Already applied: your configuration holds this result.')
  })

  it('starts the next generation from a finished one', async () => {
    const { job, repo, git, run } = await harness()
    expect((await job('')).outcome).toMatchObject({ status: 'completed' })
    const first = await git('rev-parse', 'self-improve/loader')
    const { reply, outcome, output } = await job('')
    expect(reply.split('\n')[1]).toBe(`Starting generation 2, which improves on generation 1's result, in ${repo}.`)
    expect(JSON.parse(await readFile(join(repo, 'run-2.json'), 'utf8'))).toMatchObject({ name: 'loader-2', startPoint: 'self-improve/loader' })
    expect(output).toContain(`baseline ${first}: score 0.5000, cost not reported\n`)
    expect(output).toContain('stage 2/5, noise band: fixed by the spec\n')
    // The scripted proposer creates the same skill again, which now exists, so its draft fails.
    expect(outcome).toEqual({
      status: 'completed',
      result: [
        'Self-improvement run loader-2 finished 1 round(s) and accepted 0 change(s).',
        'Score on the 2 practice task(s): 0.500 before, 0.500 after; differences up to 0.050 count as noise.',
        'Score on the 1 held-out task(s), which the search never sees: 1.000 before, 1.000 after.',
        'What changed: nothing.',
        'Not applied: no candidate beat the baseline, so your configuration is unchanged.',
      ].join('\n'),
    })
    const status = (await run('status')).text ?? ''
    expect(status).toContain(`Automatic run in ${repo}, generation 2 (run loader-2): finished;`)
    expect(status).toContain('Last summary (')
    expect(status).toContain('Self-improvement run loader-2 finished 1 round(s) and accepted 0 change(s).')
    await nextGeneration(repo, { index: 2, spec: join(repo, 'run-2.json') }, 'self-improve/loader-2')
    // A generation that has not started shows the summary of the one before it.
    const pending = (await run('status')).text?.split('\n') ?? []
    expect(pending[0]).toBe(`Automatic run in ${repo}, generation 3 (run loader-3): not started; /self-improve starts it.`)
    expect(pending.slice(2, 4)).toEqual([expect.stringMatching(/^Last summary \(\d\d:\d\d\):$/) as string, 'Self-improvement run loader-2 finished 1 round(s) and accepted 0 change(s).'])
  })

  it('leaves the configuration alone when autoApply is off, then applies and undoes by hand', async () => {
    internals.now = () => fixedNow
    const { job, run, home, git } = await harness({ config: { autoApply: false } })
    const { outcome } = await job('')
    expect(outcome).toMatchObject({ status: 'completed', result: expect.stringMatching(/\nNot applied: autoApply is off\. Run \/self-improve apply to apply it\.$/) as string })
    await expect(readFile(join(home, 'AGENTS.md'), 'utf8')).rejects.toThrow(/ENOENT/)
    const evolved = await git('rev-parse', 'self-improve/loader')
    const backup = join(home, 'self-improve', 'backups', fixedNow.toISOString().replace(/[:.]/g, '-'))
    expect(await run('apply')).toEqual({
      kind: 'success',
      text: `Applied run loader at ${evolved}: ${join(home, 'AGENTS.md')}, ${join(home, 'skills', 'verify')}.\nThe previous files are in ${backup}. New sessions use the change; /self-improve undo restores the backup.`,
    })
    expect(await run('apply run.json')).toEqual({ kind: 'success', text: `Your dsh configuration already holds run loader's result at ${evolved}.` })
    expect(await run('undo')).toEqual({
      kind: 'success',
      text: [
        `Restored ${join(home, 'AGENTS.md')}, ${join(home, 'skills', 'verify')} from ${backup}.`,
        `What the undo replaced is saved in ${backup}-undo. New sessions use the restored configuration.`,
        'The automatic pipeline does not apply the undone result again, and the next generation does not start from it; /self-improve apply applies it by hand.',
      ].join('\n'),
    })
    await expect(readFile(join(home, 'skills', 'verify', 'SKILL.md'), 'utf8')).rejects.toThrow(/ENOENT/)
    expect(await run('undo')).toEqual({ kind: 'error', text: 'self-improve has no applied change to undo' })
  })

  it('keeps a generation whose apply failed unfinished, and retries the apply before anything else', async () => {
    const { job, home, repo } = await harness()
    await mkdir(home, { recursive: true })
    await writeFile(join(home, 'AGENTS.md'), `${INSTRUCTIONS_SECTION.start}\nhalf a section\n`)
    const failed = await job('')
    const message = `Not applied: self-improve apply refused: ${join(home, 'AGENTS.md')} has a damaged self-improve section; restore it with /self-improve undo or remove the section's lines`
    expect(failed.outcome).toMatchObject({ status: 'completed', result: expect.stringContaining(`\n${message}\nFix that and run /self-improve again; it retries the apply before the next generation starts.`) as string })
    expect(await readAutoRecord(runDirectory(repo))).toBeUndefined()
    await writeFile(join(home, 'AGENTS.md'), 'Mine.\n')
    const retried = await job('')
    expect(retried.reply.split('\n')[1]).toBe(`Continuing generation 1 in ${repo}.`)
    expect(retried.outcome).toMatchObject({ status: 'completed', result: expect.stringMatching(/\nApplied to your dsh configuration: /) as string })
    expect(await readFile(join(home, 'AGENTS.md'), 'utf8')).toBe(`Mine.\n\n${INSTRUCTIONS_SECTION.start}\nWork carefully.\n${INSTRUCTIONS_SECTION.end}\n`)
    expect(await readAutoRecord(runDirectory(repo))).toBeDefined()
  })

  it('never applies an undone result again, and starts the next generation from before it', async () => {
    const { job, run, repo, git } = await harness()
    const base = await git('rev-parse', 'HEAD')
    expect((await job('baseline run.json')).outcome).toMatchObject({ status: 'completed' })
    expect((await job('round run.json')).outcome).toMatchObject({ status: 'completed' })
    expect((await run('apply')).text).toMatch(/^Applied run loader at /)
    expect((await run('undo')).kind).toBe('success')
    const { outcome } = await job('')
    expect(outcome).toMatchObject({ status: 'completed', result: expect.stringMatching(/\nNot applied: you undid this result with \/self-improve undo\. Run \/self-improve apply to apply it anyway\.$/) as string })
    expect((await job('')).reply.split('\n')[1]).toBe(`Starting generation 2, which improves on generation 1's result, in ${repo}.`)
    expect(JSON.parse(await readFile(join(repo, 'run-2.json'), 'utf8'))).toMatchObject({ startPoint: base })
  })

  it('writes the overlay into the home patch layer and instructions into the running profile\'s home', async () => {
    const profileRoot = await realpath(await mkdtemp(join(tmpdir(), 'dsh-self-improve-profile-')))
    roots.push(profileRoot)
    const profile = { home: join(profileRoot, 'home'), patchPath: join(profileRoot, 'home', 'profiles', 'desktop', 'cordis.patch.yml') }
    await mkdir(join(profile.patchPath, '..'), { recursive: true })
    await writeFile(profile.patchPath, '# mine\n- id: agent-loop\n  config:\n    agents: []\n')
    const { job } = await harness({ home: false, profile, evolved: { 'overlay.patch.yml': '- id: spill-policy\n  config:\n    maxInlineTokens: 2000\n' } })
    const { outcome } = await job('')
    expect(outcome).toMatchObject({ status: 'completed', result: expect.stringContaining(`: ${join(profile.home, 'cordis.patch.yml')}, `) as string })
    expect(outcome).toMatchObject({ result: expect.stringContaining(' Overlay entries: spill-policy (maxInlineTokens). New sessions use it.') as string })
    expect(await readFile(join(profile.home, 'cordis.patch.yml'), 'utf8')).toBe(`${PATCH_SECTION.start}\n- id: spill-policy\n  config:\n    maxInlineTokens: 2000\n${PATCH_SECTION.end}\n`)
    // dsh's own editors write the profile's patch; the apply leaves it alone.
    expect(await readFile(profile.patchPath, 'utf8')).toBe('# mine\n- id: agent-loop\n  config:\n    agents: []\n')
    expect(await readFile(join(profile.home, 'skills', 'verify', 'SKILL.md'), 'utf8')).toContain('name: verify')
    expect(await readdir(join(profile.home, 'self-improve', 'backups'))).toHaveLength(1)
  })

  it('writes the overlay into a configured patch, and keeps state under DSH_HOME when no home is configured', async () => {
    const patchRoot = await realpath(await mkdtemp(join(tmpdir(), 'dsh-self-improve-patch-')))
    roots.push(patchRoot)
    const patch = join(patchRoot, 'cordis.patch.yml')
    const { job, run } = await harness({
      home: false,
      config: { overlayPatch: patch, autoApply: false },
      evolved: { 'overlay.patch.yml': '- id: spill-policy\n  config:\n    maxInlineTokens: 2000\n' },
    })
    const before = await readdir(join(process.env['DSH_HOME'] ?? '', 'self-improve', 'backups')).catch(() => [])
    expect((await job('')).outcome).toMatchObject({ status: 'completed' })
    expect((await run('apply')).text?.split('\n')[0]).toMatch(/ Overlay entries: spill-policy \(maxInlineTokens\)\.$/)
    expect(await readFile(patch, 'utf8')).toBe(`${PATCH_SECTION.start}\n- id: spill-policy\n  config:\n    maxInlineTokens: 2000\n${PATCH_SECTION.end}\n`)
    expect(await readdir(join(process.env['DSH_HOME'] ?? '', 'self-improve', 'backups'))).toHaveLength(before.length + 1)
  })
})

describe('/self-improve in the automatic mode', () => {
  it('reports a missing run, a run that never started, and a run in progress', async () => {
    const { run, repo, git, started } = await harness({ spec: { trial: { policyPatches: ['policy.patch.yml'], provider: 'mock', model: 'm', env: { FAKE_HANG_PROMPT: '1' }, timeoutMs: 600_000 } } })
    await rm(join(repo, 'run.json'))
    expect(await run('')).toEqual({ kind: 'error', text: `self-improve automatic run directory ${repo} exists without run.json; move it away or set auto.directory to another path` })
    expect((await run('status')).text?.split('\n')[0]).toBe(`No automatic run yet: /self-improve creates one at ${repo} and runs it in the background.`)
    expect(await run('apply')).toEqual({ kind: 'success', text: `Nothing to apply: there is no automatic run in ${repo} yet.` })
    await git('checkout', '-q', 'run.json')
    expect((await run('status')).text?.split('\n')[0]).toBe(`Automatic run in ${repo}, generation 1 (run loader): not started; /self-improve starts it.`)
    expect((await run('')).kind).toBe('success')
    const status = (await run('status')).text?.split('\n')[0]
    expect(status).toMatch(new RegExp('^Automatic run in .*: running as job job-0 since \\d\\d:\\d\\d; its output narrates each stage\\.$'))
    expect((await run('')).text).toMatch(/^The automatic run is already running as job job-0, started \d\d:\d\d\. Its output narrates each stage, and \/self-improve status shows where the run stands\.$/)
    started[0]!.hooks.cancel('operator stop')
    expect(await started[0]!.hooks.done).toEqual({ status: 'killed', detail: 'operator stop' })
  })

  it('needs background jobs and a route dsh lists for the search roles', async () => {
    const absent = await harness({ jobs: 'absent' })
    expect(await absent.run('')).toEqual({ kind: 'error', text: 'self-improve needs background jobs: load @deepseek-ai/dsh-jobs-local and @deepseek-ai/dsh-tool-jobs' })
    const unknown = await harness({ spec: { roles: { provider: 'nowhere', model: 'm' } } })
    expect(await unknown.run('')).toEqual({
      kind: 'error',
      text: 'self-improve search roles use provider nowhere, which dsh has no route for (no adapter registered for provider "nowhere"); add the provider to your dsh configuration, or change roles.provider in loader\'s run spec',
    })
    const unlisted = await harness({ spec: { roles: { provider: 'listed', model: 'qwen38-27b-abliterated-mlx-q4:latest' } } })
    expect(await unlisted.run('')).toEqual({
      kind: 'error',
      text: 'self-improve search roles use listed model qwen38-27b-abliterated-mlx-q4:latest, which your dsh configuration does not list; add "- id: qwen38-27b-abliterated-mlx-q4:latest" under providers.listed.models of the llm-pi-ai entry in your profile\'s cordis.patch.yml, or change roles.model in the run spec. Listed: listed-model',
    })
    const listed = await harness({ spec: { roles: { provider: 'listed', model: 'listed-model' } }, jobs: 'throws' })
    expect(await listed.run('')).toEqual({ kind: 'error', text: 'session "agent-1" has no live agent (background job owner must be live)' })
  })

  it('applies nothing when no generation accepted a candidate', async () => {
    const { job, run } = await harness({ evolved: { 'skills/verify/SKILL.md': 'exists\n' } })
    expect((await job('')).outcome).toMatchObject({ status: 'completed', result: expect.stringContaining('What changed: nothing.') as string })
    expect(await run('apply')).toEqual({ kind: 'success', text: 'Nothing to apply: no generation of the automatic run has accepted a candidate yet.' })
    expect(await run('apply run.json')).toEqual({ kind: 'success', text: 'Nothing to apply: run loader has accepted no candidate.' })
    expect((await job('')).outcome).toMatchObject({ status: 'completed' })
    expect(await run('apply')).toEqual({ kind: 'success', text: 'Nothing to apply: no generation of the automatic run has accepted a candidate yet.' })
  })

  it('keeps the schedule, and lets the first session claim a schedule the settings turned on', async () => {
    const off = await harness()
    expect((await off.run('schedule on 04:30')).text?.split('\n')).toEqual([
      'schedule: on, daily at 04:30 local time (set by /self-improve schedule)',
      'checks every 5 min: at least 20 h between starts, at least 22 GiB of free, inactive, and speculative memory, and no other self-improve job running',
      'owner: session agent-1, which must be open when a run is due',
      expect.stringMatching(/^now: /) as string,
      'This session owns scheduled runs; keep it open so a due run can start.',
    ])
    expect((await off.run('schedule off')).text?.split('\n')[0]).toBe('schedule: off (set by /self-improve schedule)')
    expect((await off.run('schedule')).text?.split('\n')[0]).toBe('schedule: off (set by /self-improve schedule)')
    const on = await harness({ config: { schedule: { enabled: true } } })
    expect((await on.run('help')).text).toBe(`${SelfImprove.HELP}\nThis session now owns scheduled runs.`)
    expect((await on.run('help')).text).toBe(SelfImprove.HELP)
    await writeFile(join(on.home, 'self-improve', 'schedule.json'), 'not json')
    expect((await on.run('help')).text).toBe(`${SelfImprove.HELP}\nThe schedule could not record an owner: ${join(on.home, 'self-improve', 'schedule.json')} is not JSON`)
  })

  it('starts the automatic pipeline from the schedule\'s timer once memory allows it', async () => {
    let room = 10 * 2 ** 30
    internals.now = () => fixedNow
    internals.memory = async () => room
    const { run, started, home, repo } = await harness({ config: { schedule: { enabled: true, time: '03:00', checkIntervalMinutes: 0.001 } } })
    const spec = JSON.parse(await readFile(join(repo, 'run.json'), 'utf8')) as Record<string, unknown>
    await writeFile(join(repo, 'hang.json'), JSON.stringify({ ...spec, name: 'hang', trial: { policyPatches: ['policy.patch.yml'], provider: 'mock', model: 'm', env: { FAKE_HANG_PROMPT: '1' }, timeoutMs: 600_000 } }))
    const state = async () => JSON.parse(await readFile(join(home, 'self-improve', 'schedule.json'), 'utf8')) as Record<string, unknown>
    expect((await run('baseline hang.json')).text).toBe('started job job-0: self-improve baseline hang\nThis session now owns scheduled runs.')
    await expect.poll(async () => (await state())['lastCheck'], { timeout: 10_000 }).toMatchObject({ reason: 'waiting: job job-0 (self-improve baseline hang) is running' })
    started[0]!.hooks.cancel()
    await started[0]!.hooks.done
    await expect.poll(async () => (await state())['lastCheck'], { timeout: 10_000 }).toMatchObject({ reason: 'waiting: 10.0 GiB of memory is free, inactive, or speculative; 22 GiB needed' })
    expect(started).toHaveLength(1)
    room = 30 * 2 ** 30
    await expect.poll(() => started.length, { timeout: 10_000 }).toBe(2)
    expect(started[1]!.spec).toMatchObject({ label: 'self-improve auto loader', owner: 'agent-1' })
    expect(await started[1]!.hooks.done).toMatchObject({ status: 'completed' })
    expect(await state()).toMatchObject({ lastJob: 'job-1', lastStartedAt: fixedNow.toISOString() })
  })

  it('starts no job from a scheduled check that was still running when the plugin was disposed', async () => {
    internals.now = () => fixedNow
    const reached = Promise.withResolvers<undefined>()
    const gate = Promise.withResolvers<undefined>()
    internals.memory = async () => {
      reached.resolve(undefined)
      await gate.promise
      return 30 * 2 ** 30
    }
    const { run, started, home } = await harness({ config: { schedule: { enabled: true, time: '03:00', checkIntervalMinutes: 0.001 } } })
    expect((await run('help')).text).toContain('This session now owns scheduled runs.')
    await reached.promise
    await contexts.pop()?.fiber.dispose()
    gate.resolve(undefined)
    const state = async () => JSON.parse(await readFile(join(home, 'self-improve', 'schedule.json'), 'utf8')) as Record<string, unknown>
    await expect.poll(async () => (await state())['lastCheck'], { timeout: 10_000 }).toMatchObject({ reason: 'could not start the run for session agent-1: self-improve plugin disposed' })
    expect(started).toHaveLength(0)
  })

  it('reads the clock and vm_stat by default', async () => {
    const before = Date.now()
    expect(defaults.now().getTime()).toBeGreaterThanOrEqual(before)
    const vmStat = 'Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages free: 1.\nPages inactive: 2.\nPages speculative: 3.\n'
    expect(await defaults.memory(async () => ({ exitCode: 0, stdout: vmStat, stderr: '' }))).toBe(6 * 4096)
  })
})

describe('generations', () => {
  it('lists run.json and every later generation in order, and names the next one after the first', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-self-improve-generations-')))
    roots.push(root)
    await writeFile(join(root, 'run.json'), JSON.stringify({ name: 'auto', branch: 'improve/auto', rounds: 3 }))
    await writeFile(join(root, 'run-10.json'), '{}')
    await writeFile(join(root, 'run-2.json'), '{}')
    await writeFile(join(root, 'run-1.json'), '{}')
    await writeFile(join(root, 'suite.json'), '{}')
    expect(await generations(root)).toEqual([
      { index: 1, spec: join(root, 'run.json') },
      { index: 2, spec: join(root, 'run-2.json') },
      { index: 10, spec: join(root, 'run-10.json') },
    ])
    expect(await nextGeneration(root, { index: 10, spec: join(root, 'run-10.json') }, 'improve/auto-10')).toEqual({ index: 11, spec: join(root, 'run-11.json') })
    expect(JSON.parse(await readFile(join(root, 'run-11.json'), 'utf8'))).toEqual({ name: 'auto-11', branch: 'improve/auto-11', rounds: 3, startPoint: 'improve/auto-10' })
    await expect(nextGeneration(root, { index: 10, spec: '' }, 'x')).rejects.toThrow(/EEXIST/)
    for (const invalid of ['[]', '{"rounds": 1}', 'not json']) {
      await writeFile(join(root, 'run.json'), invalid)
      await expect(nextGeneration(root, { index: 20, spec: '' }, 'x')).rejects.toThrow(join(root, 'run.json'))
    }
  })

  it('starts the generation after one without a trajectory from that generation\'s branch', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-self-improve-start-')))
    roots.push(root)
    const { repo } = await repository(root)
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    const settings = {
      runsDirectory: '.agents/self-improve',
      scratchDirectory: join(root, 'scratch'),
      gitTimeoutMs: 60_000,
      processGraceMs: 3000,
      maxOutputBytes: 65_536,
      sandboxChecks: false,
    }
    const opened = await openRun(ctx, settings, join(repo, 'run.json'), () => {})
    expect(await nextStartPoint(opened, new Set(['anything']))).toBe('self-improve/loader')
  })

  it('reads a finished generation\'s record and refuses one that is not', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-self-improve-record-')))
    roots.push(root)
    const directory = new RunDirectory(root)
    expect(await readAutoRecord(directory)).toBeUndefined()
    await writeFile(join(root, 'auto.json'), '{')
    await expect(readAutoRecord(directory)).rejects.toThrow(`${join(root, 'auto.json')} is not JSON`)
    for (const invalid of ['[]', '{"completedAt": "x", "summary": "y"}']) {
      await writeFile(join(root, 'auto.json'), invalid)
      await expect(readAutoRecord(directory)).rejects.toThrow(`${join(root, 'auto.json')} is not a self-improve automatic run record`)
    }
    await rm(join(root, 'auto.json'))
    await mkdir(join(root, 'auto.json'))
    await expect(readAutoRecord(directory)).rejects.toThrow(/EISDIR/)
  })
})
