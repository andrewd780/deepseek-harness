import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GitRevisionStore, repositoryRoot } from '../src/git.ts'
import type { GitStoreSettings } from '../src/git.ts'
import type { ProcessRunner } from '../src/process.ts'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const run: ProcessRunner = async ({ argv, cwd, timeoutMs, env = {} }) => await new Promise((resolve) => {
  const [program, ...args] = argv
  const merged = Object.fromEntries(Object.entries({ ...process.env, GIT_CONFIG_NOSYSTEM: '1', ...env }).filter(([, value]) => value !== undefined))
  execFile(program, args, { cwd, timeout: timeoutMs, env: merged }, (error, stdout, stderr) => {
    resolve({ exitCode: error === null ? 0 : typeof error.code === 'number' ? error.code : null, stdout, stderr })
  })
})

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await run({ argv: ['git', ...args], cwd, timeoutMs: 10_000, env: { GIT_CONFIG_COUNT: undefined } })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}

interface Repository {
  readonly repo: string
  readonly store: GitRevisionStore
  readonly head: string
  readonly settings: GitStoreSettings
}

async function repository(): Promise<Repository> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-self-improve-git-'))
  roots.push(root)
  const repo = join(root, 'repo')
  await mkdir(join(repo, 'evolved'), { recursive: true })
  await git(repo, 'init', '-q', '-b', 'main')
  await git(repo, 'config', 'user.name', 'Test')
  await git(repo, 'config', 'user.email', 'test@example.invalid')
  await writeFile(join(repo, 'evolved', 'AGENTS.md'), 'Work carefully.\n')
  await writeFile(join(repo, 'README.md'), 'readme\n')
  await git(repo, 'add', '.')
  await git(repo, 'commit', '-q', '-m', 'initial')
  const settings: GitStoreSettings = {
    repository: repo,
    branch: 'self-improve/test',
    startPoint: 'HEAD',
    checkouts: join(root, 'runs', 'checkouts'),
    evolvedDirectory: 'evolved',
    run,
    timeoutMs: 10_000,
  }
  return { repo, store: new GitRevisionStore(settings), head: await git(repo, 'rev-parse', 'HEAD'), settings }
}

describe('GitRevisionStore', () => {
  it('starts the evolve branch at the start point once', async () => {
    const { repo, store, head } = await repository()
    expect(await store.tip()).toBe(head)
    await writeFile(join(repo, 'README.md'), 'changed\n')
    await git(repo, 'commit', '-q', '-am', 'later')
    expect(await store.tip()).toBe(head)
  })

  it('commits the evolved directory of a candidate and advances the evolve branch to it', async () => {
    const { repo, store, head } = await repository()
    const checkout = await store.create('r0A')
    expect(checkout).toMatchObject({ name: 'r0A', branch: 'self-improve/test--r0A', base: head, evolvedDirectory: join(checkout.root, 'evolved') })
    expect(await checkout.diff()).toBe('')
    await writeFile(join(checkout.evolvedDirectory, 'AGENTS.md'), 'Plan, then work carefully.\n')
    await mkdir(join(checkout.evolvedDirectory, 'skills', 'check'), { recursive: true })
    await writeFile(join(checkout.evolvedDirectory, 'skills', 'check', 'SKILL.md'), '# Check\n')
    await writeFile(join(checkout.root, 'README.md'), 'outside the evolved directory\n')
    const diff = await checkout.diff()
    expect(diff).toContain('+Plan, then work carefully.')
    expect(diff).toContain('+++ b/evolved/skills/check/SKILL.md')
    expect(diff).not.toContain('outside the evolved directory')
    const commit = await checkout.commit('self-improve r0A: plan first')
    expect(await git(repo, 'rev-parse', 'self-improve/test--r0A')).toBe(commit)
    expect(await git(repo, 'log', '-1', '--format=%an <%ae> %s', commit)).toBe('dsh self-improve <self-improve@dsh.invalid> self-improve r0A: plan first')
    expect(await git(repo, 'show', '--name-only', '--format=', commit)).toBe('evolved/AGENTS.md\nevolved/skills/check/SKILL.md')
    await store.advance(commit)
    await store.advance(commit)
    expect(await store.tip()).toBe(commit)
    expect(await git(repo, 'rev-parse', 'main')).toBe(head)
  })

  it('refuses to move the evolve branch to a revision that does not descend from its tip', async () => {
    const { repo, store } = await repository()
    await store.tip()
    await git(repo, 'checkout', '-q', '--orphan', 'other')
    await git(repo, 'commit', '-q', '--allow-empty', '-m', 'unrelated')
    const unrelated = await git(repo, 'rev-parse', 'HEAD')
    await expect(store.advance(unrelated)).rejects.toThrow('the branch carries a revision the run never measured')
  })

  it('releases, reopens, and recreates candidate checkouts', async () => {
    const { store, head } = await repository()
    const first = await store.create('r0A')
    await writeFile(join(first.evolvedDirectory, 'AGENTS.md'), 'Draft one.\n')
    const commit = await first.commit('draft one')
    await store.release('r0A')
    await expect(access(first.root)).rejects.toMatchObject({ code: 'ENOENT' })
    await store.release('r0A')
    const reopened = await store.reopen('r0A')
    expect(reopened.base).toBe(commit)
    expect(await store.reopen('r0A')).toMatchObject({ base: commit })
    expect(await readFile(join(reopened.evolvedDirectory, 'AGENTS.md'), 'utf8')).toBe('Draft one.\n')
    const fresh = await store.create('r0A')
    expect(fresh.base).toBe(head)
    expect(await readFile(join(fresh.evolvedDirectory, 'AGENTS.md'), 'utf8')).toBe('Work carefully.\n')
    const pinned = await store.create('heldout-0', commit)
    expect(pinned.base).toBe(commit)
  })

  it('finds the repository root, ignoring an inherited repository selector', async () => {
    const { repo } = await repository()
    const outside = await mkdtemp(join(tmpdir(), 'dsh-self-improve-nogit-'))
    roots.push(outside)
    const previous = process.env['GIT_DIR']
    process.env['GIT_DIR'] = join(outside, 'elsewhere')
    try {
      expect(await repositoryRoot(run, join(repo, 'evolved'), 10_000)).toBe(repo)
    } finally {
      if (previous === undefined) delete process.env['GIT_DIR']
      else process.env['GIT_DIR'] = previous
    }
    await expect(repositoryRoot(run, outside, 10_000)).rejects.toThrow(`self-improve repository ${outside} is not inside a git repository: `)
  })

  it('refuses an evolve branch that is checked out, and reports git failures', async () => {
    const { repo, store, settings } = await repository()
    await store.tip()
    await git(repo, 'checkout', '-q', 'self-improve/test')
    await expect(store.tip()).rejects.toThrow(`self-improve evolve branch self-improve/test is checked out at ${repo}; check out another branch there`)
    await git(repo, 'checkout', '-q', 'main')
    const missing = new GitRevisionStore({ ...settings, branch: 'self-improve/other', startPoint: 'no-such-ref' })
    await expect(missing.tip()).rejects.toThrow(/^git rev-parse --verify no-such-ref\^\{commit\} failed with exit code \d+: /)
  })
})
