import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NotOllama, ollamaOrigin, policyBaseUrl, unloadOllamaModel } from '../src/ollama.ts'
import { standInOllama } from './ollama-server.ts'
import type { StandInOllama } from './ollama-server.ts'

const servers: StandInOllama[] = []
const roots: string[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const settings = { timeoutMs: 2000, pollMs: 10 }

async function serve(models: readonly string[]): Promise<StandInOllama> {
  const server = await standInOllama(models)
  servers.push(server)
  return server
}

describe('ollamaOrigin', () => {
  it('drops the OpenAI-compatible /v1 suffix and trailing slashes', () => {
    expect(ollamaOrigin('http://localhost:11434/v1')).toBe('http://localhost:11434')
    expect(ollamaOrigin('http://localhost:11434/v1/')).toBe('http://localhost:11434')
    expect(ollamaOrigin('http://gpu.lan/ollama/v1')).toBe('http://gpu.lan/ollama')
    expect(ollamaOrigin('http://localhost:11434')).toBe('http://localhost:11434')
  })
})

describe('policyBaseUrl', () => {
  it('reads the trials\' provider baseURL from the last llm-pi-ai entry that sets one', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-self-improve-ollama-')))
    roots.push(root)
    await writeFile(join(root, 'a.yml'), `- id: sandbox-policy
  config:
    mode: workspace-write
- id: llm-pi-ai
  config:
    providers:
      ollama:
        baseURL: http://first:11434/v1
      other:
        baseURL: http://other/v1
- id: tool-browser
  disabled: !!js process.platform !== 'darwin'
`)
    await writeFile(join(root, 'b.yml'), '- id: llm-pi-ai\n  config:\n    providers:\n      ollama:\n        baseURL: http://second:11434/v1\n- id: llm-pi-ai\n  config: {}\n')
    await writeFile(join(root, 'empty.yml'), '# nothing\n')
    expect(await policyBaseUrl([join(root, 'a.yml')], 'ollama')).toBe('http://first:11434/v1')
    expect(await policyBaseUrl([join(root, 'a.yml'), join(root, 'b.yml'), join(root, 'empty.yml')], 'ollama')).toBe('http://second:11434/v1')
    expect(await policyBaseUrl([join(root, 'a.yml')], 'deepseek')).toBeUndefined()
    expect(await policyBaseUrl([join(root, 'empty.yml')], 'ollama')).toBeUndefined()
  })
})

describe('unloadOllamaModel', () => {
  it('asks for the unload only when the model is loaded, and waits until the listing drops it', async () => {
    const server = await serve(['qwen:latest', 'other:7b'])
    const outcome = await unloadOllamaModel({ origin: server.origin, model: 'qwen' }, settings)
    expect(outcome).toEqual({ status: 'unloaded', milliseconds: expect.any(Number) as number })
    expect(server.unloads).toEqual(['qwen'])
    server.loaded.delete('qwen:latest')
    expect(await unloadOllamaModel({ origin: server.origin, model: 'qwen:latest' }, settings)).toEqual({ status: 'not-loaded' })
    expect(await unloadOllamaModel({ origin: server.origin, model: 'other:7b' }, settings)).toMatchObject({ status: 'unloaded' })
    expect(server.unloads).toEqual(['qwen', 'other:7b'])
  })

  it('reports a model still listed when the bound runs out, and fails on a refused unload or a server that is not Ollama', async () => {
    const server = await serve(['qwen:latest'])
    server.mode = 'keep-loaded'
    expect(await unloadOllamaModel({ origin: server.origin, model: 'qwen:latest' }, { timeoutMs: 50, pollMs: 10 })).toEqual({ status: 'still-loaded' })
    server.mode = 'fail-unload'
    await expect(unloadOllamaModel({ origin: server.origin, model: 'qwen:latest' }, settings)).rejects.toThrow(`POST ${server.origin}/api/generate answered 500`)
    server.mode = 'not-ollama'
    await expect(unloadOllamaModel({ origin: server.origin, model: 'qwen:latest' }, settings)).rejects.toThrow(new NotOllama(`${server.origin} does not answer /api/ps with a model listing`))
    const listing = async (): Promise<Response> => new Response(JSON.stringify({ models: 'none' }))
    await expect(unloadOllamaModel({ origin: 'http://x', model: 'm' }, settings, listing)).rejects.toThrow(NotOllama)
    expect(new NotOllama('x').name).toBe('NotOllama')
    // A listing that fails for a moment is an ordinary failure.
    server.mode = 'fail-listing'
    const failed = unloadOllamaModel({ origin: server.origin, model: 'qwen:latest' }, settings)
    await expect(failed).rejects.toThrow(`GET ${server.origin}/api/ps answered 502`)
    await expect(failed).rejects.not.toBeInstanceOf(NotOllama)
  })
})
