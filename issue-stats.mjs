#!/usr/bin/env node
// Renders a Twitter-sized PNG of new issues opened (or pull requests merged, or the ratio
// of the two) in pnpm/pnpm, per day, week or month.
// Usage: node issue-stats.mjs [issues|merged-prs|ratio|pr-types] [--mode weekly|daily|monthly] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--repo owner/name] [--out file.png] [--text] [--no-cache]
// The merged-prs command counts PRs by merge date and defaults --since to the start of the month a year ago.
// The ratio command charts merged PRs per new issue, with the same --since default.
// The pr-types command stacks merged PRs by conventional-commit title prefix (fix, feat, perf, other).
// Finished past windows are cached under ~/.cache/issue-stats; --no-cache refetches them.
// --text prints the numbers to the console only, without rendering a PNG (no Chromium needed).
// --until is exclusive and defaults to today (UTC), so the current day is never counted as a full day.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const DAY = 86400000
const argv = process.argv.slice(2)
const args = {}
const command = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'issues'
if (!['issues', 'merged-prs', 'ratio', 'pr-types'].includes(command)) {
  console.error(`Unknown command "${command}". Use "issues", "merged-prs", "ratio" or "pr-types".`)
  process.exit(1)
}
const types = command === 'pr-types'
const prs = command === 'merged-prs' || types
const ratio = command === 'ratio'
argv.forEach((a, i) => {
  if (!a.startsWith('--')) return
  const next = argv[i + 1]
  args[a.slice(2)] = next === undefined || next.startsWith('--') ? true : next
})
const textOnly = args.text === true
const mode = args.mode ?? 'weekly'
const repo = args.repo ?? 'pnpm/pnpm'
if (!['weekly', 'daily', 'monthly'].includes(mode)) {
  console.error(`Unknown --mode "${mode}". Use weekly, daily or monthly.`)
  process.exit(1)
}
const today = Math.floor(Date.now() / DAY) * DAY
const yearAgo = () => { const d = new Date(today); return Date.UTC(d.getUTCFullYear() - 1, d.getUTCMonth(), 1) }
const since = args.since ? Date.parse(args.since + 'T00:00:00Z') : prs || ratio ? yearAgo() : Date.parse('2026-09-27T00:00:00Z')
const until = args.until ? Date.parse(args.until + 'T00:00:00Z') : today
const unit = { weekly: 'week', daily: 'day', monthly: 'month' }[mode]
const what = types ? 'merged-pr-types' : ratio ? 'pr-issue-ratio' : prs ? 'merged-prs' : 'new-issues'
const out = args.out ?? `${repo.split('/')[1]}-${what}-per-${unit}.png`
const fmtV = v => ratio ? v.toFixed(1) : String(v)

const fmtMonth = t => new Date(t).toLocaleString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' }).replace(' ', " '")
const fmt = t => { const d = new Date(t); return `${d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })} ${d.getUTCDate()}` }
const iso = t => new Date(t).toISOString().slice(0, 10)

// Search caps a query at 1000 results, so fetch in windows (merged PRs are far more
// numerous than issues, hence the shorter window). GraphQL search is used because the
// REST search endpoint is limited to 30 requests per minute, too few for a year of PRs.
const searchQuery = `query($q: String!, $endCursor: String) {
  search(query: $q, type: ISSUE, first: 100, after: $endCursor) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes { ... on Issue { createdAt } ... on PullRequest { mergedAt title } }
  }
}`
// Windows are aligned to a fixed grid (counted from the Unix epoch) rather than to --since,
// so the same window is reused whatever range is asked for. A window that ended more than
// CACHE_MARGIN days ago is cached on disk: past issues and merges don't change (the margin
// covers search index lag). --no-cache refetches everything.
const CACHE_MARGIN = 2
const cacheDir = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'issue-stats', repo.replace('/', '__'))
const useCache = args['no-cache'] !== true
// Returns { t, title } per item (title is only fetched for PRs).
const fetchItems = kind => {
  const win = (kind === 'prs' ? 7 : 28) * DAY
  const items = []
  for (let from = Math.floor(since / win) * win; from < until; from += win) {
    const to = from + win
    const cacheable = to <= today - CACHE_MARGIN * DAY
    const file = path.join(cacheDir, `${kind}-${iso(from)}-${iso(to - DAY)}.json`)
    let rows
    if (cacheable && useCache && fs.existsSync(file)) rows = JSON.parse(fs.readFileSync(file, 'utf8'))
    else {
      const range = `${iso(from)}..${iso(to - DAY)}`
      const q = kind === 'prs' ? `repo:${repo} is:pr is:merged merged:${range}` : `repo:${repo} is:issue created:${range}`
      const outText = execFileSync('gh', ['api', 'graphql', '--paginate', '-f', `query=${searchQuery}`, '-f', `q=${q}`,
        '--jq', '.data.search | (if .issueCount > 1000 then error("more than 1000 results: \\(.issueCount)") else . end) | .nodes[] | [.mergedAt // .createdAt, .title // ""] | @tsv'], { encoding: 'utf8' })
      rows = outText.split('\n').filter(Boolean).map(line => {
        const [t, title] = line.split('\t')
        return [Date.parse(t), title]
      })
      if (cacheable) {
        fs.mkdirSync(cacheDir, { recursive: true })
        fs.writeFileSync(file, JSON.stringify(rows))
      }
    }
    // An aligned window can stick out past either end of the requested range.
    for (const [t, title] of rows) if (t >= since && t < until) items.push({ t, title })
  }
  return items
}

// Stack order bottom to top; colors are the first three categorical slots plus a neutral for the rest.
const TYPES = [
  { key: 'fix', label: 'fix', color: '#2a78d6' },
  { key: 'feat', label: 'feat', color: '#eb6834' },
  { key: 'perf', label: 'perf', color: '#1baf7a' },
  { key: 'other', label: 'other (chore, refactor, docs…)', color: '#b5b3ac' },
]
const typeOf = title => {
  const m = /^\s*([a-z]+)(\([^)]*\))?!?:/i.exec(title)
  const key = m?.[1].toLowerCase()
  return TYPES.some(t => t.key === key) ? key : 'other'
}

const nextBoundary = t => {
  if (mode === 'weekly') return t + 7 * DAY
  if (mode === 'daily') return t + DAY
  const d = new Date(t)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
}
const buckets = []
for (let t = since; t < until; t = nextBoundary(t)) {
  const end = nextBoundary(t), to = Math.min(end, until)
  // A month that starts mid-month (custom --since) is also partial.
  const partial = to < end || (mode === 'monthly' && new Date(t).getUTCDate() !== 1)
  buckets.push({ from: t, to, days: Math.round((to - t) / DAY), partial, n: 0, prs: 0, issues: 0, fix: 0, feat: 0, perf: 0, other: 0 })
}
const count = (items, key) => {
  for (const { t, title } of items) {
    const b = buckets.find(b => t >= b.from && t < b.to)
    if (!b) continue
    b[key]++
    if (key === 'prs') b[typeOf(title)]++
  }
}
if (prs || ratio) count(fetchItems('prs'), 'prs')
if (!prs) count(fetchItems('issues'), 'issues')
// A bucket without new issues has no ratio; it is drawn as an empty slot.
for (const b of buckets) b.n = ratio ? (b.issues ? b.prs / b.issues : 0) : prs ? b.prs : b.issues
const sum = (list, key) => list.reduce((s, b) => s + b[key], 0)
const totalPrs = sum(buckets, 'prs'), totalIssues = sum(buckets, 'issues')
const total = ratio ? totalPrs / (totalIssues || 1) : prs ? totalPrs : totalIssues
const totalDays = Math.round((until - since) / DAY)
const pct = v => `${Math.round(100 * v / (totalPrs || 1))}%`
const max = Math.max(...buckets.map(b => b.n))
const maxFull = Math.max(...buckets.filter(b => !b.partial).map(b => b.n))
const tickStep = !ratio && max <= 25 ? 5 : (() => {
  const raw = max / 5, mag = 10 ** Math.floor(Math.log10(raw))
  return [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw)
})()
const maxY = Math.ceil((ratio ? max * 1.05 : max + 1) / tickStep) * tickStep

const print = () => {
  for (const b of buckets) {
    const stats = types
      ? TYPES.map(t => `${String(b[t.key]).padStart(4)} ${t.key}`).join('  ') + `  (${String(b.prs).padStart(4)} total)`
      : ratio
      ? `${String(b.prs).padStart(5)} PRs  ${String(b.issues).padStart(4)} issues  ${b.issues ? b.n.toFixed(2) : 'n/a'}`
      : `${String(b.n).padStart(4)}  ${(b.n / b.days).toFixed(1)}/day`
    console.log(`${iso(b.from)}..${iso(b.to - DAY)}  ${stats}${b.partial ? '  (partial)' : ''}`)
  }
  if (types) console.log(`total ${totalPrs} merged PRs in ${totalDays} days: ` + TYPES.map(t => `${sum(buckets, t.key)} ${t.key} (${pct(sum(buckets, t.key))})`).join(', '))
  else console.log(ratio
    ? `total ${totalPrs} merged PRs, ${totalIssues} new issues in ${totalDays} days (${total.toFixed(2)} PRs per issue)`
    : `total ${total} in ${totalDays} days (${(total / totalDays).toFixed(1)}/day)`)
}
if (textOnly) {
  print()
  process.exit(0)
}

// Few bars get a value and a date label each; many bars (daily, or a long weekly range)
// get sparse labels plus an average line.
const dense = mode === 'daily' || buckets.length > 16
const W = 1200, H = 675, padL = 64, padR = dense && !types ? 150 : 40, padT = 150, padB = 90
const plotW = W - padL - padR, plotH = H - padT - padB
const slot = plotW / buckets.length
const barW = Math.min(96, Math.max(8, Math.floor(slot * 0.55)))
const y = v => padT + plotH - (v / maxY) * plotH
const x = i => padL + i * slot + slot / 2

let grid = '', bars = '', labels = '', xaxis = '', extra = ''
for (let v = 0; v <= maxY; v += tickStep) {
  grid += `<line x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}" stroke="${v === 0 ? '#c9c8c3' : '#e8e7e3'}" stroke-width="1"/>`
  grid += `<text x="${padL - 12}" y="${y(v) + 4}" text-anchor="end" class="tick">${+v.toFixed(2)}</text>`
}
buckets.forEach((b, i) => {
  const partial = b.partial
  const h = y(0) - y(b.n), top = y(b.n), bx = x(i) - barW / 2, r = Math.min(4, h)
  if (types) {
    // Stacked segments with a 2px surface gap between them; only the top one is rounded.
    const segs = TYPES.filter(t => b[t.key] > 0)
    let cum = 0
    segs.forEach((t, k) => {
      const bottom = y(cum) - (k > 0 ? 2 : 0), segTop = y(cum + b[t.key])
      cum += b[t.key]
      if (bottom - segTop <= 0) return
      const sr = k === segs.length - 1 ? Math.min(4, bottom - segTop) : 0
      bars += `<path d="M${bx},${bottom} V${segTop + sr} a${sr},${sr} 0 0 1 ${sr},-${sr} h${barW - 2 * sr} a${sr},${sr} 0 0 1 ${sr},${sr} V${bottom} Z" fill="${t.color}"${partial ? ' fill-opacity="0.45"' : ''}><title>${t.key}: ${b[t.key]}</title></path>`
    })
  } else if (b.n > 0) bars += `<path d="M${bx},${y(0)} V${top + r} a${r},${r} 0 0 1 ${r},-${r} h${barW - 2 * r} a${r},${r} 0 0 1 ${r},${r} V${y(0)} Z" fill="${partial ? '#a9c9f0' : '#2a78d6'}"/>`
  if (!dense) {
    labels += `<text x="${x(i)}" y="${top - 12}" text-anchor="middle" class="val big">${fmtV(b.n)}</text>`
    if (partial) labels += `<text x="${x(i)}" y="${top - 34}" text-anchor="middle" class="note">so far (${b.days} days)</text>`
    const range = mode === 'monthly' ? fmtMonth(b.from) : `${fmt(b.from)} – ${fmt(b.to - DAY)}`
    xaxis += `<text x="${x(i)}" y="${y(0) + 26}" text-anchor="middle" class="tick">${range}</text>`
    xaxis += `<text x="${x(i)}" y="${y(0) + 46}" text-anchor="middle" class="sub2">${types ? `${b.fix} fix · ${b.feat} feat` : ratio ? `${b.prs} / ${b.issues}` : `${(b.n / b.days).toFixed(1)} / day`}</text>`
  } else {
    // Label peaks (only the higher of two adjacent ones, so labels don't collide), and in
    // daily mode also the near-empty days.
    // A partial bucket is never labeled as a peak: it covers too few days to compare.
    const full = j => buckets[j] && !buckets[j].partial ? buckets[j].n : 0
    const peak = !b.partial && b.n >= maxFull * 0.8 && b.n >= full(i - 1) && b.n > full(i + 1)
    if (peak || (!ratio && mode === 'daily' && b.n <= 1)) labels += `<text x="${x(i)}" y="${top - 8}" text-anchor="middle" class="val">${fmtV(b.n)}</text>`
    const every = mode === 'daily' ? (buckets.length > 35 ? 7 : 5) : Math.ceil(buckets.length / 10)
    const last = buckets.length - 1
    // Skip a regular tick too close to the always-shown last one.
    if ((i % every === 0 && last - i >= every / 2) || i === last) xaxis += `<text x="${x(i)}" y="${y(0) + 24}" text-anchor="middle" class="tick">${mode === 'monthly' ? fmtMonth(b.from) : fmt(b.from)}</text>`
  }
})
if (types) {
  // Legend: identity is never color-alone, and each entry carries its share of the total.
  let lx = padL
  for (const t of TYPES) {
    const text = `${t.label} ${sum(buckets, t.key)} (${pct(sum(buckets, t.key))})`
    extra += `<rect x="${lx}" y="109" width="12" height="12" rx="2" fill="${t.color}"/><text x="${lx + 18}" y="120" class="legend">${text}</text>`
    lx += 18 + text.length * 7.6 + 26
  }
} else if (dense) {
  // Average per bucket, over full buckets only, so a partial last bucket doesn't drag it down.
  const full = buckets.filter(b => !b.partial)
  // For the ratio, the overall ratio (total PRs / total issues) rather than a mean of ratios.
  const avg = ratio ? sum(full, 'prs') / (sum(full, 'issues') || 1)
    : mode === 'daily' ? total / totalDays : full.reduce((s, b) => s + b.n, 0) / (full.length || 1)
  extra = `<line x1="${padL}" x2="${W - padR}" y1="${y(avg)}" y2="${y(avg)}" stroke="#52514e" stroke-width="1.5"/>
<text x="${W - padR + 10}" y="${y(avg) + 5}" class="avg">${ratio ? `overall ${avg.toFixed(1)}` : `avg ${avg.toFixed(avg >= 100 ? 0 : 1)} / ${unit}`}</text>`
}

const html = `<!doctype html><meta charset="utf-8"><title>${types ? 'Merged PR types' : ratio ? 'PRs per issue' : prs ? 'Merged PRs' : 'New issues'}</title>
<style>
html,body{margin:0;background:#fcfcfb}
svg{font-family:Inter,"Segoe UI",system-ui,-apple-system,sans-serif}
.title{font-size:30px;font-weight:700;fill:#0b0b0b}
.sub{font-size:17px;fill:#52514e}
.tick{font-size:15px;fill:#52514e}
.sub2{font-size:13px;fill:#8a897f}
.val{font-size:14px;font-weight:600;fill:#0b0b0b}
.big{font-size:20px;font-weight:700}
.note{font-size:13px;fill:#52514e}
.avg{font-size:14px;font-weight:600;fill:#52514e}
.foot{font-size:13px;fill:#8a897f}
.legend{font-size:14px;fill:#52514e}
</style>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="#fcfcfb"/>
<text x="${padL}" y="58" class="title">${types ? `Pull requests merged into ${repo} per ${unit}, by type` : ratio ? `Merged pull requests per new issue in ${repo}, by ${unit}` : `${prs ? 'Pull requests merged into' : 'New issues opened in'} ${repo} per ${unit}`}</text>
<text x="${padL}" y="90" class="sub">Since ${fmt(since)}, ${new Date(since).getUTCFullYear()} · ${ratio
  ? `${totalPrs} merged pull requests, ${totalIssues} new issues in ${totalDays} days`
  : `${total} ${prs ? 'pull requests' : 'issues'} in ${totalDays} days`}</text>
${grid}${bars}${extra}${labels}${xaxis}
<text x="${W - 40}" y="${H - 24}" text-anchor="end" class="foot">Source: GitHub search API, ${types ? 'merged pull requests by merge date, type from the title prefix' : ratio ? 'PRs by merge date, issues by creation date' : prs ? 'merged pull requests by merge date' : 'issues only (no pull requests)'}, UTC days, through ${fmt(until - DAY)}</text>
</svg>`
const htmlPath = path.join(os.tmpdir(), `issue-stats-${process.pid}.html`)
fs.writeFileSync(htmlPath, html)

const shells = fs.readdirSync(path.join(os.homedir(), '.cache/ms-playwright')).filter(d => d.startsWith('chromium_headless_shell-')).sort()
const executablePath = path.join(os.homedir(), '.cache/ms-playwright', shells.at(-1), 'chrome-headless-shell-linux64/chrome-headless-shell')
const { chromium } = await import('playwright-core')
const browser = await chromium.launch({ executablePath })
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 })
await page.goto('file://' + htmlPath)
await page.screenshot({ path: out })
await browser.close()
fs.unlinkSync(htmlPath)

print()
console.log(`-> ${path.resolve(out)}`)
