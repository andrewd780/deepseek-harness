import { describe, expect, it } from 'vitest'
import { DSH_OVERLAY_RULES } from '../src/evolved-directory.ts'
import { checkOverlay, describeOverlayRules } from '../src/overlay.ts'
import type { OverlayCheck } from '../src/overlay.ts'

const objections = (check: OverlayCheck): readonly string[] => (check.ok ? [] : check.objections)

describe('checkOverlay', () => {
  it('returns the entries of an overlay that sets listed keys and turns tools off', () => {
    const text = [
      '# Tuned for a 32k window.',
      '- id: compaction-basic',
      '  config:',
      '    thresholdRatio: 0.6',
      '    retainTokens: 2000',
      '- id: system-prompt',
      '  config:',
      '    personaSuffix: Check your work.',
      '    toolOrder: [read, edit]',
      '    includeRuntimeContext: false',
      '    personaPrefix: ~',
      '- id: repeat-tool-reminder',
      '  config:',
      '    thresholds: [2, 4]',
      '    include: [{ name: bash }]',
      '- id: tool-web',
      '  disabled: true',
      '',
    ].join('\n')
    expect(checkOverlay(text, DSH_OVERLAY_RULES)).toEqual({
      ok: true,
      entries: [
        { id: 'compaction-basic', config: { thresholdRatio: 0.6, retainTokens: 2000 } },
        { id: 'system-prompt', config: { personaSuffix: 'Check your work.', toolOrder: ['read', 'edit'], includeRuntimeContext: false, personaPrefix: null } },
        { id: 'repeat-tool-reminder', config: { thresholds: [2, 4], include: [{ name: 'bash' }] } },
        { id: 'tool-web', disabled: true },
      ],
    })
  })

  it.each([
    ['an empty file', ''],
    ['a comment', '# nothing tuned yet\n'],
  ])('reads %s as no entries', (_label, text) => {
    expect(checkOverlay(text, DSH_OVERLAY_RULES)).toEqual({ ok: true, entries: [] })
  })

  it.each([
    ['turning the sandbox off by id', '- id: sandbox-policy\n  config:\n    mode: danger-full-access\n', 'overlay.patch.yml entry 1 (sandbox-policy): its config cannot change; entries whose config can change: compaction-basic, tool-result-pruner, spill-policy, system-prompt, repeat-tool-reminder'],
    ['the same in flow style', '- { id: sandbox-policy, config: { mode: danger-full-access } }\n', 'overlay.patch.yml entry 1 (sandbox-policy): its config cannot change; entries whose config can change: compaction-basic, tool-result-pruner, spill-policy, system-prompt, repeat-tool-reminder'],
    ['disabling the sandbox', '- id: sandbox\n  disabled: true\n', 'overlay.patch.yml entry 1 (sandbox): only an entry whose id starts with "tool-" may be turned off, with disabled: true'],
    ['inserting a command-running plugin', '- insert:\n    - id: notes\n      name: \'@deepseek-ai/dsh-mcp-client\'\n      config: { transport: stdio, command: sh }\n', 'overlay.patch.yml entry 1 must be a map with an id'],
    ['inserting into a group', '- id: tools\n  insert: []\n', 'overlay.patch.yml entry 1 (tools) sets insert; an entry may only set config or disabled'],
    ['renaming an entry', '- id: compaction-basic\n  name: \'@deepseek-ai/dsh-mcp-client\'\n  config: { thresholdRatio: 0.5 }\n', 'overlay.patch.yml entry 1 (compaction-basic) sets name; an entry may only set config or disabled'],
    ['turning a tool back on', '- id: tool-web\n  disabled: false\n', 'overlay.patch.yml entry 1 (tool-web): only an entry whose id starts with "tool-" may be turned off, with disabled: true'],
    ['a summarization route', '- id: compaction-basic\n  config: { summarizationModel: other, thresholdRatio: 0.5 }\n', 'overlay.patch.yml entry 1 (compaction-basic): config key(s) summarizationModel cannot change; allowed: thresholdRatio, headroomTokens, retainRatio, retainTokens, maxTokens, compactionRetries, maxOverflowRetries'],
    ['a config that is not a map', '- id: spill-policy\n  config: 5\n', 'overlay.patch.yml entry 1 (spill-policy): config must be a map'],
    ['an infinite number', '- id: spill-policy\n  config: { maxInlineTokens: .inf }\n', 'overlay.patch.yml entry 1 (spill-policy): config values must be text, numbers, booleans, lists, or maps'],
    ['a YAML 1.1 date', '%YAML 1.1\n---\n- id: system-prompt\n  config:\n    personaSuffix: { since: 2001-12-14 }\n', 'overlay.patch.yml entry 1 (system-prompt): config values must be text, numbers, booleans, lists, or maps'],
    ['an entry that changes nothing', '- id: tool-web\n', 'overlay.patch.yml entry 1 (tool-web) changes nothing; set config or disabled'],
    ['an inherited property name', '- id: constructor\n  config: { thresholdRatio: 0.5 }\n', 'overlay.patch.yml entry 1 (constructor): its config cannot change; entries whose config can change: compaction-basic, tool-result-pruner, spill-policy, system-prompt, repeat-tool-reminder'],
    ['a prototype key', '- __proto__: { id: tool-web, disabled: true }\n', 'overlay.patch.yml entry 1 must be a map with an id'],
    ['an item that is not a map', '- tool-web\n', 'overlay.patch.yml entry 1 must be a map with an id'],
    ['a map at the top', 'id: tool-web\ndisabled: true\n', 'overlay.patch.yml must be a list of entries'],
    ['a core tag', '- id: system-prompt\n  config: { personaSuffix: !!str 5 }\n', 'overlay.patch.yml uses a YAML tag, anchor, or alias; write plain values'],
    ['an anchor and alias', '- &tool\n  id: tool-web\n  disabled: true\n- *tool\n', 'overlay.patch.yml uses a YAML tag, anchor, or alias; write plain values'],
  ])('rejects %s', (_label, text, objection) => {
    expect(objections(checkOverlay(text, DSH_OVERLAY_RULES))).toContain(objection)
  })

  it.each([
    ['executable configuration', '- id: spill-policy\n  config: { maxInlineTokens: !!js process.exit() }\n'],
    ['executable configuration spelled through a tag directive', '%TAG !x! tag:yaml.org,2002:\n---\n- id: spill-policy\n  config: { maxInlineTokens: !x!js process.exit() }\n'],
    ['two documents', '- id: tool-web\n  disabled: true\n---\n- id: tool-fs\n  disabled: true\n'],
    ['a repeated key', '- id: tool-web\n  id: sandbox\n  disabled: true\n'],
  ])('rejects %s as YAML that is not plain', (_label, text) => {
    const found = objections(checkOverlay(text, DSH_OVERLAY_RULES))
    expect(found.length).toBeGreaterThan(0)
    expect(found.every(objection => objection.startsWith('overlay.patch.yml is not plain YAML: ') && !objection.includes('\n'))).toBe(true)
  })

  it('reports every broken entry and returns no entries', () => {
    expect(checkOverlay('- id: tool-web\n  disabled: true\n- id: sandbox\n  disabled: true\n- id: tool-fs\n', DSH_OVERLAY_RULES)).toEqual({
      ok: false,
      objections: [
        'overlay.patch.yml entry 2 (sandbox): only an entry whose id starts with "tool-" may be turned off, with disabled: true',
        'overlay.patch.yml entry 3 (tool-fs) changes nothing; set config or disabled',
      ],
    })
  })
})

describe('describeOverlayRules', () => {
  it('states the dsh rules for the proposer', () => {
    expect(describeOverlayRules(DSH_OVERLAY_RULES)).toBe('`overlay.patch.yml` is a YAML list of entries that change the harness configuration. An entry may set `config` for one of these entries, using only the listed keys: compaction-basic (thresholdRatio, headroomTokens, retainRatio, retainTokens, maxTokens, compactionRetries, maxOverflowRetries); tool-result-pruner (thresholdChars, headChars, tailChars); spill-policy (maxInlineTokens); system-prompt (includeHarnessIdentity, includeRuntimeContext, personaPrefix, personaSuffix, toolOrder); repeat-tool-reminder (thresholds, include, exclude, argumentsPreviewChars). An entry may also turn off a tool, an entry whose id starts with "tool-", with `disabled: true`. A `config` replaces that entry\'s whole configuration. Nothing else may appear in the file, and YAML tags, anchors, and aliases are not allowed.')
  })
})
