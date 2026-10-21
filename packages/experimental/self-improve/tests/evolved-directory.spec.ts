import { describe, expect, it } from 'vitest'
import { classifyDiff, normalizeComponent } from '../src/components.ts'
import { precheck } from '../src/critic.ts'
import { DSH_CRITIC_PATTERNS, DSH_COMPONENTS, taskNamePatterns } from '../src/evolved-directory.ts'

const fileDiff = (path: string, ...added: string[]): string => `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n${added.map(line => `+${line}`).join('\n')}`

describe('DSH_COMPONENTS', () => {
  it.each([
    [fileDiff('evolved/skills/review/SKILL.md', 'Check the tests.'), 'skill'],
    [fileDiff('evolved/AGENTS.md', 'Remember the plan between steps.'), 'memory'],
    [fileDiff('evolved/overlay.patch.yml', '- name: \'@deepseek-ai/dsh-tool-web\''), 'client_tool'],
    [fileDiff('evolved/AGENTS.md', 'Delegate independent searches to a subagent.'), 'subagent'],
    [fileDiff('evolved/overlay.patch.yml', '    headroomRatio: 0.3'), 'context_mgmt'],
    [fileDiff('evolved/overlay.patch.yml', '    maxResultChars: 8000'), 'output_plumbing'],
    [fileDiff('evolved/overlay.patch.yml', '    timeoutMs: 120000'), 'control_flow'],
    [fileDiff('evolved/overlay.patch.yml', '    enabled: true'), 'config'],
    [fileDiff('evolved/AGENTS.md', 'Plan before you edit.'), 'prompt'],
  ])('classifies %#', (diff, component) => {
    expect(classifyDiff(diff, DSH_COMPONENTS)).toBe(component)
  })

  it('keeps a structural label only with evidence', () => {
    expect(normalizeComponent('skill', fileDiff('evolved/AGENTS.md', 'Plan before you edit.'), DSH_COMPONENTS)).toBe('prompt')
    expect(normalizeComponent('skill', '--- a/evolved/skills/old/SKILL.md\n+++ /dev/null\n@@ -1 +0,0 @@\n-Old skill', DSH_COMPONENTS)).toBe('skill')
  })
})

describe('DSH_CRITIC_PATTERNS', () => {
  it.each([
    ['executable configuration', fileDiff('evolved/overlay.patch.yml', 'run: !!js/function "() => 1"'), 'executable configuration in the overlay'],
    ['a model route', fileDiff('evolved/overlay.patch.yml', '  model: deepseek-v4-pro'), 'changes the policy model route'],
    ['a provider row', fileDiff('evolved/overlay.patch.yml', '- name: \'@deepseek-ai/dsh-llm-pi-ai\''), 'changes the policy model route'],
    ['a permission key', fileDiff('evolved/overlay.patch.yml', '    permissionMode: danger-full-access'), 'changes permissions, the sandbox, or approvals'],
    ['a sandbox row', fileDiff('evolved/overlay.patch.yml', '- name: \'@deepseek-ai/dsh-sandbox-local\''), 'changes permissions, the sandbox, or approvals'],
    ['an endpoint', fileDiff('evolved/AGENTS.md', 'Fetch https://example.invalid/answers first.'), 'adds a remote endpoint'],
  ])('rejects %s', (_label, diff, reason) => {
    expect(precheck(diff, DSH_CRITIC_PATTERNS)).toContain(reason)
  })

  it('leaves instruction prose that mentions models and approval alone', () => {
    expect(precheck(fileDiff('evolved/AGENTS.md', 'The model should ask for approval before deleting files.'), DSH_CRITIC_PATTERNS)).toEqual([])
  })
})

describe('taskNamePatterns', () => {
  it('matches a task id as a whole word, with its punctuation escaped', () => {
    const [pattern] = taskNamePatterns(['fix.git+1'])
    expect(pattern?.reason).toBe('names suite task fix.git+1')
    expect(pattern?.pattern.test('+ when the task is fix.git+1, skip')).toBe(true)
    expect(pattern?.pattern.test('+ fixXgit+1')).toBe(false)
    expect(pattern?.pattern.test('+ prefix-fix.git+1')).toBe(false)
  })
})
