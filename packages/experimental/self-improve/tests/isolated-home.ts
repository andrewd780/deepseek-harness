import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect } from 'vitest'

// Imported first by every spec that composes the plugin: the plugin resolves
// its Harness home from DSH_HOME when the composition names none, so no test
// reads or writes the operator's ~/.dsh.
process.env['DSH_HOME'] = mkdtempSync(join(tmpdir(), 'dsh-self-improve-home-'))

// No test may reach the operator's Ollama, which could load a model: a request
// to port 11434 is refused before it leaves the process, and the test that made
// it fails.
const blocked: string[] = []
const fetchOnline = globalThis.fetch
globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : input)
  if (url.port === '11434') {
    blocked.push(url.href)
    throw new Error(`test refused a request to ${url.href}`)
  }
  return await fetchOnline(input, init)
}

afterEach(() => {
  expect(blocked.splice(0), 'requests to port 11434').toEqual([])
})
