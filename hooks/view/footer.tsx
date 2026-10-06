// The pinned footer: the keys each view draws in groups (hidden ones keep their
// hotkeys), where the page keys go, and the status row with the focus note.
import type { RenderSurface } from 'claude-code'
import { C, type ThemeKey } from '../theme'
import { footerLayout, footerPads, type FooterLayout } from '../model/footer'
import { clampScroll, pageScroll, type ScrollFrame } from '../model/scroll'
import { displayWidth } from '../model/width'
import type { Ctx, PaneActions } from './context'
import { buttonHover, cutter, type El } from './kit'

// One key of the footer: always a button with its hotkey; `isOn` says whether
// a press acts. Without labels only the key and glyph remain.
type FooterKey = {
  key: string
  hotkey: string
  glyph?: string
  // The glyph comes after the label, not before it.
  isGlyphAfter?: boolean
  // What stands for the key when the pane has no room for words.
  short: string
  label: string
  isOn: boolean
  // Drawn in this view; a key that is not keeps its hotkey in a hidden box.
  isShown: boolean
  onPress: (e: { surface?: RenderSurface }) => void
}

// The footer under the window: a rule, the keys in groups and the status
// line. The page keys end the views row, or start the status row when the
// views row has no room for them.
export function renderFooter(el: El, data: Ctx, act: PaneActions, layout: FooterLayout, frame: ScrollFrame) {
  const { Box, Text } = el
  const { icons } = data
  const groups = footerGroups(data, act, frame)
  const plan = footerPlan(groups, layout, data.columns)
  const { leftWidth, page, isPageInRow } = plan
  const textOf = (k: FooterKey) => footerText(k, layout)
  // The gap between keys is part of the key before it (trailing cells of its
  // label), so the row has no cell a click falls through; given a width, the
  // last key fills the column up to it.
  const keys = (group: readonly FooterKey[], width?: number) => {
    const pads = footerPads(
      group.map(k => displayWidth(textOf(k))),
      KEY_GAP,
      width,
    )
    return group.map((k, i) => renderFooterKey(el, k, footerLabel(k, layout.labels), pads[i] ?? 0))
  }
  const inner = data.columns - STATUS_INSET
  const pageWidth = displayWidth(page.map(textOf).join('  '))
  // A row of two columns: the left keys padded up to the separator, then the
  // right ones; a row with one side only draws no separator.
  const rows = plan.rows.map(row =>
    row.left === undefined || row.left.length === 0 ? (
      <Box key={`footer-row-${row.id}`} flexDirection="row">
        {keys(row.keys)}
      </Box>
    ) : (
      <Box key={`footer-row-${row.id}`} flexDirection="row">
        <Box key={`footer-left-${row.id}`} flexDirection="row" width={leftWidth + KEY_GAP} flexShrink={0}>
          {keys(row.left, leftWidth + KEY_GAP)}
        </Box>
        {row.keys.length > 0 && (
          <Box key={`footer-divider-${row.id}`} width={1 + KEY_GAP} flexShrink={0}>
            <Text key={`footer-sep-${row.id}`} color={C.muted}>
              {icons.columnSep}
            </Text>
          </Box>
        )}
        {row.keys.length > 0 && (
          <Box key={`footer-right-${row.id}`} flexDirection="row">
            {keys(row.keys)}
          </Box>
        )}
      </Box>
    ),
  )
  const statusBox = (width: number) => {
    const status = footerStatus(data, width, frame)
    return (
      <Box key="footer-status" flexDirection="row" justifyContent="flex-end" width={status.width}>
        {status.parts.map(part => (
          <Text key={part.key} color={part.color}>
            {part.text}
          </Text>
        ))}
      </Box>
    )
  }
  // Bare: one row, no rule, the collapsed keys with h and the status at its
  // shortest; a pane too short for more keeps every key by its hotkey.
  if (layout.mode === 'bare') {
    const bare = collapsedPlan(groups, data, layout, data.columns, { isRowForced: true })
    const keysWidth = displayWidth(bare.keys.map(textOf).join('  '))
    return (
      <Box key="footer" flexDirection="column" width={data.columns} backgroundColor={C.paneBackground}>
        <Box key="footer-row-keys" flexDirection="row" width={inner}>
          <Box key="footer-keys" flexDirection="row" flexShrink={0}>
            {keys(bare.keys)}
          </Box>
          {statusBox(inner - keysWidth)}
        </Box>
        <Box key="footer-hidden" display="none">
          {bare.hidden.map(k => renderFooterKey(el, k, footerLabel(k, layout.labels), 0))}
        </Box>
      </Box>
    )
  }
  // Collapsed: one row of the keys that act now with the status at its end,
  // or below it when both do not fit; the rest keep their hotkeys hidden.
  if (data.isFooterOpen !== true || layout.mode === 'collapsed') {
    const collapsed = collapsedPlan(groups, data, layout, data.columns)
    const keysWidth = displayWidth(collapsed.keys.map(textOf).join('  '))
    const keysRow = keys(collapsed.keys)
    return (
      <Box key="footer" flexDirection="column" width={data.columns} backgroundColor={C.paneBackground}>
        <Text key="footer-rule" color={C.muted}>
          {icons.rule.repeat(data.columns)}
        </Text>
        {collapsed.isStatusInRow ? (
          <Box key="footer-row-keys" flexDirection="row" width={inner}>
            <Box key="footer-keys" flexDirection="row" flexShrink={0}>
              {keysRow}
            </Box>
            {statusBox(inner - keysWidth)}
          </Box>
        ) : (
          <Box key="footer-row-keys" flexDirection="row">
            {keysRow}
          </Box>
        )}
        {!collapsed.isStatusInRow && statusBox(inner)}
        <Box key="footer-hidden" display="none">
          {collapsed.hidden.map(k => renderFooterKey(el, k, footerLabel(k, layout.labels), 0))}
        </Box>
      </Box>
    )
  }
  return (
    <Box key="footer" flexDirection="column" width={data.columns} backgroundColor={C.paneBackground}>
      <Text key="footer-rule" color={C.muted}>
        {icons.rule.repeat(data.columns)}
      </Text>
      {rows}
      {isPageInRow ? (
        statusBox(inner)
      ) : (
        <Box key="footer-last" flexDirection="row" gap={2} width={inner}>
          <Box key="footer-page" flexDirection="row" flexShrink={0}>
            {keys(page)}
          </Box>
          {statusBox(inner - pageWidth - 2)}
        </Box>
      )}
      {plan.hidden.length > 0 && (
        <Box key="footer-hidden" display="none">
          {plan.hidden.map(k => renderFooterKey(el, k, footerLabel(k, layout.labels), 0))}
        </Box>
      )}
    </Box>
  )
}

// As the engine draws a footer button: `<key>: <label>`.
const footerText = (k: FooterKey, layout: FooterLayout) => `${k.hotkey}: ${footerLabel(k, layout.labels)}`

// What the footer draws for a view: the rows of the keys it shows, two
// columns (`left` and `keys`) or one group each, where the page keys go,
// and the keys it hides, which keep their hotkeys.
type FooterRow = { id: string; left?: readonly FooterKey[]; keys: readonly FooterKey[] }

type FooterPlan = {
  rows: FooterRow[]
  leftWidth: number
  page: readonly FooterKey[]
  isPageInRow: boolean
  hidden: FooterKey[]
}

export function footerPlan(groups: FooterGroups, layout: FooterLayout, columns: number): FooterPlan {
  const shown = (group: readonly FooterKey[]) => group.filter(k => k.isShown)
  const [move, cursor, views, expand, page] = [
    groups.move,
    groups.cursor,
    groups.views,
    groups.expand,
    groups.page,
  ].map(shown) as [FooterKey[], FooterKey[], FooterKey[], FooterKey[], FooterKey[]]
  const groupWidth = (group: readonly FooterKey[]) => displayWidth(group.map(k => footerText(k, layout)).join('  '))
  const inner = columns - STATUS_INSET
  const leftWidth = Math.max(groupWidth(move), groupWidth(views))
  const isTwo = layout.columns === 'two'
  // The views row with the page keys at its end: the left column and the
  // separator (two gaps around it), then the expand keys.
  const help = groups.help
  const isPageInRow = (isTwo ? leftWidth + 5 : 0) + groupWidth([...expand, ...help]) + 2 + groupWidth(page) <= inner
  const expandKeys = isPageInRow ? [...expand, ...page, ...help] : [...expand, ...help]
  const rows: FooterRow[] = isTwo
    ? [
        { id: '1', left: move, keys: cursor },
        { id: '2', left: views, keys: expandKeys },
      ]
    : [
        { id: 'move', keys: move },
        { id: 'cursor', keys: cursor },
        { id: 'views', keys: views },
        { id: 'expand', keys: expandKeys },
      ]
  const all = allKeys(groups)
  return {
    rows: rows.filter(row => (row.left?.length ?? 0) + row.keys.length > 0),
    leftWidth,
    page,
    isPageInRow,
    hidden: all.filter(k => !k.isShown),
  }
}

const allKeys = (groups: FooterGroups) =>
  [groups.move, groups.cursor, groups.views, groups.expand, groups.page, groups.help].flat()

// The keys a collapsed footer shows, by view, most wanted first; only those
// that act now, as many as fit, `h` always last.
const PRIORITY: Record<'detail' | 'turns' | 'team', readonly string[]> = {
  detail: [
    'prev',
    'next',
    'down',
    'up',
    'open',
    'turns',
    'pagedown',
    'pageup',
    'latest',
    'expand',
    'search',
    'team',
    'copy',
  ],
  turns: ['down', 'up', 'open', 'search', 'detail', 'pagedown', 'pageup', 'team'],
  team: ['detail', 'turns', 'search', 'pagedown', 'pageup'],
}

type CollapsedPlan = { keys: FooterKey[]; hidden: FooterKey[]; isStatusInRow: boolean }

// `isRowForced`: the bare row, the status in it at its shortest.
function collapsedPlan(
  groups: FooterGroups,
  data: Ctx,
  layout: FooterLayout,
  columns: number,
  options: { isRowForced?: boolean } = {},
): CollapsedPlan {
  const all = allKeys(groups)
  const byName = new Map(all.map(k => [k.key.slice('nav-'.length), k] as const))
  const help = groups.help[0]!
  const width = (k: FooterKey) => displayWidth(footerText(k, layout))
  const inner = columns - STATUS_INSET
  // The status keeps its place at the end of the row while it takes at most
  // half of it; a longer one goes below and the keys get the whole row.
  const isStatusInRow = options.isRowForced === true || (statusWidthOf(data) + KEY_GAP) * 2 <= inner
  const statusCells =
    (options.isRowForced === true
      ? joinWidth(statusVariants(data, '').at(-1)!, ` ${data.icons.dot} `)
      : statusWidthOf(data)) + KEY_GAP
  const room = inner - width(help) - (isStatusInRow ? statusCells : 0)
  const keys: FooterKey[] = []
  let used = 0
  for (const name of PRIORITY[data.view]) {
    const k = byName.get(name)
    if (k === undefined || !k.isOn) continue
    const cells = width(k) + KEY_GAP
    if (used + cells > room) continue
    keys.push(k)
    used += cells
  }
  keys.push(help)
  const shown = new Set(keys)
  return { keys, hidden: all.filter(k => !shown.has(k)), isStatusInRow }
}

// The keys a view does not draw: its own key (d in the detail view, t in the
// turn list, m on the team board), those that act on the detail turn outside
// the detail view; on the team board the cursor too.
const HIDDEN_KEYS: Record<'detail' | 'turns' | 'team', ReadonlySet<string>> = {
  detail: new Set(['detail']),
  turns: new Set(['prev', 'next', 'latest', 'copy', 'turns', 'expand', 'collapse']),
  team: new Set(['prev', 'next', 'latest', 'down', 'up', 'open', 'copy', 'team', 'expand', 'collapse']),
}

// The rows the footer of this pane draws, for the window's height: the plan
// of the keys does not depend on where the window stands.
// The footers a pane steps down through when it is short of rows: the one
// the person asked for, the collapsed one, one bare row.
export type FooterMode = 'full' | 'collapsed' | 'bare'

export function footerRowsOf(data: Ctx, act: PaneActions, mode: FooterMode = 'full'): FooterLayout {
  const all = footerLayout(data.columns)
  if (mode === 'bare') return { ...footerLayout(data.columns, 0), rows: 1, mode: 'bare' }
  const groups = footerGroups(data, act, { scrollTop: 0, windowRows: 1, total: 0, starts: {} })
  if (mode === 'collapsed' || data.isFooterOpen !== true) {
    const plan = collapsedPlan(groups, data, all, data.columns)
    const layout = footerLayout(data.columns, plan.isStatusInRow ? 0 : 1)
    return mode === 'collapsed' ? { ...layout, mode: 'collapsed' } : layout
  }
  return footerLayout(data.columns, footerPlan(groups, all, data.columns).rows.length)
}

// The chord that gives the pane the keyboard (a click does too): pressed
// twice while the info bar shows, which the engine focuses first.
export const focusChord = (data: Ctx) => (data.isBarShown === true ? `ctrl+x tab ${data.icons.times}2` : 'ctrl+x tab')

// The status row: the position of the turn and the focus note, right-aligned
// inside the pane's frame and padding (STATUS_INSET cells) and cut with the
// set's ellipsis when it does not fit `room` cells.
export const STATUS_INSET = 2

type StatusSegment = { key: string; text: string; color: ThemeKey }

// The status variants from the fullest to the shortest: the focus note
// shortens first, then the place goes, then `live`; the position stays.
function statusVariants(data: Ctx, place: string): StatusSegment[][] {
  const total = data.turns.length
  const pos = total > 0 ? `${data.selected + 1}/${total}` : ''
  const live = total > 0 && data.isLatest ? `${pos} live` : pos
  const focused = data.isFocused === true
  const noteColor = focused ? C.accent : C.muted
  const long = data.isFocused === undefined ? '' : focused ? 'keys on' : `click or ${focusChord(data)}`
  const short = data.isFocused === undefined ? '' : focused ? 'keys on' : 'click for keys'
  const seg = (key: string, text: string, color: ThemeKey = C.muted): StatusSegment => ({ key, text, color })
  const variant = (position: string, where: string, note: string) =>
    [seg('turn-position', position), seg('scroll-place', where), seg('focus-note', note, noteColor)].filter(
      s => s.text !== '',
    )
  return [
    variant(live, place, long),
    variant(live, place, short),
    variant(live, '', short),
    variant(pos, '', short),
    variant(pos, '', ''),
  ]
}

const joinWidth = (segments: readonly StatusSegment[], dot: string) => displayWidth(segments.map(s => s.text).join(dot))

// The width the status needs beside the collapsed keys: the position (with
// `live`) and the short focus note, the place left out. The collapsed footer
// decides from it whether the status fits in the row, before the window (and
// so the place) is known; with more room the status draws its fuller forms.
function statusWidthOf(data: Ctx): number {
  return joinWidth(statusVariants(data, 'end')[2]!, ` ${data.icons.dot} `)
}

export function footerStatus(data: Ctx, room: number, frame: ScrollFrame) {
  const { icons } = data
  const width = Math.max(1, room)
  // Where the window stands while the content overflows: at its top or end.
  const lastTop = clampScroll(Infinity, frame.total, frame.windowRows)
  const place = lastTop === 0 ? '' : frame.scrollTop === 0 ? 'top' : frame.scrollTop >= lastTop ? 'end' : ''
  const dot = ` ${icons.dot} `
  const variants = statusVariants(data, place)
  const segments = variants.find(v => joinWidth(v, dot) <= width) ?? variants.at(-1)!
  // The segments with a dot between each two, cut as one text.
  const pieces = segments.flatMap((segment, i) => [
    ...(i === 0 ? [] : [{ key: `footer-dot-${i}`, text: dot, color: C.muted }]),
    segment,
  ])
  const cut = cutter(icons)(pieces.map(piece => piece.text).join(''), width)
  let at = 0
  const parts = pieces.map(piece => {
    const text = cut.slice(at, at + piece.text.length)
    at += piece.text.length
    return { ...piece, text }
  })
  return { width, parts: parts.filter(part => part.text !== '') }
}

// The label of a key: glyph and words in the order they read; the glyph alone
// when the pane is too narrow for words.
function footerLabel(k: FooterKey, hasLabels: boolean): string {
  if (!hasLabels) return k.short
  const parts = k.isGlyphAfter === true ? [k.label, k.glyph] : [k.glyph, k.label]
  return parts.filter(part => part !== undefined && part !== '').join(' ')
}

// The cells between two keys of the footer.
const KEY_GAP = 2

// Every key is a Button with its hotkey, also when it cannot act: a key
// drawn without one would fall through to the prompt and take the focus
// from the pane. Out of reach, the press is swallowed and changes nothing.
const swallow = (): undefined => undefined

function renderFooterKey(el: El, k: FooterKey, label: string, pad: number) {
  const { Button } = el
  return (
    <Button
      key={k.key}
      plain
      dimColor
      hover={buttonHover(`btn:${k.key}`)}
      hotkey={k.hotkey}
      label={`${label}${' '.repeat(pad)}`}
      onPress={k.isOn ? k.onPress : swallow}
    />
  )
}

// The keys by purpose: moving between turns, the cursor over rows, the views,
// expanding and paging the window, and the key that shows them all.
type FooterGroups = Record<'move' | 'cursor' | 'views' | 'expand' | 'page' | 'help', FooterKey[]>

export function footerGroups(data: Ctx, act: PaneActions, frame: ScrollFrame): FooterGroups {
  const { icons } = data
  const total = data.turns.length
  const hasTeam = (data.members?.length ?? 0) + (data.tasks?.length ?? 0) > 0
  const hasRows = (data.turns[data.selected]?.items.length ?? 0) > 0
  const hasCursor = hasRows && data.cursor !== undefined && data.cursor !== null
  const isDetail = data.view === 'detail'
  // The turn list's cursor moves over the turn rows it draws.
  const hasTurnRows = data.view === 'turns' && Object.keys(frame.starts).some(id => id.startsWith('turn:'))
  const hasTurnCursor = data.view === 'turns' && data.turnCursor !== undefined && data.turnCursor !== null
  // The page keys work in every view: b does nothing at the top, f at the end.
  const lastTop = clampScroll(Infinity, frame.total, frame.windowRows)
  const paged = (delta: number) =>
    clampScroll(pageScroll(frame.scrollTop, delta, frame.windowRows), frame.total, frame.windowRows)
  const key = (
    name: string,
    hotkey: string,
    label: string,
    short: string,
    isOn: boolean,
    onPress: FooterKey['onPress'],
    glyph?: string,
    isGlyphAfter?: boolean,
  ): FooterKey => ({
    key: `nav-${name}`,
    hotkey,
    label,
    short,
    isOn,
    isShown: !HIDDEN_KEYS[data.view].has(name),
    onPress,
    ...(glyph === undefined ? {} : { glyph }),
    ...(isGlyphAfter === true ? { isGlyphAfter } : {}),
  })
  // Keys that act on the detail turn do nothing in the turn list and the team
  // board, which do not show it.
  return {
    move: [
      key('prev', 'p', 'prev', icons.navPrev, isDetail && data.selected > 0, act.prev, icons.navPrev),
      key('next', 'n', 'next', icons.navNext, isDetail && data.selected < total - 1, act.next, icons.navNext, true),
      key('latest', 'l', 'latest', icons.keyLatest, isDetail && !data.isLatest, act.latest),
    ],
    cursor: [
      key(
        'down',
        'j',
        '',
        icons.cursorDown,
        (isDetail && hasRows) || hasTurnRows,
        () => act.cursorDown(frame),
        icons.cursorDown,
      ),
      key(
        'up',
        'k',
        '',
        icons.cursorUp,
        (isDetail && hasRows) || hasTurnRows,
        () => act.cursorUp(frame),
        icons.cursorUp,
      ),
      key('open', 'o', 'open', icons.keyOpen, (isDetail && hasCursor) || hasTurnCursor, act.cursorOpen),
      key('copy', 'y', 'copy', icons.keyCopy, isDetail && hasCursor, press => act.copyCursor(press.surface)),
    ],
    views: [
      // Both view keys stay bound in every view: the key of the view the pane
      // is in is hidden and does nothing, so it never reaches the prompt.
      key('turns', 't', 'turns', icons.keyTurns, data.view !== 'turns', act.showTurns),
      key('detail', 'd', 'detail', icons.keyDetail, !isDetail, act.showDetail),
      key('search', 's', 'search', icons.keySearch, true, act.focusSearch),
      key('team', 'm', 'team', icons.keyTeam, hasTeam && data.view !== 'team', act.showTeam),
    ],
    expand: [
      key('expand', 'e', 'expand', icons.keyExpand, isDetail && hasRows && data.isAllExpanded !== true, act.expandAll),
      key('collapse', 'c', 'collapse', icons.keyCollapse, isDetail && hasRows, act.collapseAll),
    ],
    page: [
      key('pageup', 'b', 'page', icons.pageUp, frame.scrollTop > 0, () => act.scroll(paged(-1)), icons.pageUp),
      key(
        'pagedown',
        'f',
        'page',
        icons.pageDown,
        frame.scrollTop < lastTop,
        () => act.scroll(paged(1)),
        icons.pageDown,
      ),
    ],
    help: [
      key(
        'keys',
        'h',
        data.isFooterOpen === true ? 'less' : 'keys',
        data.isFooterOpen === true ? icons.times : '?',
        true,
        act.toggleKeys,
      ),
    ],
  }
}
