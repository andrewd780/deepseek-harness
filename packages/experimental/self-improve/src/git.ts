/**
 * The revision store of a run in the operator's git repository: the evolve
 * branch holds every accepted incumbent, and each candidate is a branch with
 * its own linked checkout under the run directory.
 *
 * Git runs with repository hooks disabled and inherited repository selectors
 * cleared, so an enclosing hook's `GIT_DIR` cannot redirect it. The evolve branch must not be
 * checked out anywhere, because advancing it rewrites the ref alone; a
 * checked-out evolve branch is refused. Candidate commits carry a fixed
 * identity naming the run as their author.
 *
 * @module @deepseek-ai/dsh-experimental-self-improve/git
 */

import { rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

import type { ProcessRunner } from './process.ts'
import type { CandidateCheckout, RevisionStore } from './types.ts'

/** Where a run's revisions live. */
export interface GitStoreSettings {
  /** Absolute root of the repository holding the evolved directory. */
  readonly repository: string
  /** The evolve branch; candidate branches are named `<branch>--<candidate>`. */
  readonly branch: string
  /** The commit the evolve branch starts from when it does not exist yet. */
  readonly startPoint: string
  /** Absolute directory of the run's candidate checkouts. */
  readonly checkouts: string
  /** The evolved directory's path relative to the repository root. */
  readonly evolvedDirectory: string
  readonly run: ProcessRunner
  /** Deadline of one git command. */
  readonly timeoutMs: number
}

const IDENTITY = ['-c', 'user.name=dsh self-improve', '-c', 'user.email=self-improve@dsh.invalid'] as const

/** Clear inherited repository and command-line configuration selectors, and never prompt. */
const GIT_ENV: NodeJS.ProcessEnv = {
  ...Object.fromEntries([
    'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT',
    'GIT_CEILING_DIRECTORIES', 'GIT_PREFIX', 'GIT_SHALLOW_FILE', 'GIT_GRAFT_FILE',
    'GIT_REPLACE_REF_BASE', 'GIT_ATTR_SOURCE',
  ].map(key => [key, undefined])),
  GIT_TERMINAL_PROMPT: '0',
  GIT_LFS_SKIP_SMUDGE: '1',
}

/**
 * The root of the repository that contains a directory.
 * @param run - the git runner.
 * @param directory - a directory inside the repository.
 * @param timeoutMs - the command's deadline.
 * @param signal - cancellation.
 * @returns the absolute repository root.
 * @throws Error when the directory is not inside a git repository.
 */
export async function repositoryRoot(run: ProcessRunner, directory: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  const result = await run({ argv: ['git', 'rev-parse', '--show-toplevel'], cwd: directory, timeoutMs, signal, env: GIT_ENV })
  if (result.exitCode !== 0) throw new Error(`self-improve repository ${directory} is not inside a git repository: ${result.stderr.trim()}`)
  return result.stdout.trim()
}

/** A revision store over git branches and linked checkouts. */
export class GitRevisionStore implements RevisionStore {
  /**
   * @param settings - the repository, branches, checkout directory, evolved directory, and git runner.
   */
  constructor(private readonly settings: GitStoreSettings) {}

  async tip(signal?: AbortSignal): Promise<string> {
    await this.refuseCheckedOut(signal)
    const ref = `refs/heads/${this.settings.branch}`
    const existing = await this.git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], this.settings.repository, signal, true)
    if (existing.exitCode === 0) return existing.stdout.trim()
    const start = (await this.git(['rev-parse', '--verify', `${this.settings.startPoint}^{commit}`], this.settings.repository, signal)).stdout.trim()
    await this.git(['update-ref', ref, start, ''], this.settings.repository, signal)
    return start
  }

  async advance(commit: string, signal?: AbortSignal): Promise<void> {
    const tip = await this.tip(signal)
    if (tip === commit) return
    const ancestor = await this.git(['merge-base', '--is-ancestor', tip, commit], this.settings.repository, signal, true)
    if (ancestor.exitCode !== 0) {
      throw new Error(`self-improve evolve branch ${this.settings.branch} is at ${tip}, which ${commit} does not descend from: `
        + 'the branch carries a revision the run never measured')
    }
    await this.git(['update-ref', `refs/heads/${this.settings.branch}`, commit, tip], this.settings.repository, signal)
  }

  async create(name: string, from?: string, signal?: AbortSignal): Promise<CandidateCheckout> {
    const start = from ?? await this.tip(signal)
    await this.release(name, signal)
    await this.git(['branch', '-D', this.branchOf(name)], this.settings.repository, signal, true)
    await this.git(['worktree', 'add', '-b', this.branchOf(name), this.pathOf(name), start], this.settings.repository, signal)
    return await this.checkout(name, signal)
  }

  async reopen(name: string, signal?: AbortSignal): Promise<CandidateCheckout> {
    if (!await exists(this.pathOf(name))) {
      await this.git(['worktree', 'add', this.pathOf(name), this.branchOf(name)], this.settings.repository, signal)
    }
    return await this.checkout(name, signal)
  }

  async release(name: string, signal?: AbortSignal): Promise<void> {
    await this.git(['worktree', 'remove', '--force', this.pathOf(name)], this.settings.repository, signal, true)
    await rm(this.pathOf(name), { recursive: true, force: true })
    await this.git(['worktree', 'prune'], this.settings.repository, signal)
  }

  private async checkout(name: string, signal: AbortSignal | undefined): Promise<CandidateCheckout> {
    const root = this.pathOf(name)
    const evolved = this.settings.evolvedDirectory
    const base = (await this.git(['rev-parse', 'HEAD'], root, signal)).stdout.trim()
    return {
      name,
      branch: this.branchOf(name),
      base,
      root,
      evolvedDirectory: join(root, evolved),
      diff: async (diffSignal?: AbortSignal) => {
        await this.git(['add', '--all', '--', evolved], root, diffSignal)
        return (await this.git(['diff', '--cached', '--no-color', '--no-ext-diff', 'HEAD', '--', evolved], root, diffSignal)).stdout
      },
      commit: async (message: string, commitSignal?: AbortSignal) => {
        await this.git(['add', '--all', '--', evolved], root, commitSignal)
        await this.git([...IDENTITY, 'commit', '--no-verify', '-m', message], root, commitSignal)
        return (await this.git(['rev-parse', 'HEAD'], root, commitSignal)).stdout.trim()
      },
    }
  }

  private async refuseCheckedOut(signal: AbortSignal | undefined): Promise<void> {
    const listing = (await this.git(['worktree', 'list', '--porcelain'], this.settings.repository, signal)).stdout
    const ref = `branch refs/heads/${this.settings.branch}`
    const blocks = listing.split('\n\n')
    const holder = blocks.find(block => block.split('\n').includes(ref))
    if (holder !== undefined) {
      const path = holder.slice('worktree '.length, holder.indexOf('\n'))
      throw new Error(`self-improve evolve branch ${this.settings.branch} is checked out at ${path}; check out another branch there`)
    }
  }

  private branchOf(name: string): string {
    return `${this.settings.branch}--${name}`
  }

  private pathOf(name: string): string {
    return join(this.settings.checkouts, name)
  }

  private async git(
    args: readonly string[],
    cwd: string,
    signal: AbortSignal | undefined,
    allowFailure = false,
  ): Promise<{ readonly exitCode: number | null; readonly stdout: string }> {
    const result = await this.settings.run({
      argv: ['git', '-c', 'core.hooksPath=/dev/null', ...args],
      cwd,
      timeoutMs: this.settings.timeoutMs,
      signal,
      env: GIT_ENV,
    })
    if (!allowFailure && result.exitCode !== 0) {
      throw new Error(`git ${args.join(' ')} failed with exit code ${result.exitCode}: ${result.stderr.trim()}`)
    }
    return result
  }
}

async function exists(path: string): Promise<boolean> {
  return await stat(path).then(() => true, () => false)
}
