import { describe, expect, it } from 'vitest'
import { classifyDiff, normalizeComponent, novelty } from '../src/components.ts'
import { componentSet } from './fixtures.ts'

describe('component set', () => {
  it('classifies a diff by its first matching signal, else the fallback', () => {
    expect(classifyDiff('+++ b/skills/review/SKILL.md\n+subagent', componentSet)).toBe('skill')
    expect(classifyDiff('+ use a subagent', componentSet)).toBe('subagent')
    expect(classifyDiff('+ be concise', componentSet)).toBe('prompt')
  })

  it('keeps a declared component only with evidence in the diff', () => {
    expect(normalizeComponent(' Skill ', '+++ b/skills/a/SKILL.md', componentSet)).toBe('skill')
    expect(normalizeComponent('subagent', '+ be concise', componentSet)).toBe('prompt')
    expect(normalizeComponent('prompt', '+ compaction ratio', componentSet)).toBe('prompt')
    expect(normalizeComponent('unknown', '+ compaction ratio', componentSet)).toBe('context_mgmt')
    expect(normalizeComponent(undefined, '+ timeoutMs: 5', componentSet)).toBe('config')
  })

  it('counts structural components the incumbent has no accepted edit on', () => {
    const counts = new Map([['skill', 1], ['subagent', 0]])
    expect(novelty(['skill', 'subagent', 'subagent', 'prompt'], counts, componentSet)).toBe(1)
    expect(novelty(['subagent'], new Map(), componentSet)).toBe(1)
    expect(novelty(['prompt'], new Map(), componentSet)).toBe(0)
  })
})
