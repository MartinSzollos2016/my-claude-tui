import { describe, expect, test } from 'claude-code/testing'
import { gitDirFrom, parseGitHead } from '../hooks/model/git'

describe('parseGitHead', () => {
  test('a branch ref gives the branch name', () => {
    expect(parseGitHead('ref: refs/heads/feat/x\n')).toEqual({ branch: 'feat/x' })
  })

  test('a detached HEAD gives the short hash, anything else nothing', () => {
    expect(parseGitHead('0123456789abcdef0123456789abcdef01234567')).toEqual({ branch: '0123456' })
    expect(parseGitHead('garbage')).toBeNull()
  })
})

describe('gitDirFrom', () => {
  test('an absolute gitdir stays, a relative one is read from the worktree root', () => {
    expect(gitDirFrom('/w', 'gitdir: /r/.git/worktrees/w\n')).toBe('/r/.git/worktrees/w')
    expect(gitDirFrom('/w', 'gitdir: ../r/.git')).toBe('/w/../r/.git')
  })

  test('a file that names no gitdir gives nothing', () => {
    expect(gitDirFrom('/w', 'ref: x')).toBeNull()
  })
})
