# issue-stats

Twitter-sized PNG of new issues opened in pnpm/pnpm, counted from the day the
repo committed to zero open issues (2026-09-27). Needs `gh` logged in and the
`playwright-core` install in `~/node_modules` with a cached headless Chromium.

```bash
node issue-stats.mjs                 # weekly bars, writes pnpm-new-issues-per-week.png
node issue-stats.mjs --mode daily    # daily bars with an average line
```

Weeks run Saturday to Friday so the first starts on Sep 27. The current week
is a lighter bar labeled "so far". `--until` (exclusive) defaults to today, so
today is never counted.
