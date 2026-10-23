/**
 * Applying an evolved directory to the live dsh configuration, and undoing it.
 *
 * An apply writes the three parts of an evolved directory where dsh reads
 * them:
 * - the overlay's checked entries into a managed section of a patch layer,
 *   by default the Harness home's `cordis.patch.yml`, which every profile
 *   applies after its own patch and which dsh's own editors never write;
 *   the section lies between `# >>> dsh self-improve` and
 *   `# <<< dsh self-improve` lines, and the rest of the file stays byte for
 *   byte;
 * - `AGENTS.md` into a managed section of the Harness home's user-global
 *   `AGENTS.md`, between HTML comment lines, after the operator's own text;
 * - each entry of `skills/` into the Harness home's `skills/`; entries an
 *   earlier apply wrote and the new directory lacks are removed.
 *
 * A section already present is replaced where it stands; a new one is
 * appended. Text files are written through symbolic links. The apply
 * refuses, before anything changes, when the overlay breaks the overlay
 * rules, when the evolved directory holds a file an apply never copies, when
 * a managed section differs from what the newest apply wrote, or when a
 * skill of the same name exists that no apply wrote. Every path it changes
 * is first copied to a new backup directory with a manifest.
 *
 * Undo reverses the newest apply not yet undone: it restores the sections
 * that apply replaced, keeping text the operator wrote outside them since,
 * and the skill directories it replaced; a snapshot of everything undo
 * replaces is kept first. An undone revision counts as undone until an apply
 * writes it again. Applies and undos hold one lock and number their backups
 * in order, independent of the clock.
 *
 * ```
 * <backups>/<time>/manifest.json   kind, sequence, source, sections, skills, and each target
 * <backups>/<time>/files/<n>       the copy of target n, when it existed
 * ```
 *
 * @module @deepseek-ai/dsh-experimental-self-improve/apply
 */

import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, readdir, readFile, realpath, rm, stat } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'

import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { isSeq, parseDocument, stringify } from 'yaml'

import { DSH_OVERLAY_RULES, EVOLVED_FILE_EXTENSIONS } from './evolved-directory.ts'
import { checkOverlay, OVERLAY_FILE } from './overlay.ts'
import type { OverlayEntry } from './overlay.ts'

/** Where an apply writes and keeps its backups. */
export interface LiveConfiguration {
  /** Absolute Harness home holding the user-global `AGENTS.md` and user `skills/`. */
  readonly home: string
  /** Absolute patch layer receiving the overlay's entries. */
  readonly overlayPatch: string
  /** Absolute directory of the backups; its parent holds the apply lock. */
  readonly backups: string
}

/** What one apply writes. */
export interface ApplySource {
  /** Absolute evolved directory. */
  readonly evolved: string
  /** Where the evolved directory comes from, recorded in the backup manifest. */
  readonly description: string
  /** The revision the evolved directory holds. */
  readonly commit: string
}

/** The outcome of an apply. */
export type ApplyResult =
  | { readonly status: 'unchanged' }
  | {
    readonly status: 'applied'
    readonly backup: string
    readonly changed: readonly string[]
    /** Each overlay entry written, such as `spill-policy (maxInlineTokens)` or `tool-web-fetch (off)`. */
    readonly overlay: readonly string[]
  }

/** The outcome of an undo. */
export interface UndoResult {
  /** The backup whose apply was reversed. */
  readonly backup: string
  /** The snapshot of what the undo replaced. */
  readonly snapshot: string
  readonly restored: readonly string[]
  /** The revision the reversed apply wrote; `null` when its manifest names none. */
  readonly commit: string | null
}

/** Which managed section a text target holds. */
type TextKind = 'patch' | 'instructions'

/** One path an apply changed or an undo replaced. */
interface BackupTarget {
  readonly path: string
  readonly kind: TextKind | 'tree'
  readonly existed: boolean
  /** The copy's path relative to the backup directory, when the target existed. */
  readonly copy?: string
  /** For a text target, its managed section's lines before the change; `null` when it had none. */
  readonly before?: readonly string[] | null
}

/** A text target's managed section after an operation; `null` when the target has none. */
interface SectionRecord {
  readonly path: string
  readonly body: readonly string[] | null
}

/** The manifest of one backup directory. */
interface BackupManifest {
  readonly version: 1
  readonly kind: 'apply' | 'undo'
  /** Order among every backup, one more than the highest before it. */
  readonly sequence: number
  readonly createdAt: string
  readonly source: string
  /** The revision an apply wrote; `null` for an undo snapshot. */
  readonly commit: string | null
  /** Skill entries the Harness home holds from applies once this apply is written; empty for an undo snapshot. */
  readonly skills: readonly string[]
  /** Both text targets' managed sections once this apply is written; empty for an undo snapshot. */
  readonly sections: readonly SectionRecord[]
  readonly targets: readonly BackupTarget[]
  readonly undoneAt?: string
}

/** A manifest with its directory. */
interface StoredManifest {
  readonly manifest: BackupManifest
  readonly directory: string
}

/** One target's next state: text, a copy of a source directory, or absence. */
type Desired =
  | {
    readonly path: string
    readonly kind: TextKind
    readonly text: string | undefined
    readonly mode: number
    readonly before: readonly string[] | null
  }
  | { readonly path: string; readonly kind: 'tree'; readonly from: string | undefined }

/** A managed section's marker lines. */
interface Section {
  readonly start: string
  readonly end: string
}

/** A text's lines around its managed section. */
interface Split {
  readonly before: readonly string[]
  readonly body: readonly string[] | null
  readonly after: readonly string[]
}

const MANIFEST = 'manifest.json'
const PRIVATE = { mode: 0o600, dirMode: 0o700 } as const
const LOCK_WAIT_MS = 60_000

/** The managed section of the overlay's patch layer. */
export const PATCH_SECTION: Section = {
  start: '# >>> dsh self-improve: /self-improve apply manages the entries down to the closing line; /self-improve undo restores them',
  end: '# <<< dsh self-improve',
}

/** The managed section of the user-global instructions. */
export const INSTRUCTIONS_SECTION: Section = {
  start: '<!-- >>> dsh self-improve: /self-improve apply manages this section; /self-improve undo restores it -->',
  end: '<!-- <<< dsh self-improve -->',
}

const SECTIONS: Readonly<Record<TextKind, Section>> = { patch: PATCH_SECTION, instructions: INSTRUCTIONS_SECTION }

/**
 * Write an evolved directory into the live configuration, backing up every path it changes.
 * @param source - the evolved directory, its description, and its revision.
 * @param live - the Harness home, the overlay's patch layer, and the backup directory.
 * @param now - the backup's time.
 * @returns `unchanged` when the live configuration already matches, otherwise the backup, the changed paths, and the
 * overlay entries written.
 * @throws Error when the evolved directory breaks the overlay rules or holds a file an apply never copies, when a
 * managed section changed since the newest apply or is damaged, when a skill of the same name exists that no apply
 * wrote, or when the patch layer would not stay a YAML list.
 */
export async function applyEvolved(source: ApplySource, live: LiveConfiguration, now: Date): Promise<ApplyResult> {
  return await locked(live, async () => {
    const evolved = await readEvolved(source.evolved)
    const manifests = await readManifests(live.backups)
    const latest = latestApply(manifests)?.manifest
    const recorded = (path: string): readonly string[] | null => latest?.sections.find(section => section.path === path)?.body ?? null
    const texts = [
      await textTarget('patch', live.overlayPatch, evolved.overlay.length === 0 ? null : stringify(evolved.overlay).trimEnd().split('\n'), recorded),
      await textTarget('instructions', join(live.home, 'AGENTS.md'), evolved.agents?.trimEnd().split('\n') ?? null, recorded),
    ]
    const managed = latest?.skills ?? []
    const trees: Desired[] = []
    for (const name of evolved.skills) {
      const path = join(live.home, 'skills', name)
      if (!managed.includes(name) && await entryKind(path) !== 'missing') {
        throw new Error(`self-improve apply refused: ${path} exists and no apply wrote it; rename the skill or move it away`)
      }
      trees.push({ path, kind: 'tree', from: join(source.evolved, 'skills', name) })
    }
    for (const name of managed.filter(entry => !evolved.skills.includes(entry))) trees.push({ path: join(live.home, 'skills', name), kind: 'tree', from: undefined })
    const changes: Desired[] = []
    for (const target of [...texts.map(text => text.desired), ...trees]) if (await differs(target)) changes.push(target)
    if (changes.length === 0) return { status: 'unchanged' }
    const backup = await snapshot(live.backups, manifests, now, {
      kind: 'apply',
      source: source.description,
      commit: source.commit,
      skills: evolved.skills,
      sections: texts.map(text => text.record),
      changes,
    })
    for (const change of changes) await write(change)
    return { status: 'applied', backup, changed: changes.map(change => change.path), overlay: evolved.overlay.map(describeEntry) }
  })
}

/**
 * Reverse the newest apply not yet undone, after copying everything it replaces to a snapshot.
 * @param live - the Harness home, the overlay's patch layer, and the backup directory.
 * @param now - the snapshot's time.
 * @returns the reversed backup, the snapshot, the restored paths, and the revision the apply wrote.
 * @throws Error when no apply is left to undo, when a manifest is invalid, or when a managed section is damaged.
 */
export async function undoLatestApply(live: LiveConfiguration, now: Date): Promise<UndoResult> {
  return await locked(live, async () => {
    const manifests = await readManifests(live.backups)
    const latest = latestApply(manifests)
    if (latest === undefined) throw new Error('self-improve has no applied change to undo')
    const { manifest, directory } = latest
    const plan: Desired[] = []
    for (const target of manifest.targets) {
      if (target.kind === 'tree') {
        plan.push({ path: target.path, kind: 'tree', from: target.copy === undefined ? undefined : join(directory, target.copy) })
        continue
      }
      const before = target.before ?? null
      const text = withSection(target.kind, await readText(target.path), before, target.path, !target.existed)
      plan.push({ path: target.path, kind: target.kind, text, mode: await modeOf(target.path), before })
    }
    const saved = await snapshot(live.backups, manifests, now, {
      kind: 'undo',
      source: `the live configuration before undoing ${directory}`,
      commit: null,
      skills: [],
      sections: [],
      changes: plan,
    })
    for (const change of plan) await write(change)
    await writeFileAtomic(join(directory, MANIFEST), `${JSON.stringify({ ...manifest, undoneAt: now.toISOString() }, undefined, 1)}\n`, PRIVATE)
    return { backup: directory, snapshot: saved, restored: plan.map(change => change.path), commit: manifest.commit }
  })
}

/**
 * The revisions whose newest apply was undone.
 * @param live - the backup directory.
 * @returns the undone revisions.
 * @throws Error when a manifest is invalid.
 */
export async function undoneCommits(live: LiveConfiguration): Promise<ReadonlySet<string>> {
  const newest = new Map<string, BackupManifest>()
  for (const { manifest } of await readManifests(live.backups)) {
    if (manifest.kind === 'apply' && manifest.commit !== null) newest.set(manifest.commit, manifest)
  }
  return new Set([...newest].filter(([, manifest]) => manifest.undoneAt !== undefined).map(([commit]) => commit))
}

async function locked<T>(live: LiveConfiguration, operation: () => Promise<T>): Promise<T> {
  const state = dirname(live.backups)
  await mkdir(state, { recursive: true, mode: PRIVATE.dirMode })
  return await withFileLock(join(state, 'apply'), operation, { waitMs: LOCK_WAIT_MS })
}

/** The evolved directory's checked parts. */
async function readEvolved(directory: string): Promise<{
  readonly overlay: readonly OverlayEntry[]
  readonly agents: string | undefined
  readonly skills: readonly string[]
}> {
  const overlayText = await regularText(join(directory, OVERLAY_FILE))
  const overlay = overlayText === undefined ? { ok: true as const, entries: [] } : checkOverlay(overlayText, DSH_OVERLAY_RULES)
  if (!overlay.ok) throw new Error(`self-improve apply refused: ${overlay.objections.join('; ')}`)
  const agents = await regularText(join(directory, 'AGENTS.md'))
  const skillsDirectory = join(directory, 'skills')
  const skills = await entryKind(skillsDirectory) === 'directory' ? (await readdir(skillsDirectory)).sort() : []
  for (const name of skills) await checkTree(join(skillsDirectory, name), `skills/${name}`)
  return { overlay: overlay.entries, agents: agents?.trim() === '' ? undefined : agents, skills }
}

/** Refuse anything under `path` but directories and regular files with an evolved file extension. */
async function checkTree(path: string, label: string): Promise<void> {
  const type = await entryKind(path)
  if (type === 'directory') {
    for (const name of (await readdir(path)).sort()) await checkTree(join(path, name), `${label}/${name}`)
    return
  }
  if (type !== 'file' || !EVOLVED_FILE_EXTENSIONS.includes(extname(path))) {
    throw new Error(`self-improve apply refused: ${label} is not a regular file with one of the extensions ${EVOLVED_FILE_EXTENSIONS.join(', ')}`)
  }
}

/** One text target's next state, after checking its managed section still holds what the newest apply wrote. */
async function textTarget(
  kind: TextKind,
  configured: string,
  body: readonly string[] | null,
  recorded: (path: string) => readonly string[] | null,
): Promise<{ readonly desired: Desired; readonly record: SectionRecord }> {
  const path = await realpath(configured).catch(() => configured)
  const current = await readText(path)
  const existing = split(current, SECTIONS[kind], path).body
  if (existing !== null && !sameLines(existing, recorded(path))) {
    throw new Error(`self-improve apply refused: the self-improve section of ${path} changed since the newest apply wrote it; `
      + 'move your own lines out of it, or restore it with /self-improve undo')
  }
  return {
    desired: { path, kind, text: withSection(kind, current, body, path), mode: await modeOf(path), before: existing },
    record: { path, body },
  }
}

/**
 * `current` with its managed section holding `body`, or without the section when `body` is `null`. Without the
 * section, `undefined` stands for no file: an instructions file with nothing left, a patch layer that does not exist,
 * or, with `created`, a patch layer the apply created that holds nothing else.
 */
function withSection(
  kind: TextKind,
  current: string | undefined,
  body: readonly string[] | null,
  path: string,
  created = false,
): string | undefined {
  const section = SECTIONS[kind]
  const parts = split(current, section, path)
  if (body === null) {
    const rest = trimBlankEnd([...parts.before, ...parts.after])
    if (kind === 'instructions') return rest.length === 0 ? undefined : joinLines(rest)
    const content = rest.some(isContent)
    if (current === undefined || (created && !content)) return undefined
    return joinLines(content ? rest : [...rest, '[]'])
  }
  // A patch layer holding only the empty list `[]` cannot take block entries after it.
  const emptyList = kind === 'patch' && [...parts.before, ...parts.after].filter(isContent).every(line => line.trim() === '[]')
  const keep = (lines: readonly string[]): readonly string[] => (emptyList ? lines.filter(line => line.trim() !== '[]') : lines)
  const lines = [section.start, ...body, section.end]
  const placed = parts.body === null ? appended(keep(parts.before), lines) : [...keep(parts.before), ...lines, ...keep(parts.after)]
  const text = joinLines(placed)
  if (kind === 'patch') {
    const document = parseDocument(text, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] })
    if (document.errors.length > 0 || !isSeq(document.contents)) {
      throw new Error(`self-improve apply refused: adding the overlay entries would leave ${path} not a YAML list of entries; add them by hand:\n${body.join('\n')}`)
    }
  }
  return text
}

/** The lines of `text` before, inside, and after its managed section. */
function split(text: string | undefined, section: Section, path: string): Split {
  const lines = text === undefined || text === '' ? [] : text.replace(/\n$/, '').split('\n')
  const start = lines.indexOf(section.start)
  const end = lines.indexOf(section.end)
  if (start < 0 && end < 0) return { before: lines, body: null, after: [] }
  if (start < 0 || end < start) {
    throw new Error(`self-improve apply refused: ${path} has a damaged self-improve section; restore it with /self-improve undo or remove the section's lines`)
  }
  return { before: lines.slice(0, start), body: lines.slice(start + 1, end), after: lines.slice(end + 1) }
}

/** `section` after `lines`, separated by one blank line. */
function appended(lines: readonly string[], section: readonly string[]): readonly string[] {
  const body = trimBlankEnd(lines)
  return body.length === 0 ? section : [...body, '', ...section]
}

function trimBlankEnd(lines: readonly string[]): readonly string[] {
  let end = lines.length
  while (end > 0 && lines[end - 1]?.trim() === '') end -= 1
  return lines.slice(0, end)
}

function joinLines(lines: readonly string[]): string {
  return `${lines.join('\n')}\n`
}

function isContent(line: string): boolean {
  const trimmed = line.trim()
  return trimmed !== '' && !trimmed.startsWith('#')
}

function sameLines(left: readonly string[], right: readonly string[] | null): boolean {
  return right !== null && left.length === right.length && left.every((line, index) => line === right[index])
}

/** An overlay entry as the summary names it. */
function describeEntry(entry: OverlayEntry): string {
  return entry.disabled === true || entry.config === undefined ? `${entry.id} (off)` : `${entry.id} (${Object.keys(entry.config).join(', ')})`
}

/** Whether writing `target` would change what is there. */
async function differs(target: Desired): Promise<boolean> {
  if (target.kind !== 'tree') return await readText(target.path) !== target.text
  return await treeDigest(target.path) !== (target.from === undefined ? undefined : await treeDigest(target.from))
}

async function write(target: Desired): Promise<void> {
  if (target.kind !== 'tree' && target.text !== undefined) {
    await writeFileAtomic(target.path, target.text, { mode: target.mode, dirMode: PRIVATE.dirMode })
    return
  }
  await rm(target.path, { recursive: true, force: true })
  if (target.kind === 'tree' && target.from !== undefined) {
    await mkdir(dirname(target.path), { recursive: true, mode: PRIVATE.dirMode })
    await cp(target.from, target.path, { recursive: true, verbatimSymlinks: true })
  }
}

/** Copy every existing path to a new backup directory and record the manifest; returns the directory. */
async function snapshot(
  backups: string,
  manifests: readonly StoredManifest[],
  now: Date,
  record: {
    readonly kind: BackupManifest['kind']
    readonly source: string
    readonly commit: string | null
    readonly skills: readonly string[]
    readonly sections: readonly SectionRecord[]
    readonly changes: readonly Desired[]
  },
): Promise<string> {
  const directory = await newBackupDirectory(backups, now, record.kind)
  const targets: BackupTarget[] = []
  for (const [index, change] of record.changes.entries()) {
    const before = change.kind === 'tree' ? {} : { before: change.before }
    if (await entryKind(change.path) === 'missing') {
      targets.push({ path: change.path, kind: change.kind, existed: false, ...before })
      continue
    }
    const copy = join('files', String(index))
    await mkdir(join(directory, 'files'), { recursive: true, mode: PRIVATE.dirMode })
    await cp(change.path, join(directory, copy), { recursive: true, verbatimSymlinks: true })
    targets.push({ path: change.path, kind: change.kind, existed: true, copy, ...before })
  }
  const manifest: BackupManifest = {
    version: 1,
    kind: record.kind,
    sequence: Math.max(0, ...manifests.map(entry => entry.manifest.sequence)) + 1,
    createdAt: now.toISOString(),
    source: record.source,
    commit: record.commit,
    skills: record.skills,
    sections: record.sections,
    targets,
  }
  await writeFileAtomic(join(directory, MANIFEST), `${JSON.stringify(manifest, undefined, 1)}\n`, PRIVATE)
  return directory
}

/** A new directory named after `now`, with a suffix when a backup of the same millisecond holds the name; the apply lock is held. */
async function newBackupDirectory(backups: string, now: Date, kind: BackupManifest['kind']): Promise<string> {
  await mkdir(backups, { recursive: true, mode: PRIVATE.dirMode })
  const taken = new Set(await readdir(backups))
  const stamp = `${now.toISOString().replace(/[:.]/g, '-')}${kind === 'undo' ? '-undo' : ''}`
  let name = stamp
  for (let attempt = 2; taken.has(name); attempt += 1) name = `${stamp}-${attempt}`
  const directory = join(backups, name)
  await mkdir(directory, { mode: PRIVATE.dirMode })
  return directory
}

/** Every backup with a manifest, in sequence order; a directory without one holds a backup interrupted before any write. */
async function readManifests(backups: string): Promise<readonly StoredManifest[]> {
  const names = await entryKind(backups) === 'directory' ? await readdir(backups) : []
  const manifests: StoredManifest[] = []
  for (const name of names) {
    const directory = join(backups, name)
    const text = await readText(join(directory, MANIFEST))
    if (text !== undefined) manifests.push({ manifest: manifestOf(text, join(directory, MANIFEST)), directory })
  }
  return manifests.sort((left, right) => left.manifest.sequence - right.manifest.sequence)
}

/** The newest apply not yet undone. */
function latestApply(manifests: readonly StoredManifest[]): StoredManifest | undefined {
  return manifests.findLast(entry => entry.manifest.kind === 'apply' && entry.manifest.undoneAt === undefined)
}

function manifestOf(text: string, path: string): BackupManifest {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new Error(`${path} is not JSON`, { cause: error })
  }
  const invalid = new Error(`${path} is not a self-improve backup manifest`)
  if (!isRecord(value) || value['version'] !== 1) throw invalid
  const { kind, sequence, createdAt, source, commit, skills, sections, targets, undoneAt } = value
  if ((kind !== 'apply' && kind !== 'undo') || typeof sequence !== 'number' || !Number.isInteger(sequence)) throw invalid
  if (typeof createdAt !== 'string' || typeof source !== 'string' || (commit !== null && typeof commit !== 'string') || !isStrings(skills)) throw invalid
  if (!Array.isArray(sections) || !sections.every(isSection) || !Array.isArray(targets) || !targets.every(isTarget)) throw invalid
  if (undoneAt !== undefined && typeof undoneAt !== 'string') throw invalid
  return { version: 1, kind, sequence, createdAt, source, commit, skills, sections, targets, ...undoneAt === undefined ? {} : { undoneAt } }
}

function isStrings(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(entry => typeof entry === 'string')
}

function isBody(value: unknown): value is readonly string[] | null {
  return value === null || isStrings(value)
}

function isSection(value: unknown): value is SectionRecord {
  return isRecord(value) && typeof value['path'] === 'string' && isBody(value['body'])
}

function isTarget(value: unknown): value is BackupTarget {
  if (!isRecord(value) || typeof value['path'] !== 'string' || typeof value['existed'] !== 'boolean') return false
  const { kind, existed, copy, before } = value
  if (existed ? typeof copy !== 'string' : copy !== undefined) return false
  if (kind === 'tree') return before === undefined
  return (kind === 'patch' || kind === 'instructions') && isBody(before)
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function entryKind(path: string): Promise<'file' | 'directory' | 'other' | 'missing'> {
  try {
    const entry = await lstat(path)
    return entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : 'other'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw error
  }
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** A regular file's text, `undefined` when absent; anything else at `path` refuses the apply. */
async function regularText(path: string): Promise<string | undefined> {
  const type = await entryKind(path)
  if (type === 'missing') return undefined
  if (type !== 'file') throw new Error(`self-improve apply refused: ${path} is not a regular file`)
  return await readFile(path, 'utf8')
}

/** The permission bits of an existing file, or private bits for a new one. */
async function modeOf(path: string): Promise<number> {
  return await stat(path).then(entry => entry.mode & 0o777, () => PRIVATE.mode)
}

/** A digest of a file tree's paths, kinds, and contents; `undefined` when nothing is at `path`. */
async function treeDigest(path: string): Promise<string | undefined> {
  if (await entryKind(path) === 'missing') return undefined
  const hash = createHash('sha256')
  const visit = async (entry: string, label: string): Promise<void> => {
    const type = await entryKind(entry)
    hash.update(`${type}\0${label}\0`)
    if (type === 'file') hash.update(await readFile(entry))
    if (type === 'directory') for (const name of (await readdir(entry)).sort()) await visit(join(entry, name), `${label}/${name}`)
  }
  await visit(path, '.')
  return hash.digest('hex')
}
