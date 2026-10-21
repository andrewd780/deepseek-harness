import { describe, expect, it, vi } from 'vitest'
import { CREDENTIAL_PATTERNS, createCritic, criticPrompt, criticSystemPrompt, parseVerdict, precheck } from '../src/critic.ts'
import type { TextModel } from '../src/types.ts'

const domainPatterns = [{ pattern: /grader\.py/, reason: 'grader reference' }]
const request = { diff: '+++ b/AGENTS.md\n+Plan before acting.', summary: 'plan first', edits: [{ id: 'C1', component: 'prompt', hypothesis: 'h' }] }

/** Credential-shaped strings, assembled so the source holds no credential literal. */
const credentials = [
  ['AIza', 'B'.repeat(35)].join(''),
  ['sk', '-', 'a1'.repeat(12)].join(''),
  ['gh', 'p_', 'x'.repeat(36)].join(''),
  ['-----BEGIN ', 'RSA PRIVATE', ' KEY-----'].join(''),
  ['API_KEY = "', 'q'.repeat(10), '"'].join(''),
]

function scripted(...answers: string[]): TextModel & { readonly complete: ReturnType<typeof vi.fn> } {
  const complete = vi.fn(async () => answers.shift() ?? '')
  return { complete }
}

function critic(model: TextModel, maxDiffCharacters = 1_000) {
  return createCritic({ model, brief: 'Tasks are coding tasks.', patterns: domainPatterns, attempts: 3, maxDiffCharacters })
}

describe('precheck', () => {
  it('names every credential shape and domain pattern a diff matches', () => {
    expect(CREDENTIAL_PATTERNS).toHaveLength(credentials.length)
    credentials.forEach((credential, index) => {
      expect(precheck(`+${credential}`, []), `credential ${index}`).toHaveLength(1)
    })
    expect(precheck('+ read grader.py', domainPatterns)).toEqual(['grader reference'])
    expect(precheck(request.diff, domainPatterns)).toEqual([])
  })
})

describe('parseVerdict', () => {
  it('reads a whole-answer verdict or the object inside surrounding text', () => {
    expect(parseVerdict('{"verdict":"accept","reasons":["fine",3],"riskNotes":["watch"]}'))
      .toEqual({ verdict: 'accept', reasons: ['fine'], riskNotes: ['watch'] })
    expect(parseVerdict('Here is my review:\n{"verdict":"reject","reasons":["leak"]}\nDone.'))
      .toEqual({ verdict: 'reject', reasons: ['leak'], riskNotes: [] })
  })

  it('rejects answers that are not verdict objects', () => {
    for (const answer of ['', 'no json', '[1]', 'null', '{"verdict":"maybe"}', '} {', '{"verdict": accept}']) {
      expect(parseVerdict(answer), answer).toBeUndefined()
    }
  })
})

describe('critic prompts', () => {
  it('carry the domain brief and the candidate', () => {
    const system = criticSystemPrompt('Tasks are coding tasks.')
    expect(system).toContain('Tasks are coding tasks.')
    expect(system).toContain('Reply with one JSON object and nothing else')
    expect(criticSystemPrompt('')).not.toContain('\n\n\n\n')
    const prompt = criticPrompt(request)
    expect(prompt).toContain('Summary: plan first')
    expect(prompt).toContain('"component": "prompt"')
    expect(prompt).toContain('Diff:\n+++ b/AGENTS.md')
  })
})

describe('createCritic', () => {
  it('rejects deterministic matches, empty diffs, and oversized diffs without asking the model', async () => {
    const model = scripted()
    const review = critic(model, 40)
    expect(await review.review({ ...request, diff: '+ grader.py' })).toEqual({ verdict: 'reject', reasons: ['precheck: grader reference'], riskNotes: [] })
    expect((await review.review({ ...request, diff: ' \n' })).reasons).toEqual(['empty diff'])
    expect((await review.review({ ...request, diff: '+'.repeat(41) })).reasons).toEqual(['diff of 41 characters exceeds the review limit of 40'])
    expect(model.complete).not.toHaveBeenCalled()
  })

  it('returns the first parseable verdict and passes the cancellation signal', async () => {
    const model = scripted('not json', '{"verdict":"accept","reasons":[],"riskNotes":[]}')
    const signal = new AbortController().signal
    expect(await critic(model).review({ ...request, signal })).toEqual({ verdict: 'accept', reasons: [], riskNotes: [] })
    expect(model.complete).toHaveBeenCalledTimes(2)
    expect(model.complete).toHaveBeenLastCalledWith(expect.objectContaining({ signal, prompt: criticPrompt(request) }))
  })

  it('rejects after every attempt is unparseable', async () => {
    const model = scripted('one', 'two', 'three', '{"verdict":"accept"}')
    const verdict = await critic(model).review(request)
    expect(verdict).toEqual({ verdict: 'reject', reasons: ['critic answer unparseable after 3 attempt(s): three'], riskNotes: [] })
    expect(model.complete).toHaveBeenCalledTimes(3)
  })
})
