#!/usr/bin/env node
// Renders a Twitter-sized PNG of new issues opened (or pull requests merged) in pnpm/pnpm, per day, week or month.
// Usage: node issue-stats.mjs [issues|merged-prs] [--mode weekly|daily|monthly] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--repo owner/name] [--out file.png] [--text]
// The merged-prs command counts PRs by merge date and defaults --since to the start of the month a year ago.
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
if (command !== 'issues' && command !== 'merged-prs') {
  console.error(`Unknown command "${command}". Use "issues" or "merged-prs".`)
  process.exit(1)
}
const prs = command === 'merged-prs'
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
const since = args.since ? Date.parse(args.since + 'T00:00:00Z') : prs ? yearAgo() : Date.parse('2026-09-27T00:00:00Z')
const until = args.until ? Date.parse(args.until + 'T00:00:00Z') : today
const unit = { weekly: 'week', daily: 'day', monthly: 'month' }[mode]
const what = prs ? 'merged-prs' : 'new-issues'
const out = args.out ?? `${repo.split('/')[1]}-${what}-per-${unit}.png`

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
    nodes { ... on Issue { createdAt } ... on PullRequest { mergedAt } }
  }
}`
const windowDays = prs ? 7 : 28
const created = []
for (let from = since; from < until; from += windowDays * DAY) {
  const to = Math.min(from + windowDays * DAY, until)
  const range = `${iso(from)}..${iso(to - DAY)}`
  const q = prs ? `repo:${repo} is:pr is:merged merged:${range}` : `repo:${repo} is:issue created:${range}`
  const outText = execFileSync('gh', ['api', 'graphql', '--paginate', '-f', `query=${searchQuery}`, '-f', `q=${q}`,
    '--jq', '.data.search | (if .issueCount > 1000 then error("more than 1000 results for \(.issueCount)") else . end) | .nodes[] | .mergedAt // .createdAt'], { encoding: 'utf8' })
  for (const line of outText.split('\n')) if (line) created.push(Date.parse(line))
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
  buckets.push({ from: t, to, days: Math.round((to - t) / DAY), partial, n: 0 })
}
for (const t of created) { const b = buckets.find(b => t >= b.from && t < b.to); if (b) b.n++ }
const total = buckets.reduce((s, b) => s + b.n, 0)
const totalDays = Math.round((until - since) / DAY)
const max = Math.max(...buckets.map(b => b.n))
const tickStep = max <= 25 ? 5 : (() => {
  const raw = max / 5, mag = 10 ** Math.floor(Math.log10(raw))
  return [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw)
})()
const maxY = Math.ceil((max + 1) / tickStep) * tickStep

const print = () => {
  for (const b of buckets) console.log(`${iso(b.from)}..${iso(b.to - DAY)}  ${String(b.n).padStart(4)}  ${(b.n / b.days).toFixed(1)}/day${b.partial ? '  (partial)' : ''}`)
  console.log(`total ${total} in ${totalDays} days (${(total / totalDays).toFixed(1)}/day)`)
}
if (textOnly) {
  print()
  process.exit(0)
}

// Few bars get a value and a date label each; many bars (daily, or a long weekly range)
// get sparse labels plus an average line.
const dense = mode === 'daily' || buckets.length > 16
const W = 1200, H = 675, padL = 64, padR = dense ? 150 : 40, padT = 150, padB = 90
const plotW = W - padL - padR, plotH = H - padT - padB
const slot = plotW / buckets.length
const barW = Math.min(96, Math.max(8, Math.floor(slot * 0.55)))
const y = v => padT + plotH - (v / maxY) * plotH
const x = i => padL + i * slot + slot / 2

let grid = '', bars = '', labels = '', xaxis = '', extra = ''
for (let v = 0; v <= maxY; v += tickStep) {
  grid += `<line x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}" stroke="${v === 0 ? '#c9c8c3' : '#e8e7e3'}" stroke-width="1"/>`
  grid += `<text x="${padL - 12}" y="${y(v) + 4}" text-anchor="end" class="tick">${v}</text>`
}
buckets.forEach((b, i) => {
  const partial = b.partial
  const h = y(0) - y(b.n), top = y(b.n), bx = x(i) - barW / 2, r = Math.min(4, h)
  if (b.n > 0) bars += `<path d="M${bx},${y(0)} V${top + r} a${r},${r} 0 0 1 ${r},-${r} h${barW - 2 * r} a${r},${r} 0 0 1 ${r},${r} V${y(0)} Z" fill="${partial ? '#a9c9f0' : '#2a78d6'}"/>`
  if (!dense) {
    labels += `<text x="${x(i)}" y="${top - 12}" text-anchor="middle" class="val big">${b.n}</text>`
    if (partial) labels += `<text x="${x(i)}" y="${top - 34}" text-anchor="middle" class="note">so far (${b.days} days)</text>`
    const range = mode === 'monthly' ? fmtMonth(b.from) : `${fmt(b.from)} – ${fmt(b.to - DAY)}`
    xaxis += `<text x="${x(i)}" y="${y(0) + 26}" text-anchor="middle" class="tick">${range}</text>`
    xaxis += `<text x="${x(i)}" y="${y(0) + 46}" text-anchor="middle" class="sub2">${(b.n / b.days).toFixed(1)} / day</text>`
  } else {
    // Label peaks (only the higher of two adjacent ones, so labels don't collide), and in
    // daily mode also the near-empty days.
    const peak = b.n >= max * 0.8 && b.n >= (buckets[i - 1]?.n ?? 0) && b.n > (buckets[i + 1]?.n ?? 0)
    if (peak || (mode === 'daily' && b.n <= 1)) labels += `<text x="${x(i)}" y="${top - 8}" text-anchor="middle" class="val">${b.n}</text>`
    const every = mode === 'daily' ? (buckets.length > 35 ? 7 : 5) : Math.ceil(buckets.length / 10)
    const last = buckets.length - 1
    // Skip a regular tick too close to the always-shown last one.
    if ((i % every === 0 && last - i >= every / 2) || i === last) xaxis += `<text x="${x(i)}" y="${y(0) + 24}" text-anchor="middle" class="tick">${mode === 'monthly' ? fmtMonth(b.from) : fmt(b.from)}</text>`
  }
})
if (dense) {
  // Average per bucket, over full buckets only, so a partial last bucket doesn't drag it down.
  const full = buckets.filter(b => !b.partial)
  const avg = mode === 'daily' ? total / totalDays : full.reduce((s, b) => s + b.n, 0) / (full.length || 1)
  extra = `<line x1="${padL}" x2="${W - padR}" y1="${y(avg)}" y2="${y(avg)}" stroke="#52514e" stroke-width="1.5"/>
<text x="${W - padR + 10}" y="${y(avg) + 5}" class="avg">avg ${avg.toFixed(avg >= 100 ? 0 : 1)} / ${unit}</text>`
}

const html = `<!doctype html><meta charset="utf-8"><title>${prs ? 'Merged PRs' : 'New issues'}</title>
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
</style>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="#fcfcfb"/>
<text x="${padL}" y="58" class="title">${prs ? 'Pull requests merged into' : 'New issues opened in'} ${repo} per ${unit}</text>
<text x="${padL}" y="90" class="sub">Since ${fmt(since)}, ${new Date(since).getUTCFullYear()} · ${total} ${prs ? 'pull requests' : 'issues'} in ${totalDays} days</text>
${grid}${bars}${extra}${labels}${xaxis}
<text x="${W - 40}" y="${H - 24}" text-anchor="end" class="foot">Source: GitHub search API, ${prs ? 'merged pull requests by merge date' : 'issues only (no pull requests)'}, UTC days, through ${fmt(until - DAY)}</text>
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
