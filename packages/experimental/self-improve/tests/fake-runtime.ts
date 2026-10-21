import { fileURLToPath } from 'node:url'
import type { DeepSeekHarnessOptions } from '@deepseek-ai/dsh-sdk-client'
import { createProcessDeepSeekHarness } from '../../../sdk/client/src/api.ts'
import type { RuntimeProcessOptions } from '../../../sdk/client/src/launch.ts'
import { internals } from '../src/trial.ts'

const fakeRuntime = fileURLToPath(new URL('../../../sdk/client/tests/fake-runtime.ts', import.meta.url))
const createHarness = internals.createHarness.bind(internals)

/** Route trial runtimes to the SDK's scripted fake runtime and record their options; `onLaunch` sees each launch while its files exist. */
export function useFakeRuntime(
  onLaunch: (options: DeepSeekHarnessOptions) => void = () => {},
): { readonly launches: DeepSeekHarnessOptions[]; restore(): void } {
  const launches: DeepSeekHarnessOptions[] = []
  internals.createHarness = (options) => {
    launches.push(options)
    onLaunch(options)
    const runtime: RuntimeProcessOptions = {
      command: process.execPath,
      args: [fakeRuntime],
      ...options.processCwd === undefined ? {} : { cwd: options.processCwd },
      environment: () => options.env ?? process.env,
      description: 'scripted self-improve trial runtime',
      initializeTimeoutMs: 10_000,
      ...options.shutdownTimeoutMs === undefined ? {} : { shutdownTimeoutMs: options.shutdownTimeoutMs },
    }
    return createProcessDeepSeekHarness(runtime, options)
  }
  return {
    launches,
    restore: () => {
      internals.createHarness = createHarness
    },
  }
}
