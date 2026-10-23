import { execFile } from 'node:child_process'
import type { ProcessRunner } from '../src/process.ts'

/** A process runner over `execFile`, with system git configuration off and `undefined` overrides removing variables. */
export const execRunner: ProcessRunner = async ({ argv, cwd, timeoutMs, env = {} }) => await new Promise((resolve) => {
  const [program, ...args] = argv
  const merged = Object.fromEntries(Object.entries({ ...process.env, GIT_CONFIG_NOSYSTEM: '1', ...env }).filter(([, value]) => value !== undefined))
  execFile(program, args, { cwd, timeout: timeoutMs, env: merged }, (error, stdout, stderr) => {
    resolve({ exitCode: error === null ? 0 : typeof error.code === 'number' ? error.code : null, stdout, stderr })
  })
})
