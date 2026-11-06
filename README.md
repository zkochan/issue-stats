# issue-stats

Twitter-sized PNG of new issues opened in pnpm/pnpm, counted from the day the
repo committed to zero open issues (2026-09-27). Needs `gh` logged in and the
`playwright-core` install in `~/node_modules` with a cached headless Chromium.

```bash
node issue-stats.mjs                 # weekly bars, writes pnpm-new-issues-per-week.png
node issue-stats.mjs --mode daily    # daily bars with an average line
node issue-stats.mjs --text          # print the numbers only, no PNG (no Chromium needed)
node issue-stats.mjs merged-prs                  # merged PRs per week over the last year
node issue-stats.mjs merged-prs --mode monthly   # same, one bar per calendar month
```

`merged-prs` counts pull requests by merge date and defaults `--since` to the
first of the month a year ago. `--mode monthly` works for issues too. Charts
with more than 16 bars switch to sparse labels and an average line.

Weeks run Saturday to Friday so the first starts on Sep 27. The current week
is a lighter bar labeled "so far". `--until` (exclusive) defaults to today, so
today is never counted.
