import './isolated-home.ts'
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import CommandRegistry from '@deepseek-ai/dsh-commands'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LocalJobs from '@deepseek-ai/dsh-jobs-local'
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs'
import type { JobId } from '@deepseek-ai/dsh-jobs'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import LocalSandbox from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import WorkingDirectoryService from '@deepseek-ai/dsh-working-directory'
import * as SelfImprove from '../src/index.ts'
import { useFakeRuntime } from './fake-runtime.ts'
import { repository } from './repository.ts'
import * as RoleModel from './fixtures/role-model.ts'

let context: Context | undefined
let fake: ReturnType<typeof useFakeRuntime> | undefined
let root: string | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  fake?.restore()
  fake = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Boot the plugin through the Loader with commands, background jobs, a real subprocess provider, and the scripted roles. */
async function boot(base: string, selfImproveConfig: readonly string[], cwd: string) {
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-fs-local', LocalFileSystem],
    ['@deepseek-ai/dsh-subprocess-local', LocalSubprocessRuntime],
    ['@deepseek-ai/dsh-sandbox-local', LocalSandbox],
    ['@deepseek-ai/dsh-sandbox-policy', SandboxPolicyService],
    ['@deepseek-ai/dsh-working-directory', WorkingDirectoryService],
    ['@deepseek-ai/dsh-commands', CommandRegistry],
    ['@deepseek-ai/dsh-jobs-local', LocalJobs],
    ['@deepseek-ai/dsh-tool-jobs', ToolJobs],
    ['self-improve-role-model', RoleModel],
    ['@deepseek-ai/dsh-experimental-self-improve', SelfImprove],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
  ])
  const config = [...modules.keys()].flatMap(name => [
    `- name: 'cordis:${name}'`,
    ...name === '@deepseek-ai/dsh-sandbox-policy' ? ['  config:', '    mode: danger-full-access'] : [],
    ...name === '@deepseek-ai/dsh-agent-loop' ? ['  config:', '    agents: []'] : [],
    ...name === '@deepseek-ai/dsh-experimental-self-improve' ? ['  config:', `    scratchDirectory: '${join(base, 'scratch')}'`, ...selfImproveConfig.map(line => `    ${line}`)] : [],
  ]).join('\n') + '\n'
  const configPath = join(base, 'cordis.yml')
  await writeFile(configPath, config)
  context = new Context()
  context.baseUrl = pathToFileURL(base).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  for (const [specifier, plugin] of modules) context.loader.builtins[specifier] = plugin
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await context.loader.await()

  const ctx = context
  const agent = await ctx.agentLoop.create(SessionId('self-improve-loader'), {}, { cwd })
  const command = async (line: string) => (await ctx.commands.execute(agent, line, [], new AbortController().signal))?.result
  const job = async (line: string): Promise<string | undefined> => {
    const started = await command(line)
    expect(started).toMatchObject({ kind: 'success' })
    const id = /^started job (\S+):/.exec(started?.text ?? '')?.[1]
    expect(id).toBeDefined()
    const view = await ctx.jobs.wait(id as JobId, 170_000, agent.id)
    expect(view).toMatchObject({ status: 'completed' })
    return ctx.jobs.read(id as JobId, agent.id).result
  }
  return { ctx, agent, command, job }
}

describe('/self-improve through real Loader composition', () => {
  it('measures a baseline, runs a round that accepts a new skill on the evolve branch, and unregisters on disposal', async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-self-improve-loader-')))
    const { repo, git } = await repository(root)
    fake = useFakeRuntime()
    const { ctx, command, job } = await boot(root, [`home: '${join(root, 'home')}'`], repo)

    expect(await command('/self-improve status run.json')).toEqual({ kind: 'success', text: 'loader: no baseline yet' })
    const usage = await command('/self-improve dance run.json')
    expect(usage?.kind).toBe('error')
    expect(usage?.text).toMatch(/^\/self-improve has no action "dance"\n\n\/self-improve {22}create the automatic run/)
    const head = await git('rev-parse', 'HEAD')
    expect(await job('/self-improve baseline run.json')).toBe(`baseline ${head}: score 0.5000`)
    expect(await job('/self-improve round run.json')).toBe('round 0: accepted A, score 0.5000')
    const evolved = await git('rev-parse', 'self-improve/loader')
    expect(evolved).not.toBe(head)
    expect(await git('show', '--name-only', '--format=', evolved)).toBe('harness/evolved/skills/verify/SKILL.md')
    expect(await git('rev-parse', 'main')).toBe(head)
    const runDirectory = join(repo, '.agents', 'self-improve', 'loader')
    const history = (await readFile(join(runDirectory, 'history.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    expect(history).toEqual([expect.objectContaining({ round: 0, variant: 'A', component: 'skill', outcome: 'accepted', accepted: true, scoreChange: 0 })])
    expect(await readFile(join(repo, '.agents', 'self-improve', '.gitignore'), 'utf8')).toBe('*\n')
    expect(await readFile(join(runDirectory, 'rounds', '0', 'A', 'proposal-0.txt'), 'utf8')).toContain('OK: created skills/verify/SKILL.md')
    expect(fake.launches.map(launch => launch.patches)).toEqual(Array.from({ length: 5 }, () => [join(repo, 'policy.patch.yml')]))
    expect(await job('/self-improve heldout run.json')).toBe('held-out score 1.0000 over 1 task(s)')
    const status = await command('/self-improve status run.json')
    expect(status?.text?.split('\n')).toEqual([
      'loader: next round none (complete)',
      `H0: score 0.5000, cost not reported, ${head}`,
      `H1: score 0.5000, cost not reported, ${evolved} (A)`,
    ])
    expect(await job('/self-improve run run.json')).toBe('the run has no round left')

    const entry = [...ctx.loader.entries()].find(candidate => candidate.options.name === 'cordis:@deepseek-ai/dsh-experimental-self-improve')
    await entry?.fiber?.dispose()
    expect(await command('/self-improve status run.json')).toBeUndefined()
  }, 180_000)

  it('runs the automatic pipeline from /self-improve alone: creates the starter run, measures it, applies the accepted skill, and summarizes', async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-self-improve-loader-auto-')))
    const home = join(root, 'home')
    fake = useFakeRuntime()
    const { ctx, agent, command } = await boot(root, [
      `home: '${home}'`,
      'auto:',
      '  provider: mock',
      '  model: mock-role',
      '  rounds: 1',
    ], root)

    expect((await command('/self-improve status'))?.text?.split('\n')[0]).toBe(`No automatic run yet: /self-improve creates one at ${join(home, 'self-improve', 'auto')} and runs it in the background.`)
    const started = await command('/self-improve')
    expect(started?.kind).toBe('success')
    expect(started?.text?.split('\n').slice(1)).toEqual([
      `Created the automatic run at ${join(home, 'self-improve', 'auto')}: 6 practice and 2 held-out starter tasks; trials and search roles use mock model mock-role.`,
      'Stages: baseline, noise band, 1 round(s), held-out tasks, apply to your dsh configuration, then a summary. Stages already done are skipped.',
      'The job\'s output narrates each stage; /self-improve status shows where the run stands.',
    ])
    const id = /^started job (\S+): self-improve auto auto$/m.exec(started?.text ?? '')?.[1] as JobId
    expect((await command('/self-improve'))?.text).toMatch(new RegExp(`^The automatic run is already running as job ${id}, started \\d\\d:\\d\\d\\.`))
    expect(await ctx.jobs.wait(id, 170_000, agent.id)).toMatchObject({ status: 'completed' })
    const summary = ctx.jobs.read(id, agent.id).result?.split('\n')
    const backups = join(home, 'self-improve', 'backups')
    const [backup] = await readdir(backups)
    expect(summary).toEqual([
      'Self-improvement run auto finished 1 round(s) and accepted 1 change(s).',
      // The scripted trial runtime leaves every workspace as it starts, which passes a quarter of the checks.
      'Score on the 6 practice task(s): 0.250 before, 0.250 after; differences up to 0.000 count as noise.',
      'Score on the 2 held-out task(s), which the search never sees: 0.250 before, 0.250 after.',
      'What changed:',
      '- Round 1, candidate A: add a verification skill (skill: a checklist catches unverified answers)',
      '- Files in evolved/: skills/verify/SKILL.md (+5 -0)',
      `Applied to your dsh configuration: ${join(home, 'AGENTS.md')}, ${join(home, 'skills', 'verify')}. New sessions use it. Undo with /self-improve undo, which restores the backup in ${join(backups, backup ?? '')}.`,
    ])
    const output = ctx.jobs.readAt(id, 0, agent.id).chunks.map(chunk => chunk.text).join('')
    for (const stage of ['stage 1/5, baseline: measuring', 'stage 2/5, noise band: measuring the baseline 1 more time(s)', 'stage 3/5, rounds: 0 of 1 done', 'round 1 of 1: accepted candidate A, score 0.2500', 'stage 4/5, held-out tasks', 'stage 5/5, apply']) {
      expect(output).toContain(`${stage}\n`)
    }
    expect(await readFile(join(home, 'skills', 'verify', 'SKILL.md'), 'utf8')).toBe('---\nname: verify\ndescription: Check the result before answering.\n---\nRun the check, then answer.\n')
    expect(await readFile(join(home, 'AGENTS.md'), 'utf8')).toBe([
      '<!-- >>> dsh self-improve: /self-improve apply manages this section; /self-improve undo restores this file -->',
      'Work carefully. Check your result before you answer.',
      '<!-- <<< dsh self-improve -->',
      '',
    ].join('\n'))
    // Every trial ran the starter suite's workspaces against the frozen policy patch alone.
    expect(fake.launches).toHaveLength(6 + 6 + 1 + 6 + 2 + 2)
    expect(new Set(fake.launches.map(launch => launch.patches?.join(',')))).toEqual(new Set([join(home, 'self-improve', 'auto', 'policy.patch.yml')]))
    const status = (await command('/self-improve status'))?.text ?? ''
    expect(status).toContain(`Automatic run in ${join(home, 'self-improve', 'auto')}, generation 1 (run auto): finished; /self-improve starts the next generation from its result.`)
    expect(status).toContain('Last summary (')
  }, 180_000)
})
