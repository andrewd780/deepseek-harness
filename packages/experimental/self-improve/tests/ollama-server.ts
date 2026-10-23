import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

/** How the stand-in answers. */
export type StandInMode = 'ollama' | 'fail-unload' | 'not-ollama' | 'keep-loaded'

/** A stand-in for an Ollama server's `/api/ps` and unload requests, on a random local port. */
export interface StandInOllama {
  /** The server's root URL. */
  readonly origin: string
  /** Models `/api/ps` lists. */
  readonly loaded: Set<string>
  /** Every model an unload request named, in order. */
  readonly unloads: string[]
  mode: StandInMode
  close(): Promise<void>
}

/**
 * Start a stand-in that lists `models` as loaded. After an unload, a model is listed as gone once and then loaded
 * again, as if the next trial or stage had loaded it.
 * @param models - the models listed at first.
 * @returns the running stand-in.
 */
export async function standInOllama(models: readonly string[]): Promise<StandInOllama> {
  const unloaded = new Set<string>()
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString()
    })
    request.on('end', () => {
      if (stand.mode === 'not-ollama') {
        response.writeHead(404).end('not found')
        return
      }
      if (request.method === 'GET' && request.url === '/api/ps') {
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ models: [...stand.loaded].map(name => ({ name, model: name })) }))
        // Once a listing showed an unloaded model gone, the next trial or stage loads it again.
        for (const model of unloaded) stand.loaded.add(model)
        unloaded.clear()
        return
      }
      if (request.method === 'POST' && request.url === '/api/generate') {
        const { model, keep_alive: keepAlive } = JSON.parse(body) as { readonly model: string; readonly keep_alive: number }
        if (stand.mode === 'fail-unload' || keepAlive !== 0) {
          response.writeHead(500).end('{"error":"unload failed"}')
          return
        }
        stand.unloads.push(model)
        // Like Ollama, an untagged name means the `latest` tag.
        const name = model.includes(':') ? model : `${model}:latest`
        if (stand.mode !== 'keep-loaded') {
          stand.loaded.delete(name)
          unloaded.add(name)
        }
        response.writeHead(200, { 'content-type': 'application/json' }).end('{"done":true,"done_reason":"unload"}')
        return
      }
      response.writeHead(404).end()
    })
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address() as AddressInfo
  const stand: StandInOllama = {
    origin: `http://127.0.0.1:${port}`,
    loaded: new Set(models),
    unloads: [],
    mode: 'ollama',
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
        server.closeAllConnections()
      })
    },
  }
  return stand
}
