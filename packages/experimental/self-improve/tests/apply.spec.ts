import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { applyEvolved, INSTRUCTIONS_SECTION, PATCH_SECTION, undoLatestApply } from '../src/apply.ts'
import type { LiveConfiguration } from '../src/apply.ts'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** The patch Andrew's profiles carry: comments, a `!!js` row, and ordinary rows. */
const PROFILE_PATCH = `# Your patch layer for this dsh profile.
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

async function setup(): Promise<{ readonly root: string; readonly evolved: string; readonly live: LiveConfiguration }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-self-improve-apply-')))
  roots.push(root)
  const evolved = join(root, 'evolved')
  await mkdir(evolved)
  return { root, evolved, live: { home: join(root, 'home'), profilePatch: join(root, 'home', 'profiles', 'desktop', 'cordis.patch.yml'), backups: join(root, 'home', 'self-improve', 'backups') } }
}

async function put(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

async function text(path: string): Promise<string | undefined> {
  return await readFile(path, 'utf8').catch(() => undefined)
}

const source = (evolved: string) => ({ evolved, description: 'run test at abc' })

describe('applyEvolved', () => {
  it('writes the overlay, instructions, and skills where dsh reads them, after backing up what it replaces', async () => {
    const { evolved, live } = await setup()
    await put(live.profilePatch, PROFILE_PATCH)
    await put(join(live.home, 'AGENTS.md'), 'My own rules.\n')
    await put(join(evolved, 'overlay.patch.yml'), '- id: compaction-basic\n  config:\n    thresholdRatio: 0.7\n- id: tool-web-fetch\n  disabled: true\n')
    await put(join(evolved, 'AGENTS.md'), 'Run the tests before you answer.\n')
    await put(join(evolved, 'skills', 'verify', 'SKILL.md'), '---\nname: verify\n---\nCheck.\n')
    await put(join(evolved, 'skills', 'notes.md'), '---\nname: notes\n---\nTake notes.\n')
    await chmod(live.profilePatch, 0o640)

    const result = await applyEvolved(source(evolved), live, time(0))

    const backup = join(live.backups, '2026-10-23T03-00-00-000Z')
    expect(result).toEqual({
      status: 'applied',
      backup,
      changed: [live.profilePatch, join(live.home, 'AGENTS.md'), join(live.home, 'skills', 'notes.md'), join(live.home, 'skills', 'verify')],
    })
    expect(await text(live.profilePatch)).toBe(`${PROFILE_PATCH}\n${PATCH_SECTION.start}\n- id: compaction-basic\n  config:\n    thresholdRatio: 0.7\n- id: tool-web-fetch\n  disabled: true\n${PATCH_SECTION.end}\n`)
    expect((await stat(live.profilePatch)).mode & 0o777).toBe(0o640)
    expect(await text(join(live.home, 'AGENTS.md'))).toBe(`My own rules.\n\n${INSTRUCTIONS_SECTION.start}\nRun the tests before you answer.\n${INSTRUCTIONS_SECTION.end}\n`)
    expect(await text(join(live.home, 'skills', 'verify', 'SKILL.md'))).toBe('---\nname: verify\n---\nCheck.\n')
    expect(await text(join(live.home, 'skills', 'notes.md'))).toBe('---\nname: notes\n---\nTake notes.\n')
    expect(JSON.parse(await text(join(backup, 'manifest.json')) ?? '')).toEqual({
      version: 1,
      kind: 'apply',
      createdAt: '2026-10-23T03:00:00.000Z',
      source: 'run test at abc',
      skills: ['notes.md', 'verify'],
      targets: [
        { path: live.profilePatch, existed: true, copy: 'files/0' },
        { path: join(live.home, 'AGENTS.md'), existed: true, copy: 'files/1' },
        { path: join(live.home, 'skills', 'notes.md'), existed: false },
        { path: join(live.home, 'skills', 'verify'), existed: false },
      ],
    })
    expect(await text(join(backup, 'files', '0'))).toBe(PROFILE_PATCH)
    expect(await text(join(backup, 'files', '1'))).toBe('My own rules.\n')

    expect(await applyEvolved(source(evolved), live, time(1))).toEqual({ status: 'unchanged' })
    expect(await readdir(live.backups)).toEqual(['2026-10-23T03-00-00-000Z'])
  })

  it('replaces its sections where they stand, and removes them and the skills it wrote when the result drops them', async () => {
    const { evolved, live } = await setup()
    await put(live.profilePatch, PROFILE_PATCH)
    await put(join(evolved, 'overlay.patch.yml'), '- id: spill-policy\n  config:\n    maxInlineTokens: 2000\n')
    await put(join(evolved, 'AGENTS.md'), 'First.\n')
    await put(join(evolved, 'skills', 'verify', 'SKILL.md'), 'v1\n')
    await applyEvolved(source(evolved), live, time(0))
    // The operator adds a row after the section and text after the instructions section.
    await writeFile(live.profilePatch, `${await text(live.profilePatch)}- id: agent-loop\n  config:\n    maxParallelToolCalls: 4\n`)
    await writeFile(join(live.home, 'AGENTS.md'), `Mine first.\n\n${await text(join(live.home, 'AGENTS.md'))}Mine last.\n`)

    await put(join(evolved, 'overlay.patch.yml'), '- id: spill-policy\n  config:\n    maxInlineTokens: 3000\n')
    await put(join(evolved, 'AGENTS.md'), 'Second.\n')
    expect(await applyEvolved(source(evolved), live, time(1))).toMatchObject({ status: 'applied' })
    expect(await text(live.profilePatch)).toBe(`${PROFILE_PATCH}\n${PATCH_SECTION.start}\n- id: spill-policy\n  config:\n    maxInlineTokens: 3000\n${PATCH_SECTION.end}\n- id: agent-loop\n  config:\n    maxParallelToolCalls: 4\n`)
    expect(await text(join(live.home, 'AGENTS.md'))).toBe(`Mine first.\n\n${INSTRUCTIONS_SECTION.start}\nSecond.\n${INSTRUCTIONS_SECTION.end}\nMine last.\n`)

    await rm(join(evolved, 'overlay.patch.yml'))
    await rm(join(evolved, 'AGENTS.md'))
    await rm(join(evolved, 'skills'), { recursive: true })
    const dropped = await applyEvolved(source(evolved), live, time(2))
    expect(dropped).toEqual({ status: 'applied', backup: join(live.backups, '2026-10-23T03-02-00-000Z'), changed: [live.profilePatch, join(live.home, 'AGENTS.md'), join(live.home, 'skills', 'verify')] })
    expect(await text(live.profilePatch)).toBe(`${PROFILE_PATCH}\n- id: agent-loop\n  config:\n    maxParallelToolCalls: 4\n`)
    expect(await text(join(live.home, 'AGENTS.md'))).toBe('Mine first.\n\nMine last.\n')
    expect(await text(join(live.home, 'skills', 'verify', 'SKILL.md'))).toBeUndefined()
  })

  it('creates files that do not exist, keeps the empty-list template valid, and deletes an instructions file it alone filled', async () => {
    const { evolved, live } = await setup()
    await put(join(evolved, 'overlay.patch.yml'), '# no entries yet\n')
    await put(join(evolved, 'AGENTS.md'), '   \n')
    expect(await applyEvolved(source(evolved), live, time(0))).toEqual({ status: 'unchanged' })

    await put(live.profilePatch, '# Your patch layer.\n[]\n')
    await put(join(evolved, 'overlay.patch.yml'), '- id: system-prompt\n  config:\n    personaSuffix: Be brief.\n')
    await put(join(evolved, 'AGENTS.md'), 'Be brief.\n')
    await applyEvolved(source(evolved), live, time(1))
    expect(await text(live.profilePatch)).toBe(`# Your patch layer.\n\n${PATCH_SECTION.start}\n- id: system-prompt\n  config:\n    personaSuffix: Be brief.\n${PATCH_SECTION.end}\n`)
    expect(parse(await text(live.profilePatch) ?? '')).toEqual([{ id: 'system-prompt', config: { personaSuffix: 'Be brief.' } }])
    expect(await text(join(live.home, 'AGENTS.md'))).toBe(`${INSTRUCTIONS_SECTION.start}\nBe brief.\n${INSTRUCTIONS_SECTION.end}\n`)

    await rm(join(evolved, 'overlay.patch.yml'))
    await rm(join(evolved, 'AGENTS.md'))
    await applyEvolved(source(evolved), live, time(2))
    expect(await text(live.profilePatch)).toBe('# Your patch layer.\n[]\n')
    expect(await text(join(live.home, 'AGENTS.md'))).toBeUndefined()

    await writeFile(live.profilePatch, '')
    await put(join(evolved, 'overlay.patch.yml'), '- id: spill-policy\n  config:\n    maxInlineTokens: 10\n')
    await applyEvolved(source(evolved), live, time(3))
    expect(await text(live.profilePatch)).toBe(`${PATCH_SECTION.start}\n- id: spill-policy\n  config:\n    maxInlineTokens: 10\n${PATCH_SECTION.end}\n`)
  })

  it('refuses the whole apply when the result holds what the overlay rules or the evolved directory never allow', async () => {
    const { evolved, live } = await setup()
    await put(live.profilePatch, PROFILE_PATCH)
    await put(join(evolved, 'AGENTS.md'), 'Fine.\n')
    const refused = async (message: RegExp): Promise<void> => {
      await expect(applyEvolved(source(evolved), live, time(0))).rejects.toThrow(message)
      expect(await text(live.profilePatch)).toBe(PROFILE_PATCH)
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
    await rm(join(evolved, 'AGENTS.md'))
    await mkdir(join(evolved, 'AGENTS.md'))
    await expect(applyEvolved(source(evolved), live, time(0))).rejects.toThrow(`self-improve apply refused: ${join(evolved, 'AGENTS.md')} is not a regular file`)
  })

  it('refuses to write into a damaged section or a patch that would stop being a list', async () => {
    const { evolved, live } = await setup()
    await put(join(evolved, 'overlay.patch.yml'), '- id: spill-policy\n  config:\n    maxInlineTokens: 10\n')
    await put(live.profilePatch, `${PATCH_SECTION.start}\n- id: spill-policy\n`)
    await expect(applyEvolved(source(evolved), live, time(0))).rejects.toThrow(`self-improve apply refused: ${live.profilePatch} has a damaged self-improve section`)
    await put(live.profilePatch, `${PATCH_SECTION.end}\n${PATCH_SECTION.start}\n`)
    await expect(applyEvolved(source(evolved), live, time(0))).rejects.toThrow('has a damaged self-improve section')
    await put(live.profilePatch, 'providers:\n  ollama: {}\n')
    await expect(applyEvolved(source(evolved), live, time(0))).rejects.toThrow(`self-improve apply refused: adding the overlay entries would leave ${live.profilePatch} not a YAML list of entries; add them by hand:\n- id: spill-policy`)
    await put(live.profilePatch, PROFILE_PATCH)
    await put(join(live.home, 'AGENTS.md'), `${INSTRUCTIONS_SECTION.end}\n`)
    await put(join(evolved, 'AGENTS.md'), 'x\n')
    await expect(applyEvolved(source(evolved), live, time(0))).rejects.toThrow('has a damaged self-improve section')
  })

  it('propagates filesystem failures other than absence', async () => {
    const { root, evolved, live } = await setup()
    await mkdir(live.profilePatch, { recursive: true })
    await expect(applyEvolved(source(evolved), live, time(0))).rejects.toThrow(/EISDIR/)
    await rm(live.profilePatch, { recursive: true })
    await writeFile(join(root, 'not-a-directory'), '')
    await expect(applyEvolved(source(join(root, 'not-a-directory')), live, time(0))).rejects.toThrow(/ENOTDIR/)
  })

  it('gives two backups of the same millisecond different directories', async () => {
    const { evolved, live } = await setup()
    await put(join(evolved, 'AGENTS.md'), 'one\n')
    await applyEvolved(source(evolved), live, time(0))
    await put(join(evolved, 'AGENTS.md'), 'two\n')
    await applyEvolved(source(evolved), live, time(0))
    await put(join(evolved, 'AGENTS.md'), 'three\n')
    await applyEvolved(source(evolved), live, time(0))
    expect(await readdir(live.backups)).toEqual(['2026-10-23T03-00-00-000Z', '2026-10-23T03-00-00-000Z-2', '2026-10-23T03-00-00-000Z-3'])
  })
})

describe('undoLatestApply', () => {
  it('restores the newest apply, keeps a snapshot of what it replaced, and walks back one apply per call', async () => {
    const { evolved, live } = await setup()
    await put(live.profilePatch, PROFILE_PATCH)
    await put(join(live.home, 'skills', 'mine', 'SKILL.md'), 'mine\n')
    await put(join(evolved, 'overlay.patch.yml'), '- id: spill-policy\n  config:\n    maxInlineTokens: 10\n')
    await put(join(evolved, 'skills', 'verify', 'SKILL.md'), 'v1\n')
    await applyEvolved(source(evolved), live, time(0))
    const afterFirst = await text(live.profilePatch)
    await put(join(evolved, 'skills', 'verify', 'SKILL.md'), 'v2\n')
    await put(join(evolved, 'AGENTS.md'), 'New rule.\n')
    await applyEvolved(source(evolved), live, time(1))
    // The operator edits the patch after the apply; the undo's snapshot keeps that edit.
    await writeFile(live.profilePatch, `${afterFirst}- id: agent-loop\n  disabled: true\n`)

    const undone = await undoLatestApply(live, time(2))
    expect(undone).toEqual({
      backup: join(live.backups, '2026-10-23T03-01-00-000Z'),
      snapshot: join(live.backups, '2026-10-23T03-02-00-000Z-undo'),
      restored: [join(live.home, 'AGENTS.md'), join(live.home, 'skills', 'verify')],
    })
    expect(await text(join(live.home, 'AGENTS.md'))).toBeUndefined()
    expect(await text(join(live.home, 'skills', 'verify', 'SKILL.md'))).toBe('v1\n')
    expect(await text(live.profilePatch)).toBe(`${afterFirst}- id: agent-loop\n  disabled: true\n`)
    expect(JSON.parse(await text(join(undone.snapshot, 'manifest.json')) ?? '')).toMatchObject({ kind: 'undo', skills: [], targets: [{ existed: true }, { existed: true }] })
    expect(JSON.parse(await text(join(undone.backup, 'manifest.json')) ?? '')).toMatchObject({ undoneAt: '2026-10-23T03:02:00.000Z' })

    expect((await undoLatestApply(live, time(3))).backup).toBe(join(live.backups, '2026-10-23T03-00-00-000Z'))
    expect(await text(live.profilePatch)).toBe(PROFILE_PATCH)
    expect(await text(join(live.home, 'skills', 'verify', 'SKILL.md'))).toBeUndefined()
    expect(await text(join(live.home, 'skills', 'mine', 'SKILL.md'))).toBe('mine\n')
    await expect(undoLatestApply(live, time(4))).rejects.toThrow('self-improve has no applied change to undo')
  })

  it('removes a skill an older apply wrote only once the newest manifest stops listing it', async () => {
    const { evolved, live } = await setup()
    await put(join(evolved, 'skills', 'a', 'SKILL.md'), 'a\n')
    await applyEvolved(source(evolved), live, time(0))
    await undoLatestApply(live, time(1))
    expect(await text(join(live.home, 'skills', 'a', 'SKILL.md'))).toBeUndefined()
    await rm(join(evolved, 'skills'), { recursive: true })
    // The undone apply no longer counts, so nothing is left to remove.
    expect(await applyEvolved(source(evolved), live, time(2))).toEqual({ status: 'unchanged' })
  })

  it('skips an interrupted backup and refuses an invalid manifest', async () => {
    const { live } = await setup()
    await expect(undoLatestApply(live, time(0))).rejects.toThrow('self-improve has no applied change to undo')
    await mkdir(join(live.backups, '2026-10-23T03-00-00-000Z'), { recursive: true })
    await expect(undoLatestApply(live, time(0))).rejects.toThrow('self-improve has no applied change to undo')
    const manifest = join(live.backups, '2026-10-23T04-00-00-000Z', 'manifest.json')
    await put(manifest, 'not json')
    await expect(undoLatestApply(live, time(0))).rejects.toThrow(`${manifest} is not JSON`)
    const valid = { version: 1, kind: 'apply', createdAt: 'x', source: 's', skills: [], targets: [] }
    for (const invalid of [
      [],
      { ...valid, version: 2 },
      { ...valid, kind: 'other' },
      { ...valid, createdAt: 1 },
      { ...valid, source: 1 },
      { ...valid, skills: [1] },
      { ...valid, skills: 'a' },
      { ...valid, targets: 'a' },
      { ...valid, targets: [{ path: 'p', existed: true }] },
      { ...valid, targets: [{ path: 'p', existed: false, copy: 'files/0' }] },
      { ...valid, targets: [{ path: 1, existed: false }] },
      { ...valid, targets: [{ path: 'p', existed: 'no' }] },
      { ...valid, targets: [null] },
      { ...valid, undoneAt: 1 },
    ]) {
      await writeFile(manifest, JSON.stringify(invalid))
      await expect(undoLatestApply(live, time(0))).rejects.toThrow(`${manifest} is not a self-improve backup manifest`)
    }
    await writeFile(manifest, JSON.stringify({ ...valid, kind: 'undo' }))
    await expect(undoLatestApply(live, time(0))).rejects.toThrow('self-improve has no applied change to undo')
  })
})
