/**
 * The component set and leakage patterns of a dsh evolved directory:
 * a profile overlay (`overlay.patch.yml`), user-global instructions
 * (`AGENTS.md`), and skills (`skills/`).
 *
 * @module @deepseek-ai/dsh-experimental-self-improve/evolved-directory
 */

import type { ComponentSet } from './components.ts'
import type { CriticPattern } from './types.ts'

/**
 * The nine components of regularized recursive self-improvement, with diff
 * evidence for a dsh evolved directory. Instruction prose that no signal claims is a
 * `prompt` edit.
 */
export const DSH_COMPONENTS: ComponentSet = {
  names: ['prompt', 'control_flow', 'config', 'output_plumbing', 'context_mgmt', 'client_tool', 'skill', 'memory', 'subagent'],
  structural: ['client_tool', 'skill', 'memory', 'subagent'],
  signals: [
    { component: 'skill', patterns: [/^(?:\+\+\+|---) [ab]\/(?:.*\/)?skills\//m] },
    { component: 'memory', patterns: [/^\+.*\b(?:memory|memories|remember|recall)\b/im] },
    { component: 'client_tool', patterns: [/^\+.*(?:dsh-tool-|dsh-mcp|\bmcp\b)/im] },
    { component: 'subagent', patterns: [/^\+.*\b(?:subagents?|delegat\w*)\b/im] },
    { component: 'context_mgmt', patterns: [/^\+.*(?:compaction|headroom|ratio|pruner|spill)/im] },
    { component: 'output_plumbing', patterns: [/^\+.*(?:headChars|tailChars|maxResultChars|truncat|maxBytes)/im] },
    { component: 'control_flow', patterns: [/^\+.*(?:reminder|timeoutMs|maxSteps|maxTurns|\bguard|\bptc\b)/im] },
    { component: 'config', patterns: [/^(?:\+\+\+|---) [ab]\/(?:.*\/)?overlay\.patch\.yml$/m] },
  ],
  fallback: 'prompt',
}

/** File extensions the proposer may create in a dsh evolved directory. */
export const EVOLVED_FILE_EXTENSIONS: readonly string[] = ['.md', '.yml', '.yaml', '.json', '.txt']

/**
 * Changes a dsh candidate may never make, whatever the suite: executable
 * configuration, the policy model's route, permissions, and remote endpoints.
 * The measurement is only meaningful while those stay frozen.
 */
export const DSH_CRITIC_PATTERNS: readonly CriticPattern[] = [
  { pattern: /!!js/, reason: 'executable configuration in the overlay' },
  { pattern: /^\+.*(?:agent-default-model|dsh-llm-|reasoningEffort|agentOptions)|^\+\s*(?:provider|model)\s*:/m, reason: 'changes the policy model route' },
  {
    pattern: /^\+\s*[\w-]*(?:permission|sandbox|approval)[\w-]*\s*:|^\+.*@deepseek-ai\/dsh-(?:sandbox|user-approval|permission)/im,
    reason: 'changes permissions, the sandbox, or approvals',
  },
  { pattern: /^\+.*https?:\/\//m, reason: 'adds a remote endpoint' },
]

/**
 * Patterns that reject a diff naming one of the suite's tasks.
 * @param tasks - the suite's task ids.
 * @returns one pattern per task id.
 */
export function taskNamePatterns(tasks: readonly string[]): readonly CriticPattern[] {
  return tasks.map(task => ({
    pattern: new RegExp(`(?<![\\w-])${task.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`),
    reason: `names suite task ${task}`,
  }))
}
