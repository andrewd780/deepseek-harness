/**
 * Applying an evolved directory to the live dsh configuration, and undoing it.
 *
 * An apply writes the three parts of an evolved directory where dsh reads
 * them:
 * - the overlay's checked entries into a managed section of the profile
 *   patch (`cordis.patch.yml`), between `# >>> dsh self-improve` and
 *   `# <<< dsh self-improve` lines; the rest of the file stays byte for byte;
 * - `AGENTS.md` into a managed section of the Harness home's user-global
 *   `AGENTS.md`, between HTML comment lines, after the operator's own text;
 * - each entry of `skills/` into the Harness home's `skills/`, replacing an
 *   entry of the same name; entries an earlier apply wrote and the new
 *   directory lacks are removed.
 *
 * A section already present is replaced where it stands; a new one is
 * appended. The overlay is checked against the overlay rules again, and the
 * files copied are limited to regular files with the evolved directory's
 * extensions; any violation refuses the whole apply before anything changes.
 * Before writing, every file or directory the apply changes is copied to a
 * new backup directory with a manifest; undo restores the newest apply's
 * copies after copying the current state to a snapshot of its own. Applies
 * and undos hold one lock.
 *
 * ```
 * <backups>/<time>/manifest.json   kind, source, the skills written, and each target
 * <backups>/<time>/files/<n>       the copy of target n, when it existed
 * ```
 *
 * @module @deepseek-ai/dsh-experimental-self-improve/apply
 */

import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
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
  /** Absolute profile patch receiving the overlay's entries. */
  readonly profilePatch: string
  /** Absolute directory of the backups; its parent holds the apply lock. */
  readonly backups: string
}

/** What one apply writes. */
export interface ApplySource {
  /** Absolute evolved directory. */
  readonly evolved: string
  /** Where the evolved directory comes from, recorded in the backup manifest. */
  readonly description: string
}

/** The outcome of an apply. */
export type ApplyResult =
  | { readonly status: 'unchanged' }
  | { readonly status: 'applied'; readonly backup: string; readonly changed: readonly string[] }

/** The outcome of an undo. */
export interface UndoResult {
  /** The backup whose copies were restored. */
  readonly backup: string
  /** The snapshot of what the undo replaced. */
  readonly snapshot: string
  readonly restored: readonly string[]
}

/** One path an apply changed or an undo replaced. */
interface BackupTarget {
  readonly path: string
  readonly existed: boolean
  /** The copy's path relative to the backup directory, when the target existed. */
  readonly copy?: string
}

/** The manifest of one backup directory. */
interface BackupManifest {
  readonly version: 1
  readonly kind: 'apply' | 'undo'
  readonly createdAt: string
  readonly source: string
  /** Skill entries the Harness home holds from applies once this apply is written; empty for an undo snapshot. */
  readonly skills: readonly string[]
  readonly targets: readonly BackupTarget[]
  readonly undoneAt?: string
}

/** One target's next state: text, a copy of a source directory, or absence. */
type Desired =
  | { readonly path: string; readonly text: string; readonly mode: number }
  | { readonly path: string; readonly from: string }
  | { readonly path: string; readonly absent: true }

/** A managed section's marker lines. */
interface Section {
  readonly start: string
  readonly end: string
}

/** A text's lines around its managed section. */
interface Split {
  readonly before: readonly string[]
  readonly after: readonly string[]
  readonly found: boolean
}

const MANIFEST = 'manifest.json'
const PRIVATE = { mode: 0o600, dirMode: 0o700 } as const
const LOCK_WAIT_MS = 60_000

/** The managed section of the profile patch. */
export const PATCH_SECTION: Section = {
  start: '# >>> dsh self-improve: /self-improve apply manages the entries down to the closing line; /self-improve undo restores this file',
  end: '# <<< dsh self-improve',
}

/** The managed section of the user-global instructions. */
export const INSTRUCTIONS_SECTION: Section = {
  start: '<!-- >>> dsh self-improve: /self-improve apply manages this section; /self-improve undo restores this file -->',
  end: '<!-- <<< dsh self-improve -->',
}

/**
 * Write an evolved directory into the live configuration, backing up every path it changes.
 * @param source - the evolved directory and its description.
 * @param live - the Harness home, the profile patch, and the backup directory.
 * @param now - the backup's time.
 * @returns `unchanged` when the live configuration already matches, otherwise the backup and the changed paths.
 * @throws Error when the evolved directory breaks the overlay rules or holds a file an apply never copies,
 * when a managed section is damaged, or when the profile patch would not stay a YAML list.
 */
export async function applyEvolved(source: ApplySource, live: LiveConfiguration, now: Date): Promise<ApplyResult> {
  return await locked(live, async () => {
    const evolved = await readEvolved(source.evolved)
    const managed = (await latestApply(live.backups))?.manifest.skills ?? []
    const instructions = join(live.home, 'AGENTS.md')
    const desired: Desired[] = [
      await textTarget(live.profilePatch, patchText(await readText(live.profilePatch), evolved.overlay, live.profilePatch)),
      await textTarget(instructions, instructionsText(await readText(instructions), evolved.agents, instructions)),
      ...evolved.skills.map(name => ({ path: join(live.home, 'skills', name), from: join(source.evolved, 'skills', name) })),
      ...managed.filter(name => !evolved.skills.includes(name)).map(name => ({ path: join(live.home, 'skills', name), absent: true as const })),
    ]
    const changes: Desired[] = []
    for (const target of desired) if (await differs(target)) changes.push(target)
    if (changes.length === 0) return { status: 'unchanged' }
    const backup = await snapshot(live.backups, now, {
      kind: 'apply',
      source: source.description,
      skills: evolved.skills,
      paths: changes.map(change => change.path),
    })
    for (const change of changes) await write(change)
    return { status: 'applied', backup, changed: changes.map(change => change.path) }
  })
}

/**
 * Restore the newest apply that is not yet undone, after copying the current state to a snapshot.
 * @param live - the Harness home, the profile patch, and the backup directory.
 * @param now - the snapshot's time.
 * @returns the restored backup, the snapshot, and the restored paths.
 * @throws Error when no apply is left to undo, or when a manifest is invalid.
 */
export async function undoLatestApply(live: LiveConfiguration, now: Date): Promise<UndoResult> {
  return await locked(live, async () => {
    const latest = await latestApply(live.backups)
    if (latest === undefined) throw new Error('self-improve has no applied change to undo')
    const { manifest, directory } = latest
    const saved = await snapshot(live.backups, now, {
      kind: 'undo',
      source: `the live configuration before undoing ${directory}`,
      skills: [],
      paths: manifest.targets.map(target => target.path),
    })
    for (const target of manifest.targets) {
      await rm(target.path, { recursive: true, force: true })
      if (target.copy !== undefined) await cp(join(directory, target.copy), target.path, { recursive: true, verbatimSymlinks: true })
    }
    await writeFileAtomic(join(directory, MANIFEST), `${JSON.stringify({ ...manifest, undoneAt: now.toISOString() }, undefined, 1)}\n`, PRIVATE)
    return { backup: directory, snapshot: saved, restored: manifest.targets.map(target => target.path) }
  })
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

async function textTarget(path: string, text: string | undefined): Promise<Desired> {
  return text === undefined ? { path, absent: true } : { path, text, mode: await modeOf(path) }
}

/** The profile patch with the managed section holding `entries`; without the section when there are none. */
function patchText(current: string | undefined, entries: readonly OverlayEntry[], path: string): string | undefined {
  const { before, after, found } = split(current, PATCH_SECTION, path)
  if (entries.length === 0) {
    if (current === undefined) return undefined
    const rest = trimBlankEnd([...before, ...after])
    return joinLines(rest.some(isContent) ? rest : [...rest, '[]'])
  }
  // A patch holding only the empty list `[]` cannot take block entries after it.
  const emptyList = [...before, ...after].filter(isContent).every(line => line.trim() === '[]')
  const keep = (lines: readonly string[]): readonly string[] => (emptyList ? lines.filter(line => line.trim() !== '[]') : lines)
  const section = [PATCH_SECTION.start, ...stringify(entries).trimEnd().split('\n'), PATCH_SECTION.end]
  const text = joinLines(found ? [...keep(before), ...section, ...keep(after)] : appended(keep(before), section))
  const document = parseDocument(text, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] })
  if (document.errors.length > 0 || !isSeq(document.contents)) {
    throw new Error(`self-improve apply refused: adding the overlay entries would leave ${path} not a YAML list of entries; add them by hand:\n${stringify(entries)}`)
  }
  return text
}

/** The user-global instructions with the managed section holding `agents`; without the section when it is absent. */
function instructionsText(current: string | undefined, agents: string | undefined, path: string): string | undefined {
  const { before, after, found } = split(current, INSTRUCTIONS_SECTION, path)
  if (agents === undefined) {
    const rest = trimBlankEnd([...before, ...after])
    return rest.length === 0 ? undefined : joinLines(rest)
  }
  const section = [INSTRUCTIONS_SECTION.start, ...agents.trimEnd().split('\n'), INSTRUCTIONS_SECTION.end]
  return joinLines(found ? [...before, ...section, ...after] : appended(before, section))
}

/** The lines of `text` before and after its managed section. */
function split(text: string | undefined, section: Section, path: string): Split {
  const lines = text === undefined || text === '' ? [] : text.replace(/\n$/, '').split('\n')
  const start = lines.indexOf(section.start)
  const end = lines.indexOf(section.end)
  if (start < 0 && end < 0) return { before: lines, after: [], found: false }
  if (start < 0 || end < start) {
    throw new Error(`self-improve apply refused: ${path} has a damaged self-improve section; restore it with /self-improve undo or remove the section's lines`)
  }
  return { before: lines.slice(0, start), after: lines.slice(end + 1), found: true }
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

/** Whether writing `target` would change what is there. */
async function differs(target: Desired): Promise<boolean> {
  if ('absent' in target) return await entryKind(target.path) !== 'missing'
  if ('text' in target) return await readText(target.path) !== target.text
  return await treeDigest(target.path) !== await treeDigest(target.from)
}

async function write(target: Desired): Promise<void> {
  if ('text' in target) {
    await writeFileAtomic(target.path, target.text, { mode: target.mode, dirMode: PRIVATE.dirMode })
    return
  }
  await rm(target.path, { recursive: true, force: true })
  if ('from' in target) {
    await mkdir(dirname(target.path), { recursive: true, mode: PRIVATE.dirMode })
    await cp(target.from, target.path, { recursive: true })
  }
}

/** Copy every existing path to a new backup directory and record the manifest; returns the directory. */
async function snapshot(
  backups: string,
  now: Date,
  record: { readonly kind: BackupManifest['kind']; readonly source: string; readonly skills: readonly string[]; readonly paths: readonly string[] },
): Promise<string> {
  const directory = await newBackupDirectory(backups, now, record.kind)
  const targets: BackupTarget[] = []
  for (const [index, path] of record.paths.entries()) {
    if (await entryKind(path) === 'missing') {
      targets.push({ path, existed: false })
      continue
    }
    const copy = join('files', String(index))
    await mkdir(join(directory, 'files'), { recursive: true, mode: PRIVATE.dirMode })
    await cp(path, join(directory, copy), { recursive: true, verbatimSymlinks: true })
    targets.push({ path, existed: true, copy })
  }
  const manifest: BackupManifest = {
    version: 1,
    kind: record.kind,
    createdAt: now.toISOString(),
    source: record.source,
    skills: record.skills,
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

/** The newest apply manifest not yet undone, with its directory. */
async function latestApply(backups: string): Promise<{ readonly manifest: BackupManifest; readonly directory: string } | undefined> {
  const names = await entryKind(backups) === 'directory' ? (await readdir(backups)).sort().reverse() : []
  for (const name of names) {
    const directory = join(backups, name)
    const text = await readText(join(directory, MANIFEST))
    // A directory without a manifest holds a backup interrupted before anything was written.
    if (text === undefined) continue
    const manifest = manifestOf(text, join(directory, MANIFEST))
    if (manifest.kind === 'apply' && manifest.undoneAt === undefined) return { manifest, directory }
  }
  return undefined
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
  const { kind, createdAt, source, skills, targets, undoneAt } = value
  if ((kind !== 'apply' && kind !== 'undo') || typeof createdAt !== 'string' || typeof source !== 'string') throw invalid
  if (!isStrings(skills) || !Array.isArray(targets) || !targets.every(isTarget)) throw invalid
  if (undoneAt !== undefined && typeof undoneAt !== 'string') throw invalid
  return { version: 1, kind, createdAt, source, skills, targets, ...undoneAt === undefined ? {} : { undoneAt } }
}

function isStrings(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(entry => typeof entry === 'string')
}

function isTarget(value: unknown): value is BackupTarget {
  return isRecord(value)
    && typeof value['path'] === 'string'
    && typeof value['existed'] === 'boolean'
    && (value['existed'] ? typeof value['copy'] === 'string' : value['copy'] === undefined)
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
