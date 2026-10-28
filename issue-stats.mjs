#!/usr/bin/env node
// Renders a Twitter-sized PNG of new issues opened in pnpm/pnpm, per day or per week.
// Usage: node issue-stats.mjs [--mode weekly|daily] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--repo owner/name] [--out file.png]
// --until is exclusive and defaults to today (UTC), so the current day is never counted as a full day.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { chromium } from 'playwright-core'

const DAY = 86400000
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith('--') ? [a.slice(2), all[i + 1]] : []).filter(Boolean))
const mode = args.mode ?? 'weekly'
const repo = args.repo ?? 'pnpm/pnpm'
const since = Date.parse((args.since ?? '2026-09-27') + 'T00:00:00Z')
const today = Math.floor(Date.now() / DAY) * DAY
const until = args.until ? Date.parse(args.until + 'T00:00:00Z') : today
const out = args.out ?? `${repo.split('/')[1]}-new-issues-per-${mode === 'weekly' ? 'week' : 'day'}.png`

const fmt = t => { const d = new Date(t); return `${d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })} ${d.getUTCDate()}` }
const iso = t => new Date(t).toISOString().slice(0, 10)

// The search API caps a query at 1000 results, so fetch in 28-day windows.
const created = []
for (let from = since; from < until; from += 28 * DAY) {
  const to = Math.min(from + 28 * DAY, until)
  const q = `repo:${repo}+is:issue+created:${iso(from)}..${iso(to - DAY)}`
  const outText = execFileSync('gh', ['api', '--paginate', `search/issues?q=${q}&per_page=100`, '--jq', '.items[] | .created_at'], { encoding: 'utf8' })
  for (const line of outText.split('\n')) if (line) created.push(Date.parse(line))
}

const buckets = []
const step = mode === 'weekly' ? 7 * DAY : DAY
for (let t = since; t < until; t += step) {
  const to = Math.min(t + step, until)
  buckets.push({ from: t, to, days: Math.round((to - t) / DAY), n: 0 })
}
for (const t of created) { const b = buckets.find(b => t >= b.from && t < b.to); if (b) b.n++ }
const total = buckets.reduce((s, b) => s + b.n, 0)
const totalDays = Math.round((until - since) / DAY)
const max = Math.max(...buckets.map(b => b.n))
const tickStep = max > 60 ? 25 : max > 30 ? 10 : 5
const maxY = Math.ceil((max + 1) / tickStep) * tickStep

const W = 1200, H = 675, padL = 64, padR = mode === 'daily' ? 150 : 40, padT = 150, padB = 90
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
  const partial = mode === 'weekly' && b.days < 7
  const h = y(0) - y(b.n), top = y(b.n), bx = x(i) - barW / 2, r = Math.min(4, h)
  if (b.n > 0) bars += `<path d="M${bx},${y(0)} V${top + r} a${r},${r} 0 0 1 ${r},-${r} h${barW - 2 * r} a${r},${r} 0 0 1 ${r},${r} V${y(0)} Z" fill="${partial ? '#a9c9f0' : '#2a78d6'}"/>`
  if (mode === 'weekly') {
    labels += `<text x="${x(i)}" y="${top - 12}" text-anchor="middle" class="val big">${b.n}</text>`
    if (partial) labels += `<text x="${x(i)}" y="${top - 34}" text-anchor="middle" class="note">so far (${b.days} days)</text>`
    xaxis += `<text x="${x(i)}" y="${y(0) + 26}" text-anchor="middle" class="tick">${fmt(b.from)} – ${fmt(b.to - DAY)}</text>`
    xaxis += `<text x="${x(i)}" y="${y(0) + 46}" text-anchor="middle" class="sub2">${(b.n / b.days).toFixed(1)} / day</text>`
  } else {
    if (b.n >= max * 0.8 || b.n <= 1) labels += `<text x="${x(i)}" y="${top - 8}" text-anchor="middle" class="val">${b.n}</text>`
    const every = buckets.length > 35 ? 7 : 5
    if (i % every === 0 || i === buckets.length - 1) xaxis += `<text x="${x(i)}" y="${y(0) + 24}" text-anchor="middle" class="tick">${fmt(b.from)}</text>`
  }
})
if (mode === 'daily') {
  const avg = total / totalDays
  extra = `<line x1="${padL}" x2="${W - padR}" y1="${y(avg)}" y2="${y(avg)}" stroke="#52514e" stroke-width="1.5"/>
<text x="${W - padR + 10}" y="${y(avg) + 5}" class="avg">avg ${avg.toFixed(1)} / day</text>`
}

const html = `<!doctype html><meta charset="utf-8"><title>New issues</title>
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
<text x="${padL}" y="58" class="title">New issues opened in ${repo} per ${mode === 'weekly' ? 'week' : 'day'}</text>
<text x="${padL}" y="90" class="sub">Since ${fmt(since)}, ${new Date(since).getUTCFullYear()} · ${total} issues in ${totalDays} days</text>
${grid}${bars}${extra}${labels}${xaxis}
<text x="${W - 40}" y="${H - 24}" text-anchor="end" class="foot">Source: GitHub search API, issues only (no pull requests), UTC days, through ${fmt(until - DAY)}</text>
</svg>`
const htmlPath = path.join(os.tmpdir(), `issue-stats-${process.pid}.html`)
fs.writeFileSync(htmlPath, html)

const shells = fs.readdirSync(path.join(os.homedir(), '.cache/ms-playwright')).filter(d => d.startsWith('chromium_headless_shell-')).sort()
const executablePath = path.join(os.homedir(), '.cache/ms-playwright', shells.at(-1), 'chrome-headless-shell-linux64/chrome-headless-shell')
const browser = await chromium.launch({ executablePath })
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 })
await page.goto('file://' + htmlPath)
await page.screenshot({ path: out })
await browser.close()
fs.unlinkSync(htmlPath)

for (const b of buckets) console.log(`${iso(b.from)}..${iso(b.to - DAY)}  ${String(b.n).padStart(4)}  ${(b.n / b.days).toFixed(1)}/day${b.days < step / DAY ? '  (partial)' : ''}`)
console.log(`total ${total} in ${totalDays} days -> ${path.resolve(out)}`)
