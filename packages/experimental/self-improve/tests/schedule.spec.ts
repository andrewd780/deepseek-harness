import { describe, expect, it } from 'vitest'
import { editBudget } from '../src/schedule.ts'

describe('editBudget', () => {
  it('anneals on a cosine schedule from the maximum in round 0 to the minimum in the last round', () => {
    expect(Array.from({ length: 20 }, (_, round) => editBudget(round, 20, 1, 4)))
      .toEqual([4, 4, 4, 4, 4, 4, 4, 4, 3, 3, 3, 3, 2, 2, 2, 2, 2, 2, 2, 1])
    expect(Array.from({ length: 5 }, (_, round) => editBudget(round, 5, 1, 3))).toEqual([3, 3, 2, 2, 1])
    expect(Array.from({ length: 2 }, (_, round) => editBudget(round, 2, 1, 4))).toEqual([4, 1])
  })

  it('clamps rounds outside the run', () => {
    expect(editBudget(-3, 20, 1, 4)).toBe(4)
    expect(editBudget(25, 20, 1, 4)).toBe(1)
  })

  it('gives the maximum when the run has one round or none', () => {
    expect(editBudget(0, 1, 1, 4)).toBe(4)
    expect(editBudget(0, 0, 1, 4)).toBe(4)
    expect(editBudget(3, -1, 2, 5)).toBe(5)
  })
})
