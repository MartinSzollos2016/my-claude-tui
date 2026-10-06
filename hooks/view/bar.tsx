// The info bar above the prompt: project, branch, mode, agents, workflow, context and cost.
import { ICON_SETS, type Icons } from '../icons'
import { C, contextColor, modeColor, type ThemeKey } from '../theme'
import type { GitInfo } from '../../types'
import type { WorkflowState } from '../model/activity'
import { contextMeter, formatTokens, shortMode } from '../model/format'
import { displayWidth, truncateDisplay } from '../model/width'
import { BAR_METER_COLUMNS, METER_CELLS, type El } from './kit'

type BarData = {
  workflow?: WorkflowState
  project: string
  git: GitInfo | null
  mode: string | null
  runningAgents: number
  contextTokens?: number
  contextPercent?: number
  costUsd?: number
  columns: number
  // The glyph set; Nerd Font when left out.
  icons?: Icons
}

function workflowBadge(state: WorkflowState | undefined, icons: Icons): string {
  if (state === undefined || !state.isRunning) return ''
  if (state.agents === 0) return 'workflow running'
  return `workflow running ${icons.dot} ${state.agents} agent${state.agents === 1 ? '' : 's'}`
}

// One part of the bar: its text as drawn, which side it sits on and how
// long it stays when the bar is short (rank 0 stays longest).
type BarPart = {
  key: string
  side: 'left' | 'right'
  rank: number
  text: string
  color?: ThemeKey
  dim?: boolean
  bold?: boolean
}

const SEP_CELLS = 3
const PROJECT_MIN = 8

const lineWidth = (parts: readonly BarPart[]) => {
  const left = parts.filter(p => p.side === 'left')
  const right = parts.filter(p => p.side === 'right')
  const leftWidth = left.reduce((sum, p) => sum + displayWidth(p.text), 0) + SEP_CELLS * Math.max(0, left.length - 1)
  const rightWidth = right.reduce((sum, p) => sum + displayWidth(p.text), 0)
  return leftWidth + rightWidth + (left.length > 0 && right.length > 0 ? 1 : 0)
}

// The parts that fit one line of `columns` cells: the highest rank goes
// first (the later of equals first); a project still too wide is cut.
function fitBar(parts: readonly BarPart[], columns: number, ellipsis: string): BarPart[] {
  let kept = [...parts]
  while (kept.length > 0 && lineWidth(kept) > columns) {
    const worst = kept.reduce((at, p, i) => (p.rank >= kept[at]!.rank ? i : at), 0)
    if (kept[worst]!.key === 'project') {
      const room = columns - (lineWidth(kept) - displayWidth(kept[worst]!.text))
      // A name cut under PROJECT_MIN cells reads as nothing: drop it instead.
      if (room >= PROJECT_MIN) {
        kept[worst] = { ...kept[worst]!, text: truncateDisplay(kept[worst]!.text, room, ellipsis) }
        break
      }
    }
    kept = kept.filter((_, i) => i !== worst)
  }
  return kept
}

export function renderBar(el: El, data: BarData) {
  const { Box, Text } = el
  const icons = data.icons ?? ICON_SETS.nerd
  const mode = data.mode ? shortMode(data.mode) : ''
  const modeKey = modeColor(data.mode)
  const workflow = workflowBadge(data.workflow, icons)
  const percent = data.contextPercent
  const parts: BarPart[] = [
    { key: 'project', side: 'left' as const, rank: 1, text: data.project, dim: true },
    ...(data.git
      ? [{ key: 'branch', side: 'left' as const, rank: 2, text: `${icons.branch} ${data.git.branch}` }]
      : []),
    ...(mode !== ''
      ? [
          {
            key: 'mode',
            side: 'left' as const,
            rank: 3,
            text: mode,
            ...(modeKey === undefined ? { dim: true } : { color: modeKey, bold: true }),
          },
        ]
      : []),
    ...(data.runningAgents > 0
      ? [
          {
            key: 'agents',
            side: 'left' as const,
            rank: 4,
            text: `agents running ${icons.dot} ${data.runningAgents}`,
            color: C.ongoing,
          },
        ]
      : []),
    ...(workflow !== '' ? [{ key: 'workflow', side: 'left' as const, rank: 4, text: workflow, color: C.ongoing }] : []),
    ...(data.contextTokens !== undefined
      ? [
          {
            key: 'tokens',
            side: 'right' as const,
            rank: 6,
            text: `${formatTokens(data.contextTokens)} ctx `,
            dim: true,
          },
        ]
      : []),
    ...(percent !== undefined && data.columns >= BAR_METER_COLUMNS
      ? [
          {
            key: 'meter',
            side: 'right' as const,
            rank: 5,
            text: `${contextMeter(percent, METER_CELLS, icons)} `,
            color: contextColor(percent),
          },
        ]
      : []),
    ...(percent !== undefined
      ? [
          {
            key: 'percent',
            side: 'right' as const,
            rank: 0,
            text: `${Math.round(percent)}%`,
            color: contextColor(percent),
          },
        ]
      : []),
    ...(data.costUsd !== undefined
      ? [{ key: 'cost', side: 'right' as const, rank: 7, text: `  $${data.costUsd.toFixed(2)}`, dim: true }]
      : []),
  ]
  // One line, whatever the width: the bar never wraps a part or a word.
  const kept = fitBar(parts, data.columns, icons.ellipsis)
  const left = kept.filter(p => p.side === 'left')
  const right = kept.filter(p => p.side === 'right')
  const draw = (p: BarPart) =>
    p.key === 'branch' && data.git ? (
      <Box key={p.key} flexDirection="row" flexShrink={0}>
        <Text color={C.branch}>{`${icons.branch} `}</Text>
        <Text dimColor>{p.text.slice(icons.branch.length + 1)}</Text>
      </Box>
    ) : (
      <Text key={p.key} color={p.color} dimColor={p.dim === true} bold={p.bold === true}>
        {p.text}
      </Text>
    )
  // The meter and the percent read as one text in the context color.
  const meter = right.find(p => p.key === 'meter')
  const rightNodes = right
    .filter(p => p.key !== 'meter')
    .map(p => (p.key === 'percent' && meter ? draw({ ...p, text: meter.text + p.text }) : draw(p)))

  return (
    <Box flexDirection="row" justifyContent="space-between" width={data.columns}>
      <Box flexDirection="row" flexShrink={0}>
        {left.flatMap((p, i) => [
          ...(i === 0 ? [] : [<Text key={`sep-${p.key}`} color={C.muted}>{` ${icons.dot} `}</Text>]),
          draw(p),
        ])}
      </Box>
      <Box flexDirection="row" flexShrink={0}>
        {rightNodes}
      </Box>
    </Box>
  )
}
