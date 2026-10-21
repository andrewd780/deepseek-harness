/**
 * The rules a candidate's profile overlay must satisfy. Every trial loads the
 * overlay as dsh configuration, and configuration can load plugins, start
 * commands, and set the sandbox, so a model-written overlay may only set the
 * listed settings of listed entries and turn tools off. The loop checks the
 * rules before the critic reviews a candidate, and a trial loads a JSON copy
 * of the checked entries, never the file itself.
 *
 * @module @deepseek-ai/dsh-experimental-self-improve/overlay
 */

import { isAlias, parseDocument, visit } from 'yaml'

/** The evolved directory's profile patch. */
export const OVERLAY_FILE = 'overlay.patch.yml'

/** What a candidate overlay may contain. */
export interface OverlayRules {
  /** Entry ids whose `config` a candidate may set, each with the keys it accepts. */
  readonly entries: Readonly<Record<string, readonly string[]>>
  /** Id prefix of the entries a candidate may turn off with `disabled: true`. */
  readonly disablePrefix: string
}

/** One checked overlay entry. */
export interface OverlayEntry {
  readonly id: string
  readonly config?: Readonly<Record<string, unknown>>
  readonly disabled?: true
}

/** The checked entries of an overlay, or one objection per broken rule. */
export type OverlayCheck =
  | { readonly ok: true; readonly entries: readonly OverlayEntry[] }
  | { readonly ok: false; readonly objections: readonly string[] }

/**
 * Check an overlay against the rules.
 * @param text - the contents of `overlay.patch.yml`.
 * @param rules - the entries and settings a candidate may change.
 * @returns the checked entries, or the objections; an empty or comment-only file has no entries.
 */
export function checkOverlay(text: string, rules: OverlayRules): OverlayCheck {
  const document = parseDocument(text)
  const problems = [...document.errors, ...document.warnings]
  if (problems.length > 0) return rejected(problems.map(problem => `${OVERLAY_FILE} is not plain YAML: ${firstLine(problem.message)}`))
  const marked: unknown[] = []
  visit(document, {
    Node(_key, node) {
      if (isAlias(node) || node.tag !== undefined || node.anchor !== undefined) marked.push(node)
    },
  })
  if (marked.length > 0) return rejected([`${OVERLAY_FILE} uses a YAML tag, anchor, or alias; write plain values`])
  const value: unknown = document.toJS()
  if (value === null) return { ok: true, entries: [] }
  if (!Array.isArray(value)) return rejected([`${OVERLAY_FILE} must be a list of entries`])
  const objections: string[] = []
  const entries = value.flatMap((item: unknown, index) => {
    const entry = checkEntry(item, `${OVERLAY_FILE} entry ${index + 1}`, rules, objections)
    return entry === undefined ? [] : [entry]
  })
  return objections.length > 0 ? rejected(objections) : { ok: true, entries }
}

/**
 * The rules as the proposer reads them.
 * @param rules - the entries and settings a candidate may change.
 * @returns one paragraph.
 */
export function describeOverlayRules(rules: OverlayRules): string {
  const entries = Object.entries(rules.entries).map(([id, keys]) => `${id} (${keys.join(', ')})`).join('; ')
  return `\`${OVERLAY_FILE}\` is a YAML list of entries that change the harness configuration. An entry may set \`config\` for one of these entries, using only the listed keys: ${entries}. An entry may also turn off a tool, an entry whose id starts with "${rules.disablePrefix}", with \`disabled: true\`. A \`config\` replaces that entry's whole configuration. Nothing else may appear in the file, and YAML tags, anchors, and aliases are not allowed.`
}

/** Check one list item, recording an objection for each broken rule. */
function checkEntry(item: unknown, label: string, rules: OverlayRules, objections: string[]): OverlayEntry | undefined {
  if (!isRecord(item) || typeof item['id'] !== 'string') {
    objections.push(`${label} must be a map with an id`)
    return undefined
  }
  const id = item['id']
  const where = `${label} (${id})`
  const before = objections.length
  const extra = Object.keys(item).filter(key => key !== 'id' && key !== 'config' && key !== 'disabled')
  if (extra.length > 0) objections.push(`${where} sets ${extra.join(', ')}; an entry may only set config or disabled`)
  const disabled = item['disabled']
  if (disabled !== undefined && (disabled !== true || !id.startsWith(rules.disablePrefix))) {
    objections.push(`${where}: only an entry whose id starts with "${rules.disablePrefix}" may be turned off, with disabled: true`)
  }
  const config = item['config']
  if (config !== undefined) checkConfig(config, id, where, rules, objections)
  if (config === undefined && disabled === undefined) objections.push(`${where} changes nothing; set config or disabled`)
  if (objections.length > before) return undefined
  return { id, ...isRecord(config) ? { config } : {}, ...disabled === true ? { disabled: true } : {} }
}

function checkConfig(config: unknown, id: string, where: string, rules: OverlayRules, objections: string[]): void {
  const allowed = Object.hasOwn(rules.entries, id) ? rules.entries[id] : undefined
  if (allowed === undefined) {
    objections.push(`${where}: its config cannot change; entries whose config can change: ${Object.keys(rules.entries).join(', ')}`)
    return
  }
  if (!isRecord(config)) {
    objections.push(`${where}: config must be a map`)
    return
  }
  const refused = Object.keys(config).filter(key => !allowed.includes(key))
  if (refused.length > 0) objections.push(`${where}: config key(s) ${refused.join(', ')} cannot change; allowed: ${allowed.join(', ')}`)
  if (!Object.values(config).every(isPlain)) objections.push(`${where}: config values must be text, numbers, booleans, lists, or maps`)
}

/** Whether a value survives JSON unchanged: text, finite numbers, booleans, null, and lists and plain maps of those. */
function isPlain(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isPlain)
  return isRecord(value) && Object.getPrototypeOf(value) === Object.prototype && Object.values(value).every(isPlain)
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function rejected(objections: readonly string[]): OverlayCheck {
  return { ok: false, objections }
}

function firstLine(text: string): string {
  return text.split('\n', 1).join('')
}
