import { describe, expect, test } from 'claude-code/testing'
import { ICON_SETS } from '../hooks/icons'
import { renderTeam } from '../hooks/view/team'
import { base, el, text } from './fixtures/view'

describe('renderTeam', () => {
  const draw = (extra: Record<string, unknown>) => {
    const data = { ...base, icons: ICON_SETS.nerd, budget: { left: 100_000 }, layout: [], ...extra }
    return renderTeam(el, data as unknown as Parameters<typeof renderTeam>[1])
  }

  test('lists the teammates and the tasks under the header', () => {
    const parts = draw({
      members: [{ name: 'alice', type: 'teammate', status: 'running' }],
      tasks: [{ id: '1', subject: 'Write tests', status: 'in_progress', owner: 'alice' }],
    })
    expect(text(parts.content)).toContain('alice')
    expect(text(parts.content)).toContain('Write tests')
  })

  test('says how teammates and tasks show up when there are none', () => {
    const content = text(draw({ members: [], tasks: [] }).content)
    expect(content).toContain('No teammates in this session.')
    expect(content).toContain('No tasks yet.')
  })
})
