import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

/** A committed repository with an evolved directory, a frozen policy patch, a three-task suite, and a run spec. */
export async function repository(base: string, spec: Record<string, unknown> = {}): Promise<{
  readonly repo: string
  readonly git: (...args: string[]) => Promise<string>
}> {
  const repo = join(base, 'repo')
  await mkdir(join(repo, 'harness', 'evolved'), { recursive: true })
  const git = async (...args: string[]): Promise<string> => (await exec('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: repo,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '', GIT_CONFIG_COUNT: '0' },
  })).stdout.trim()
  await git('init', '-q', '-b', 'main')
  await writeFile(join(repo, 'harness', 'evolved', 'AGENTS.md'), 'Work carefully.\n')
  await writeFile(join(repo, 'policy.patch.yml'), '[]\n')
  await writeFile(join(repo, 'suite.json'), JSON.stringify({
    briefs: { critic: 'Tasks are short questions.' },
    tasks: [
      { id: 'alpha', split: 'evolve', prompt: 'Report when done.', checks: [{ answer: 'all done' }, { command: ['node', '-e', ''], timeoutMs: 60_000 }] },
      { id: 'beta', split: 'evolve', prompt: 'Say never.', checks: [{ answer: 'never' }] },
      { id: 'gamma', split: 'heldout', prompt: 'Report when done.', checks: [{ answer: 'all done' }] },
    ],
  }))
  await writeFile(join(repo, 'run.json'), JSON.stringify({
    name: 'loader',
    suite: 'suite.json',
    evolvedDirectory: 'harness/evolved',
    trial: { policyPatches: ['policy.patch.yml'], provider: 'mock', model: 'mock-policy', env: { FAKE_TEXT: 'all done' } },
    roles: { provider: 'mock', model: 'mock-role' },
    delta: 0.05,
    rounds: 1,
    variants: 1,
    trials: 1,
    repairRounds: 0,
    ...spec,
  }))
  await git('add', '.')
  await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-q', '-m', 'initial')
  return { repo, git }
}
