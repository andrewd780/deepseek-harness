/**
 * Creation of the automatic mode's run: a git repository seeded from the
 * bundled starter run, with one initial commit. The repository is assembled
 * in a sibling directory and renamed into place, so a crash never leaves a
 * half-created run and an existing directory is never overwritten.
 *
 * @module @deepseek-ai/dsh-experimental-self-improve/bootstrap
 */

import { mkdir, mkdtemp, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import { GIT_IDENTITY, runGit } from './git.ts'
import type { ProcessRunner } from './process.ts'
import { starterFiles } from './template.ts'
import type { StarterRoute } from './template.ts'

/** The run spec every run repository holds at its root. */
export const RUN_SPEC_FILE = 'run.json'

/** The automatic run, found or created. */
export interface StarterRun {
  /** Whether this call created the run. */
  readonly created: boolean
  /** Absolute path of the run spec. */
  readonly spec: string
}

/** How {@link ensureStarterRun} runs git. */
export interface BootstrapGit {
  readonly run: ProcessRunner
  readonly timeoutMs: number
  readonly signal?: AbortSignal | undefined
}

/**
 * Find the run at `directory`, or create it from the starter run when nothing exists there.
 * @param directory - absolute directory of the run's repository.
 * @param route - the route and constants a new run is created with.
 * @param git - the git runner and its deadline.
 * @returns the run spec, and whether this call created the run.
 * @throws Error when `directory` exists without a run spec, or when creating the repository fails.
 */
export async function ensureStarterRun(directory: string, route: StarterRoute, git: BootstrapGit): Promise<StarterRun> {
  const spec = join(directory, RUN_SPEC_FILE)
  if (await exists(spec)) return { created: false, spec }
  if (await exists(directory) && (await readdir(directory)).length > 0) {
    throw new Error(`self-improve automatic run directory ${directory} exists without ${RUN_SPEC_FILE}; move it away or set auto.directory to another path`)
  }
  await mkdir(dirname(directory), { recursive: true, mode: 0o700 })
  const staging = await mkdtemp(join(dirname(directory), `.${basename(directory)}-creating-`))
  try {
    for (const [path, content] of starterFiles(route)) {
      await mkdir(dirname(join(staging, path)), { recursive: true })
      await writeFile(join(staging, path), content, { mode: 0o600 })
    }
    const command = async (args: readonly string[]): Promise<void> => {
      await runGit(git.run, args, staging, git.timeoutMs, git.signal)
    }
    await command(['init', '-q', '-b', 'main'])
    await command(['add', '--all'])
    await command([...GIT_IDENTITY, 'commit', '-q', '--no-verify', '-m', 'self-improve starter run'])
    await rename(staging, directory)
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }
  return { created: true, spec }
}

async function exists(path: string): Promise<boolean> {
  return await stat(path).then(() => true, () => false)
}
