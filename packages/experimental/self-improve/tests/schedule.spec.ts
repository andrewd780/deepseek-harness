import { describe, expect, it } from 'vitest'
import { editBudget } from '../src/schedule.ts'

describe('editBudget', () => {
  it('anneals from the maximum to the minimum on a cosine schedule', () => {
    expect(Array.from({ length: 21 }, (_, round) => editBudget(round, 20, 1, 4)))
      .toEqual([4, 4, 4, 4, 4, 4, 4, 4, 3, 3, 3, 3, 3, 2, 2, 2, 2, 2, 2, 2, 1])
    expect(Array.from({ length: 6 }, (_, round) => editBudget(round, 5, 1, 3))).toEqual([3, 3, 3, 2, 2, 1])
  })

  it('clamps rounds outside the run', () => {
    expect(editBudget(-3, 20, 1, 4)).toBe(4)
    expect(editBudget(25, 20, 1, 4)).toBe(1)
  })

  it('gives the maximum when the run has no rounds', () => {
    expect(editBudget(0, 0, 1, 4)).toBe(4)
    expect(editBudget(3, -1, 2, 5)).toBe(5)
  })
})
