// The desktop app's bars: a box of fixed width filled from the left in the
// theme's colours, instead of block glyphs that its proportional font widens
// past their cells. Not images (Svg): the app froze drawing them in the pane.
import { C } from '../theme'
import type { El } from './kit'

// A bar `cells` wide filled to `fraction` (0 to 1); the longest in the
// brand's colour. `key` names it for its row.
export function flowBar(el: El, key: string, fraction: number, cells: number, isLongest = false) {
  const { Box } = el
  const part = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0))
  const filled = part > 0 ? Math.max(1, Math.round(part * cells)) : 0
  return (
    <Box key={`flow-bar-${key}`} width={cells} height={1} flexShrink={0} overflow="hidden" backgroundColor={C.rowHover}>
      <Box key={`flow-bar-fill-${key}`} width={filled} height={1} backgroundColor={isLongest ? C.brand : C.accent} />
    </Box>
  )
}
