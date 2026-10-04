// The info bar's branch, read from .git/HEAD (a worktree's .git names its git dir).
import { sanitizeText } from './sanitize'

//
// The info bar's branch comes from reading .git/HEAD rather than running git:
// no program starts, and a cloned repository's config cannot run anything.

// "ref: refs/heads/main" -> main; a detached HEAD (a bare hash) -> its short hash.
export function parseGitHead(content: string): { branch: string } | null {
  const head = sanitizeText(content).trim()
  if (head.startsWith('ref: refs/heads/')) return { branch: head.slice('ref: refs/heads/'.length) }
  return /^[0-9a-f]{40,64}$/.test(head) ? { branch: head.slice(0, 7) } : null
}

// A worktree's .git is a file naming its git directory ("gitdir: <path>"),
// absolute or relative to the worktree.
export function gitDirFrom(root: string, dotGitFile: string): string | null {
  const line = dotGitFile.trim()
  if (!line.startsWith('gitdir: ')) return null
  const dir = line.slice('gitdir: '.length).trim()
  return dir.startsWith('/') ? dir : `${root}/${dir}`
}
