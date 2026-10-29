// Adds up the browser version's usage counts (src/web/usageCounts.js) and
// serves the totals the hub site shows.
//
//   POST /api/count   one count: { event, browser, device, version, ...fields }
//   GET  /api/totals  charts made, exports and model share, cached for an hour
//
// Each count only adds 1 to a per-day total for its exact fields; single
// events, times of day, IP addresses and request headers are never stored.
// Events and fields not in shared/usageEvents.js are dropped.

import { COMMON_FIELDS, FIELD_VALUE, USAGE_EVENTS } from "../../shared/usageEvents.js";

const MAX_BODY = 1024;
const TOTALS_SECONDS = 3600;

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/count" && request.method === "POST") return addCount(request, env);
    if (pathname === "/api/totals" && request.method === "GET") return totals(request, env, ctx);
    return new Response("Not found", { status: 404 });
  },
};

// The count's fields, checked and in a fixed order, or null when it isn't
// one we take.
export function countFields(body) {
  const allowed = USAGE_EVENTS[body?.event];
  if (!allowed) return null;
  const fields = {};
  for (const key of [...COMMON_FIELDS, ...allowed].sort()) {
    const value = body[key];
    if (value == null || value === "") continue;
    if (typeof value !== "string" || !FIELD_VALUE.test(value)) return null;
    fields[key] = value;
  }
  return fields;
}

async function addCount(request, env) {
  // Always the same answer, so a sender can't tell what was kept.
  const done = new Response(null, { status: 204 });
  const text = await request.text().catch(() => "");
  if (!text || text.length > MAX_BODY) return done;
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    return done;
  }
  const fields = countFields(body);
  if (!fields) return done;
  const day = new Date().toISOString().slice(0, 10);
  await env.DB.prepare(
    `INSERT INTO counts (day, event, fields, n) VALUES (?1, ?2, ?3, 1)
     ON CONFLICT (day, event, fields) DO UPDATE SET n = n + 1`,
  ).bind(day, body.event, JSON.stringify(fields)).run();
  return done;
}

async function totals(request, env, ctx) {
  const cache = caches.default;
  const key = new Request(new URL("/api/totals", request.url).href);
  const cached = await cache.match(key);
  if (cached) return cached;

  const events = await env.DB.prepare(
    `SELECT event, SUM(n) AS n FROM counts WHERE event IN ('generate_finished', 'exported') GROUP BY event`,
  ).all();
  const models = await env.DB.prepare(
    `SELECT json_extract(fields, '$.model') AS model, SUM(n) AS n FROM counts
     WHERE event = 'generate_finished' GROUP BY model ORDER BY n DESC`,
  ).all();
  const byEvent = Object.fromEntries(events.results.map((row) => [row.event, row.n]));
  const response = Response.json(
    {
      charts: byEvent.generate_finished || 0,
      exports: byEvent.exported || 0,
      models: Object.fromEntries(models.results.map((row) => [row.model || "unknown", row.n])),
      updatedAt: new Date().toISOString(),
    },
    { headers: { "Cache-Control": `public, max-age=${TOTALS_SECONDS}` } },
  );
  ctx.waitUntil(cache.put(key, response.clone()));
  return response;
}
