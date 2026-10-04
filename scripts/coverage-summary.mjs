// Prints the Istanbul coverage totals as a Markdown table (for the CI job summary).
import { readFileSync } from 'node:fs'

const { total } = JSON.parse(readFileSync('coverage/coverage-summary.json', 'utf8'))
const rows = ['lines', 'statements', 'functions', 'branches'].map(k => `| ${k} | ${total[k].pct} % |`)
console.log(['### Unit test coverage', '', '| | |', '|---|---|', ...rows].join('\n'))
