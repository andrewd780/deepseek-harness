import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { applyEvolved, INSTRUCTIONS_SECTION, PATCH_SECTION, undoLatestApply, undoneCommits } from '../src/apply.ts'
import type { LiveConfiguration } from '../src/apply.ts'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** A patch layer like an operator's: comments, a `!!js` row, and ordinary rows. */
const OPERATOR_PATCH = `# Your patch layer.
- id: llm-pi-ai
  config:
    providers:
      ollama:
        baseURL: http://localhost:11434/v1
- id: tool-browser
  disabled: !!js process.platform !== 'darwin'

- insert:
    - id: self-improve
      name: '@deepseek-ai/dsh-experimental-self-improve'
`

const time = (minute: number): Date => new Date(Date.UTC(2026, 9, 23, 3, minute, 0, 0))
const stamp = (minute: number): string => time(minute).toISOString().replace(/[:.]/g, '-')

async function setup(): Promise<{ readonly root: string; readonly evolved: string; readonly live: LiveConfiguration }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-self-improve-apply-')))
  roots.push(root)
  const evolved = join(root, 'evolved')
  await mkdir(evolved)
  return { root, evolved, live: { home: join(root, 'home'), overlayPatch: join(root, 'home', 'cordis.patch.yml'), backups: join(root, 'home', 'self-improve', 'backups') } }
}

async function put(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

async function text(path: string): Promise<string | undefined> {
  return await readFile(path, 'utf8').catch(() => undefined)
}

async function manifest(directory: string): Promise<Record<string, unknown>> {
  return JSON.parse(await text(join(directory, 'manifest.json')) ?? '') as Record<string, unknown>
}

const source = (evolved: string, commit = 'abc') => ({ evolved, description: `run test at ${commit}`, commit })
const section = (markers: { readonly start: string; readonly end: string }, ...lines: string[]): string => [markers.start, ...lines, markers.end, ''].join('\n')

describe('applyEvolved', () => {
  it('writes the overlay, instructions, and skills where dsh reads them, after backing up what it replaces', async () => {
    const { evolved, live } = await setup()
    await put(live.overlayPatch, OPERATOR_PATCH)
    await put(join(live.home, 'AGENTS.md'), 'My own rules.\n')
    await put(join(evolved, 'overlay.patch.yml'), '- id: compaction-basic\n  config:\n    thresholdRatio: 0.7\n- id: tool-web-fetch\n  disabled: true\n')
    await put(join(evolved, 'AGENTS.md'), 'Run the tests before you answer.\n')
    await put(join(evolved, 'skills', 'verify', 'SKILL.md'), '---\nname: verify\n---\nCheck.\n')
    await put(join(evolved, 'skills', 'notes.md'), '---\nname: notes\n---\nTake notes.\n')
    await chmod(live.overlayPatch, 0o640)

    const result = await applyEvolved(source(evolved), live, time(0))

    const backup = join(live.backups, stamp(0))
    const overlay = ['- id: compaction-basic', '  config:', '    thresholdRatio: 0.7', '- id: tool-web-fetch', '  disabled: true']
    expect(result).toEqual({
      status: 'applied',
      backup,
      changed: [live.overlayPatch, join(live.home, 'AGENTS.md'), join(live.home, 'skills', 'notes.md'), join(live.home, 'skills', 'verify')],
      overlay: ['compaction-basic (thresholdRatio)', 'tool-web-fetch (off)'],
    })
    expect(await text(live.overlayPatch)).toBe(`${OPERATOR_PATCH}\n${section(PATCH_SECTION, ...overlay)}`)
    expect((await stat(live.overlayPatch)).mode & 0o777).toBe(0o640)
    expect(await text(join(live.home, 'AGENTS.md'))).toBe(`My own rules.\n\n${section(INSTRUCTIONS_SECTION, 'Run the tests before you answer.')}`)
    expect(await text(join(live.home, 'skills', 'verify', 'SKILL.md'))).toBe('---\nname: verify\n---\nCheck.\n')
    expect(await text(join(live.home, 'skills', 'notes.md'))).toBe('---\nname: notes\n---\nTake notes.\n')
    expect(await manifest(backup)).toEqual({
      version: 1,
      kind: 'apply',
      sequence: 1,
      createdAt: time(0).toISOString(),
      source: 'run test at abc',
      commit: 'abc',
      skills: ['notes.md', 'verify'],
      sections: [
        { path: live.overlayPatch, body: overlay },
        { path: join(live.home, 'AGENTS.md'), body: ['Run the tests before you answer.'] },
      ],
      targets: [
        { path: live.overlayPatch, kind: 'patch', existed: true, copy: 'files/0', before: null },
        { path: join(live.home, 'AGENTS.md'), kind: 'instructions', existed: true, copy: 'files/1', before: null },
        { path: join(live.home, 'skills', 'notes.md'), kind: 'tree', existed: false },
        { path: join(live.home, 'skills', 'verify'), kind: 'tree', existed: false },
      ],
    })
    expect(await text(join(backup, 'files', '0'))).toBe(OPERATOR_PATCH)
    expect(await text(join(backup, 'files', '1'))).toBe('My own rules.\n')

    expect(await applyEvolved(source(evolved), live, time(1))).toEqual({ status: 'unchanged' })
    expect(await readdir(live.backups)).toEqual([stamp(0)])
  })

  it('replaces its sections where they stand, and removes them and the skills it wrote when the result drops them', async () => {
    const { evolved, live } = await setup()
    await put(live.overlayPatch, OPERATOR_PATCH)
    await put(join(evolved, 'overlay.patch.yml'), '- id: spill-policy\n  config:\n    maxInlineTokens: 2000\n')
    await put(join(evolved, 'AGENTS.md'), 'First.\n')
    await put(join(evolved, 'skills', 'verify', 'SKILL.md'), 'v1\n')
    await applyEvolved(source(evolved), live, time(0))
    // The operator adds a row after the section and text around the instructions section.
    await writeFile(live.overlayPatch, `${await text(live.overlayPatch)}- id: agent-loop\n  config:\n    maxParallelToolCalls: 4\n`)
    await writeFile(join(live.home, 'AGENTS.md'), `Mine first.\n\n${await text(join(live.home, 'AGENTS.md'))}Mine last.\n`)

    await put(join(evolved, 'overlay.patch.yml'), '- id: spill-policy\n  config:\n    maxInlineTokens: 3000\n')
    await put(join(evolved, 'AGENTS.md'), 'Second.\n')
    expect(await applyEvolved(source(evolved), live, time(1))).toMatchObject({ status: 'applied', overlay: ['spill-policy (maxInlineTokens)'] })
    const spill3000 = section(PATCH_SECTION, '- id: spill-policy', '  config:', '    maxInlineTokens: 3000')
    expect(await text(live.overlayPatch)).toBe(`${OPERATOR_PATCH}\n${spill3000}- id: agent-loop\n  config:\n    maxParallelToolCalls: 4\n`)
    expect(await text(join(live.home, 'AGENTS.md'))).toBe(`Mine first.\n\n${section(INSTRUCTIONS_SECTION, 'Second.')}Mine last.\n`)

    await rm(join(evolved, 'overlay.patch.yml'))
    await rm(join(evolved, 'AGENTS.md'))
    await rm(join(evolved, 'skills'), { recursive: true })
    expect(await applyEvolved(source(evolved), live, time(2))).toEqual({
      status: 'applied',
      backup: join(live.backups, stamp(2)),
      changed: [live.overlayPatch, join(live.home, 'AGENTS.md'), join(live.home, 'skills', 'verify')],
      overlay: [],
    })
    expect(await text(live.overlayPatch)).toBe(`${OPERATOR_PATCH}\n- id: agent-loop\n  config:\n    maxParallelToolCalls: 4\n`)
    expect(await text(join(live.home, 'AGENTS.md'))).toBe('Mine first.\n\nMine last.\n')
    expect(await text(join(live.home, 'skills', 'verify', 'SKILL.md'))).toBeUndefined()
  })

  it('creates files that do not exist, keeps the empty-list template valid, and deletes an instructions file it alone filled', async () => {
    const { evolved, live } = await setup()
    await put(join(evolved, 'overlay.patch.yml'), '# no entries yet\n')
    await put(join(evolved, 'AGENTS.md'), '   \n')
    expect(await applyEvolved(source(evolved), live, time(0))).toEqual({ status: 'unchanged' })

    await put(live.overlayPatch, '# Your patch layer.\n[]\n')
    await put(join(evolved, 'overlay.patch.yml'), '- id: system-prompt\n  config:\n    personaSuffix: Be brief.\n')
    await put(join(evolved, 'AGENTS.md'), 'Be brief.\n')
    await applyEvolved(source(evolved), live, time(1))
    expect(await text(live.overlayPatch)).toBe(`# Your patch layer.\n\n${section(PATCH_SECTION, '- id: system-prompt', '  config:', '    personaSuffix: Be brief.')}`)
    expect(parse(await text(live.overlayPatch) ?? '')).toEqual([{ id: 'system-prompt', config: { personaSuffix: 'Be brief.' } }])
    expect(await text(join(live.home, 'AGENTS.md'))).toBe(section(INSTRUCTIONS_SECTION, 'Be brief.'))

    await rm(join(evolved, 'overlay.patch.yml'))
    await rm(join(evolved, 'AGENTS.md'))
    await applyEvolved(source(evolved), live, time(2))
    expect(await text(live.overlayPatch)).toBe('# Your patch layer.\n[]\n')
    expect(await text(join(live.home, 'AGENTS.md'))).toBeUndefined()

    await writeFile(live.overlayPatch, '')
    await put(join(evolved, 'overlay.patch.yml'), '- id: spill-policy\n  config:\n    maxInlineTokens: 10\n')
    await applyEvolved(source(evolved), live, time(3))
    expect(await text(live.overlayPatch)).toBe(section(PATCH_SECTION, '- id: spill-policy', '  config:', '    maxInlineTokens: 10'))
  })

  it('writes through symbolic links and keeps them links', async () => {
    const { root, evolved, live } = await setup()
    await put(join(root, 'dotfiles', 'AGENTS.md'), 'Mine.\n')
    await mkdir(live.home, { recursive: true })
    await symlink(join(root, 'dotfiles', 'AGENTS.md'), join(live.home, 'AGENTS.md'))
    await put(join(evolved, 'AGENTS.md'), 'Theirs.\n')
    expect(await applyEvolved(source(evolved), live, time(0))).toMatchObject({ changed: [join(root, 'dotfiles', 'AGENTS.md')] })
    expect((await lstat(join(live.home, 'AGENTS.md'))).isSymbolicLink()).toBe(true)
    expect(await text(join(root, 'dotfiles', 'AGENTS.md'))).toBe(`Mine.\n\n${section(INSTRUCTIONS_SECTION, 'Theirs.')}`)
    await undoLatestApply(live, time(1))
    expect(await text(join(root, 'dotfiles', 'AGENTS.md'))).toBe('Mine.\n')
    expect((await lstat(join(live.home, 'AGENTS.md'))).isSymbolicLink()).toBe(true)
  })

  it('refuses the whole apply when the result holds what the overlay rules or the evolved directory never allow', async () => {
    const { evolved, live } = await setup()
    await put(live.overlayPatch, OPERATOR_PATCH)
    await put(join(evolved, 'AGENTS.md'), 'Fine.\n')
    const refused = async (message: RegExp | string): Promise<void> => {
      await expect(applyEvolved(source(evolved), live, time(0))).rejects.toThrow(message)
      expect(await text(live.overlayPatch)).toBe(OPERATOR_PATCH)
      expect(await text(join(live.home, 'AGENTS.md'))).toBeUndefined()
      expect(await readdir(live.backups).catch(() => [])).toEqual([])
    }
    for (const [overlay, message] of [
      ['- id: sandbox-policy\n  config:\n    mode: danger-full-access\n', /^self-improve apply refused: overlay\.patch\.yml entry 1 \(sandbox-policy\): its config cannot change/],
      ['- insert:\n    - name: \'@evil/plugin\'\n', /^self-improve apply refused: overlay\.patch\.yml entry 1 must be a map with an id/],
      ['- id: compaction-basic\n  config:\n    command: rm -rf /\n', /config key\(s\) command cannot change/],
      ['- id: agent-loop\n  disabled: true\n', /only an entry whose id starts with "tool-" may be turned off/],
      ['- id: tool-x\n  disabled: !!js true\n', /overlay\.patch\.yml is not plain YAML: Unresolved tag: tag:yaml\.org,2002:js/],
      ['- id: tool-x\n  disabled: &on true\n', /uses a YAML tag, anchor, or alias/],
    ] as const) {
      await put(join(evolved, 'overlay.patch.yml'), overlay)
      await refused(message)
    }
    await rm(join(evolved, 'overlay.patch.yml'))
    await put(join(evolved, 'skills', 'run', 'run.sh'), '#!/bin/sh\n')
    await refused(/^self-improve apply refused: skills\/run\/run\.sh is not a regular file with one of the extensions \.md, \.yml/)
    await rm(join(evolved, 'skills', 'run', 'run.sh'))
    await symlink('/etc/hosts', join(evolved, 'skills', 'run', 'SKILL.md'))
    await refused(/^self-improve apply refused: skills\/run\/SKILL\.md is not a regular file/)
    await rm(join(evolved, 'skills'), { recursive: true })
    await put(join(evolved, 'skills', 'mine', 'SKILL.md'), 'theirs\n')
    await put(join(live.home, 'skills', 'mine', 'SKILL.md'), 'mine\n')
    await refused(`self-improve apply refused: ${join(live.home, 'skills', 'mine')} exists and no apply wrote it; rename the skill or move it away`)
    expect(await text(join(live.home, 'skills', 'mine', 'SKILL.md'))).toBe('mine\n')
    await rm(join(evolved, 'skills'), { recursive: true })
    await rm(join(evolved, 'AGENTS.md'))
    await mkdir(join(evolved, 'AGENTS.md'))
    await expect(applyEvolved(source(evolved), live, time(0))).rejects.toThrow(`self-improve apply refused: ${join(evolved, 'AGENTS.md')} is not a regular file`)
  })

  it('refuses to replace a section someone else wrote or edited, a damaged section, or a patch that would stop being a list', async () => {
    const { evolved, live } = await setup()
    await put(join(evolved, 'overlay.patch.yml'), '- id: spill-policy\n  config:\n    maxInlineTokens: 10\n')
    await applyEvolved(source(evolved), live, time(0))
    // dsh's plugin manager adds rows at the end of a patch, which lands them inside the section.
    await writeFile(live.overlayPatch, (await text(live.overlayPatch) ?? '').replace(PATCH_SECTION.end, `- id: some-plugin\n  disabled: false\n${PATCH_SECTION.end}`))
    await put(join(evolved, 'overlay.patch.yml'), '- id: spill-policy\n  config:\n    maxInlineTokens: 20\n')
    const changed = `self-improve apply refused: the self-improve section of ${live.overlayPatch} changed since the newest apply wrote it; move your own lines out of it, or restore it with /self-improve undo`
    await expect(applyEvolved(source(evolved), live, time(1))).rejects.toThrow(changed)
    expect(await text(live.overlayPatch)).toContain('- id: some-plugin')
    await put(join(live.home, 'AGENTS.md'), section(INSTRUCTIONS_SECTION, 'copied from elsewhere'))
    await rm(live.overlayPatch)
    await expect(applyEvolved(source(evolved), live, time(1))).rejects.toThrow(`the self-improve section of ${join(live.home, 'AGENTS.md')} changed since the newest apply wrote it`)
    await rm(join(live.home, 'AGENTS.md'))
    await put(live.overlayPatch, `${PATCH_SECTION.start}\n- id: spill-policy\n`)
    await expect(applyEvolved(source(evolved), live, time(1))).rejects.toThrow(`self-improve apply refused: ${live.overlayPatch} has a damaged self-improve section`)
    await put(live.overlayPatch, `${PATCH_SECTION.end}\n${PATCH_SECTION.start}\n`)
    await expect(applyEvolved(source(evolved), live, time(1))).rejects.toThrow('has a damaged self-improve section')
    await put(live.overlayPatch, 'providers:\n  ollama: {}\n')
    await expect(applyEvolved(source(evolved), live, time(1))).rejects.toThrow(`self-improve apply refused: adding the overlay entries would leave ${live.overlayPatch} not a YAML list of entries; add them by hand:\n- id: spill-policy`)
  })

  it('propagates filesystem failures other than absence', async () => {
    const { root, evolved, live } = await setup()
    await mkdir(live.overlayPatch, { recursive: true })
    await expect(applyEvolved(source(evolved), live, time(0))).rejects.toThrow(/EISDIR/)
    await rm(live.overlayPatch, { recursive: true })
    await writeFile(join(root, 'not-a-directory'), '')
    await expect(applyEvolved(source(join(root, 'not-a-directory')), live, time(0))).rejects.toThrow(/ENOTDIR/)
  })

  it('gives two backups of the same millisecond different directories', async () => {
    const { evolved, live } = await setup()
    for (const content of ['one\n', 'two\n', 'three\n']) {
      await put(join(evolved, 'AGENTS.md'), content)
      await applyEvolved(source(evolved), live, time(0))
    }
    expect(await readdir(live.backups)).toEqual([stamp(0), `${stamp(0)}-2`, `${stamp(0)}-3`])
  })
})

describe('undoLatestApply', () => {
  it('reverses the newest apply, keeps what the operator wrote since, and walks back one apply per call', async () => {
    const { evolved, live } = await setup()
    await put(live.overlayPatch, OPERATOR_PATCH)
    await put(join(live.home, 'skills', 'mine', 'SKILL.md'), 'mine\n')
    await put(join(evolved, 'overlay.patch.yml'), '- id: spill-policy\n  config:\n    maxInlineTokens: 10\n')
    await put(join(evolved, 'skills', 'verify', 'SKILL.md'), 'v1\n')
    await applyEvolved(source(evolved, 'first'), live, time(0))
    const afterFirst = await text(live.overlayPatch)
    await put(join(evolved, 'skills', 'verify', 'SKILL.md'), 'v2\n')
    await put(join(evolved, 'AGENTS.md'), 'New rule.\n')
    await applyEvolved(source(evolved, 'second'), live, time(1))
    // The operator edits outside the sections after the apply; undo keeps those edits.
    await writeFile(live.overlayPatch, `${afterFirst}- id: agent-loop\n  disabled: true\n`)

    const undone = await undoLatestApply(live, time(2))
    expect(undone).toEqual({
      backup: join(live.backups, stamp(1)),
      snapshot: join(live.backups, `${stamp(2)}-undo`),
      restored: [join(live.home, 'AGENTS.md'), join(live.home, 'skills', 'verify')],
      commit: 'second',
    })
    expect(await text(join(live.home, 'AGENTS.md'))).toBeUndefined()
    expect(await text(join(live.home, 'skills', 'verify', 'SKILL.md'))).toBe('v1\n')
    expect(await text(live.overlayPatch)).toBe(`${afterFirst}- id: agent-loop\n  disabled: true\n`)
    expect(await manifest(undone.snapshot)).toMatchObject({ kind: 'undo', sequence: 3, commit: null, skills: [], sections: [], targets: [{ existed: true }, { existed: true }] })
    expect(await manifest(undone.backup)).toMatchObject({ undoneAt: time(2).toISOString() })
    expect(await undoneCommits(live)).toEqual(new Set(['second']))

    expect(await undoLatestApply(live, time(3))).toMatchObject({ backup: join(live.backups, stamp(0)), commit: 'first' })
    expect(await text(live.overlayPatch)).toBe(`${OPERATOR_PATCH}\n- id: agent-loop\n  disabled: true\n`)
    expect(await text(join(live.home, 'skills', 'verify', 'SKILL.md'))).toBeUndefined()
    expect(await text(join(live.home, 'skills', 'mine', 'SKILL.md'))).toBe('mine\n')
    expect(await undoneCommits(live)).toEqual(new Set(['first', 'second']))
    await expect(undoLatestApply(live, time(4))).rejects.toThrow('self-improve has no applied change to undo')

    await applyEvolved(source(evolved, 'second'), live, time(5))
    expect(await undoneCommits(live)).toEqual(new Set(['first']))
  })

  it('deletes a patch layer the apply created unless the operator wrote into it since', async () => {
    const { evolved, live } = await setup()
    await put(join(evolved, 'overlay.patch.yml'), '- id: spill-policy\n  config:\n    maxInlineTokens: 10\n')
    await applyEvolved(source(evolved), live, time(0))
    await undoLatestApply(live, time(1))
    expect(await text(live.overlayPatch)).toBeUndefined()
    await applyEvolved(source(evolved), live, time(2))
    await writeFile(live.overlayPatch, `- id: mine\n  disabled: true\n\n${await text(live.overlayPatch)}`)
    await undoLatestApply(live, time(3))
    expect(await text(live.overlayPatch)).toBe('- id: mine\n  disabled: true\n')
  })

  it('orders applies by sequence, not by the clock', async () => {
    const { evolved, live } = await setup()
    await put(join(evolved, 'AGENTS.md'), 'later clock\n')
    await applyEvolved(source(evolved, 'a'), live, time(30))
    await put(join(evolved, 'AGENTS.md'), 'clock set back\n')
    await applyEvolved(source(evolved, 'b'), live, time(10))
    expect(await undoLatestApply(live, time(11))).toMatchObject({ commit: 'b' })
    expect(await text(join(live.home, 'AGENTS.md'))).toBe(section(INSTRUCTIONS_SECTION, 'later clock'))
  })

  it('skips an interrupted backup and refuses an invalid manifest', async () => {
    const { live } = await setup()
    await expect(undoLatestApply(live, time(0))).rejects.toThrow('self-improve has no applied change to undo')
    await mkdir(join(live.backups, stamp(0)), { recursive: true })
    await expect(undoLatestApply(live, time(0))).rejects.toThrow('self-improve has no applied change to undo')
    const path = join(live.backups, stamp(5), 'manifest.json')
    await put(path, 'not json')
    await expect(undoLatestApply(live, time(0))).rejects.toThrow(`${path} is not JSON`)
    const valid = { version: 1, kind: 'apply', sequence: 1, createdAt: 'x', source: 's', commit: null, skills: [], sections: [], targets: [] }
    const target = { path: 'p', kind: 'tree', existed: false }
    for (const invalid of [
      [],
      { ...valid, version: 2 },
      { ...valid, kind: 'other' },
      { ...valid, sequence: '1' },
      { ...valid, sequence: 1.5 },
      { ...valid, createdAt: 1 },
      { ...valid, source: 1 },
      { ...valid, commit: 1 },
      { ...valid, skills: [1] },
      { ...valid, skills: 'a' },
      { ...valid, sections: 'a' },
      { ...valid, sections: [{ path: 'p', body: [1] }] },
      { ...valid, sections: [{ path: 1, body: null }] },
      { ...valid, sections: [null] },
      { ...valid, targets: 'a' },
      { ...valid, targets: [{ ...target, existed: true }] },
      { ...valid, targets: [{ ...target, copy: 'files/0' }] },
      { ...valid, targets: [{ ...target, path: 1 }] },
      { ...valid, targets: [{ ...target, existed: 'no' }] },
      { ...valid, targets: [{ ...target, before: null }] },
      { ...valid, targets: [{ ...target, kind: 'patch' }] },
      { ...valid, targets: [{ ...target, kind: 'other', before: null }] },
      { ...valid, targets: [null] },
      { ...valid, undoneAt: 1 },
    ]) {
      await writeFile(path, JSON.stringify(invalid))
      await expect(undoLatestApply(live, time(0))).rejects.toThrow(`${path} is not a self-improve backup manifest`)
    }
    await writeFile(path, JSON.stringify({ ...valid, kind: 'undo', targets: [{ ...target, kind: 'instructions', before: ['x'] }] }))
    await expect(undoLatestApply(live, time(0))).rejects.toThrow('self-improve has no applied change to undo')
    expect(await undoneCommits(live)).toEqual(new Set())
  })
})
