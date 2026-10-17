// The desktop app's bars: thin rounded lines it draws as images (Svg), as its
// own context bar is, instead of block glyphs that its proportional font
// widens past their cells. Only remote surfaces have Svg; elsewhere, none.
import type { El } from './kit'

// An image takes no theme key: a grey track at a third of its strength and a
// blue fill read on a light or a dark theme alike; the longest takes the
// accent's orange.
const TRACK = '#888888'
const FILL = '#5b8def'
const ACCENT = '#d97757'
const HEIGHT = 4

// A bar `widthPx` wide filled to `fraction` (0 to 1).
export function flowBar(el: El, fraction: number, widthPx: number, isAccent = false) {
  const { Svg } = el
  if (Svg === undefined) return undefined
  const part = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0))
  const filled = part > 0 ? Math.max(HEIGHT / 2, part * widthPx) : 0
  const rect = (width: number, fill: string, opacity = 1) =>
    `<rect width="${width.toFixed(1)}" height="${HEIGHT}" rx="${HEIGHT / 2}" fill="${fill}" fill-opacity="${opacity}"/>`
  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${widthPx}" height="${HEIGHT}" viewBox="0 0 ${widthPx} ${HEIGHT}">` +
    rect(widthPx, TRACK, 0.3) +
    (filled > 0 ? rect(filled, isAccent ? ACCENT : FILL) : '') +
    '</svg>'
  return <Svg source={source} alt={`${Math.round(part * 100)}%`} width={widthPx} height={HEIGHT} />
}
