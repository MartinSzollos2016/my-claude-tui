import { describe, expect, test } from 'claude-code/testing'
import { footerLayout, footerPads } from '../hooks/model/footer'

describe('footerLayout', () => {
  test('two columns with labels from 64 columns up', () => {
    expect(footerLayout(100)).toEqual({ rows: 4, columns: 'two', labels: true })
    expect(footerLayout(64)).toEqual({ rows: 4, columns: 'two', labels: true })
  })

  test('stacked groups with labels from 40 to 63 columns', () => {
    expect(footerLayout(63)).toEqual({ rows: 6, columns: 'stacked', labels: true })
    expect(footerLayout(40)).toEqual({ rows: 6, columns: 'stacked', labels: true })
  })

  test('stacked groups without labels under 40 columns', () => {
    expect(footerLayout(39)).toEqual({ rows: 6, columns: 'stacked', labels: false })
    expect(footerLayout(0)).toEqual({ rows: 6, columns: 'stacked', labels: false })
  })
})

describe('footerLayout with the rows a view draws', () => {
  test('the footer is the rule, the group rows the view draws and the status row', () => {
    expect(footerLayout(100, 2).rows).toBe(4)
    expect(footerLayout(100, 1).rows).toBe(3)
    expect(footerLayout(60, 3).rows).toBe(5)
    expect(footerLayout(36, 4)).toEqual({ rows: 6, columns: 'stacked', labels: false })
  })
})

describe('footerPads', () => {
  test('every key but the last takes the gap after it', () => {
    expect(footerPads([9, 9, 9], 2)).toEqual([2, 2, 0])
    expect(footerPads([4], 2)).toEqual([0])
    expect(footerPads([], 2)).toEqual([])
  })

  test('with a width the last key fills the row up to it, never below zero', () => {
    expect(footerPads([9, 9, 9], 2, 35)).toEqual([2, 2, 4])
    expect(footerPads([9, 9, 9], 2, 31)).toEqual([2, 2, 0])
    expect(footerPads([9, 9, 9], 2, 20)).toEqual([2, 2, 0])
  })
})
