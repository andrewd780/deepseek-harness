import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadRunSpec, resolveRunSpec } from '../src/spec.ts'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const minimal = {
  name: 'small-window',
  suite: 'suite.json',
  evolvedDirectory: 'harness/evolved',
  trial: { policyPatches: ['policy.patch.yml'], provider: 'deepseek', model: 'deepseek-v4-flash' },
  roles: { provider: 'deepseek', model: 'deepseek-v4-pro' },
  delta: 'calibrate',
  calibration: { method: 'z' },
}

function resolved(value: unknown): { readonly problems: string[]; readonly spec: ReturnType<typeof resolveRunSpec> } {
  const problems: string[] = []
  return { problems, spec: resolveRunSpec(value, '/specs', problems) }
}

describe('resolveRunSpec', () => {
  it('fills the reference coding defaults and resolves paths against the spec', () => {
    const { problems, spec } = resolved(minimal)
    expect(problems).toEqual([])
    expect(spec).toMatchObject({
      name: 'small-window',
      suite: '/specs/suite.json',
      evolvedDirectory: 'harness/evolved',
      repository: '/specs',
      branch: 'self-improve/small-window',
      startPoint: 'HEAD',
      trial: { profile: 'sdk', policyPatches: ['/specs/policy.patch.yml'], forwardEnv: [], env: {}, timeoutMs: 1_800_000, concurrency: 1, maxPromptGrowth: undefined },
      roles: {
        maxOutputTokens: 16_384, proposerTurns: 40, criticAttempts: 3, maxDiffCharacters: 120_000, maxHistoryDiffCharacters: 120_000,
      },
      calibration: { method: 'z', z: 2, resamples: 2_000, seed: 7 },
    })
    expect(spec.settings).toMatchObject({
      rounds: 20, variants: 2, trials: 2, minEdits: 1, maxEdits: 4, stallWindow: 3, reservedSlots: 1, pruneWindow: 4,
      repairRounds: 5, failureTraces: 30, successTraces: 6, maxMissingFraction: 0.2, historyLimit: 40, delta: undefined,
      selection: {
        costAllowance: 0.1,
        costPerGain: { value: 0.25, perPass: true },
        scoreWeight: { value: 0, perPass: true },
        costWeight: 15,
        noveltyWeight: 0.5,
      },
    })
  })

  it('caps history diffs at the critic\'s diff limit unless the spec sets them', () => {
    expect(resolved({ ...minimal, roles: { ...minimal.roles, maxDiffCharacters: 5_000 } }).spec.roles)
      .toMatchObject({ maxDiffCharacters: 5_000, maxHistoryDiffCharacters: 5_000 })
    expect(resolved({ ...minimal, roles: { ...minimal.roles, maxHistoryDiffCharacters: 800 } }).spec.roles)
      .toMatchObject({ maxDiffCharacters: 120_000, maxHistoryDiffCharacters: 800 })
    expect(resolved({ ...minimal, roles: { ...minimal.roles, maxHistoryDiffCharacters: 0 } }).problems)
      .toEqual(['roles.maxHistoryDiffCharacters must be an integer from 1 to 9007199254740991'])
  })

  it('takes each rate per unit of score or per passing trial, never both', () => {
    expect(resolved({ ...minimal, selection: { costPerPass: 0.1, scoreWeight: 3 } }).spec.settings.selection).toMatchObject({
      costPerGain: { value: 0.1, perPass: true },
      scoreWeight: { value: 3, perPass: false },
    })
    const both = { costPerGain: 2, costPerPass: 0.1, scoreWeight: 1, scoreWeightPerPass: 1 }
    expect(resolved({ ...minimal, selection: both }).problems).toEqual([
      'selection.costPerGain and selection.costPerPass must not both be set',
      'selection.scoreWeight and selection.scoreWeightPerPass must not both be set',
    ])
  })

  it('takes explicit values', () => {
    const { problems, spec } = resolved({
      ...minimal,
      delta: 0.02,
      rounds: 5,
      branch: 'evolve/x',
      repository: '../repo',
      trial: { ...minimal.trial, forwardEnv: ['DEEPSEEK_API_KEY'], env: { DSH_TELEMETRY_DISABLED: '1' }, maxPromptGrowth: 0.1 },
      selection: { costPerGain: 2 },
      calibration: { method: 'z', seed: 0 },
    })
    expect(problems).toEqual([])
    expect(spec).toMatchObject({ branch: 'evolve/x', repository: '/repo', trial: { forwardEnv: ['DEEPSEEK_API_KEY'], env: { DSH_TELEMETRY_DISABLED: '1' }, maxPromptGrowth: 0.1 } })
    expect(spec.settings).toMatchObject({ delta: 0.02, rounds: 5, selection: { costPerGain: { value: 2, perPass: false } } })
    expect(spec.calibration).toEqual({ method: 'z', z: 2, resamples: 2_000, seed: 0 })
  })

  it('names the calibration method a calibrated spec needs, and settings it cannot use', () => {
    expect(resolved({ ...minimal, calibration: { method: 'spread' } })).toMatchObject({ problems: [], spec: { calibration: { method: 'spread' } } })
    expect(resolved({ ...minimal, delta: 0.02, calibration: undefined })).toMatchObject({ problems: [], spec: { calibration: undefined } })
    expect(resolved({ ...minimal, calibration: undefined }).problems).toEqual(['calibration.method must be "spread" or "z" when delta is "calibrate"'])
    expect(resolved({ ...minimal, delta: 0.02, calibration: { method: 'median' } }).problems).toEqual(['calibration.method must be "spread" or "z"'])
    expect(resolved({ ...minimal, delta: 0.02, calibration: { z: 3 } }).problems).toEqual(['calibration.method must be "spread" or "z"'])
    expect(resolved({ ...minimal, calibration: { method: 'spread', z: 3, seed: 1 } }).problems).toEqual([
      'calibration.z applies only to the z method',
      'calibration.seed applies only to the z method',
    ])
  })

  it('names every invalid field', () => {
    const { problems } = resolved({
      name: 'bad name',
      evolvedDirectory: '/abs',
      trial: { policyPatches: [], provider: '', forwardEnv: 'KEY', env: { A: 1 }, maxPromptGrowth: -1 },
      roles: 'x',
      delta: -1,
      variants: 27,
      rounds: 1.5,
      maxMissingFraction: 2,
      minEdits: 5,
      selection: { costWeight: 'high' },
    })
    expect(problems).toEqual([
      'name must be letters, digits, \'.\', \'_\', or \'-\'',
      'roles must be an object',
      'delta must be a non-negative number or "calibrate"',
      'evolvedDirectory must be relative to the repository root',
      'trial.policyPatches must name at least one frozen patch',
      'rounds must be an integer from 1 to 9007199254740991',
      'variants must be an integer from 1 to 26',
      'maxMissingFraction must be between 0 and 1',
      'selection.costWeight must be a number',
      'minEdits must not exceed maxEdits',
      'trial.maxPromptGrowth must be a non-negative number',
      'suite must be non-empty text',
      'trial.provider must be non-empty text',
      'trial.model must be non-empty text',
      'trial.forwardEnv must be an array of non-empty strings',
      'trial.env must map names to strings',
      'roles.provider must be non-empty text',
      'roles.model must be non-empty text',
    ])
    expect(resolved([]).problems).toContain('the run spec must be a JSON object')
  })
})

describe('loadRunSpec', () => {
  it('reads a spec file and reports invalid ones', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-self-improve-spec-'))
    roots.push(root)
    await writeFile(join(root, 'run.json'), JSON.stringify(minimal))
    expect((await loadRunSpec(join(root, 'run.json'))).suite).toBe(join(root, 'suite.json'))
    await writeFile(join(root, 'broken.json'), '{')
    await expect(loadRunSpec(join(root, 'broken.json'))).rejects.toThrow('is not JSON')
    await writeFile(join(root, 'invalid.json'), JSON.stringify({ ...minimal, delta: 'soon' }))
    await expect(loadRunSpec(join(root, 'invalid.json'))).rejects.toThrow('is invalid:\n- delta must be a non-negative number or "calibrate"')
  })
})
