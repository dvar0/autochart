# Usage counts

The server side of the browser version's usage counts
(`src/web/usageCounts.js`): a Cloudflare Worker that adds each count to a
per-day total in a D1 database, and serves the totals the hub site shows. What
is counted, and what never is, is in [docs/privacy.md](../../docs/privacy.md).
The events and fields it accepts are in `shared/usageEvents.js`.

It runs on Cloudflare's free plan. Past the free daily limits (100,000 requests,
100,000 database writes) the Worker answers with an error until the next UTC
day: counts are lost for the rest of that day and nothing is billed. The page
never waits on a count, so nothing in the app changes.

## Setting it up

```sh
cd cloudflare/usage-counts
npx wrangler login
npx wrangler d1 create autochart-usage      # put the database_id it prints in wrangler.toml
npx wrangler d1 execute autochart-usage --remote --file schema.sql
npx wrangler deploy
```

The routes in `wrangler.toml` need the `autochart.org` zone on the same
Cloudflare account. Then build the browser version with
`VITE_AUTOCHART_COUNTS_URL=/api/count` (set it in the Pages project's build
settings). Without it the page sends nothing.

Spam can only add to the totals. To limit it, add a rate-limiting rule for
`/api/count` in the Cloudflare dashboard (Security → WAF → Rate limiting rules).

## Reading the counts

`queries.sql` has the useful ones: failures by reason and stage, runs cut
short, devices and engines, run times, export share, the Lite offer. Run one
with `npx wrangler d1 execute autochart-usage --remote --command "<query>"` or
in the D1 console in the dashboard.
