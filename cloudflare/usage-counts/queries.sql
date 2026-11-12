-- Questions worth asking the counts. Run one with
--   npx wrangler d1 execute autochart-usage --remote --command "<query>"
-- or paste it into the D1 console in the Cloudflare dashboard.

-- Browsers that had the browser version open, per day (DNT and opted-out browsers aren't in it).
SELECT day, SUM(n) AS browsers FROM counts
WHERE event = 'active' AND day >= date('now', '-30 days')
GROUP BY day ORDER BY day;

-- Charts made per day, last two weeks.
SELECT day, SUM(n) AS charts FROM counts
WHERE event = 'generate_finished' AND day >= date('now', '-14 days')
GROUP BY day ORDER BY day;

-- How often runs finish, fail, or get cut short.
SELECT event, SUM(n) AS n FROM counts
WHERE event IN ('generate_started', 'generate_finished', 'generate_failed', 'run_interrupted')
GROUP BY event;

-- Failures by reason and stage.
SELECT json_extract(fields, '$.reason') AS reason, json_extract(fields, '$.stage') AS stage, SUM(n) AS n
FROM counts WHERE event IN ('generate_failed', 'inpaint_failed')
GROUP BY reason, stage ORDER BY n DESC;

-- Runs cut short: stopped, the tab closed, or the tab crashed (likely out of memory).
SELECT json_extract(fields, '$.how') AS how, json_extract(fields, '$.stage') AS stage,
  json_extract(fields, '$.device') AS device, json_extract(fields, '$.engine') AS engine,
  json_extract(fields, '$.length') AS length, SUM(n) AS n
FROM counts WHERE event = 'run_interrupted'
GROUP BY how, stage, device, engine, length ORDER BY n DESC;

-- WebGPU or CPU, phone or desktop, by browser, for finished runs.
SELECT json_extract(fields, '$.browser') AS browser, json_extract(fields, '$.device') AS device,
  json_extract(fields, '$.engine') AS engine, SUM(n) AS n
FROM counts WHERE event = 'generate_finished'
GROUP BY browser, device, engine ORDER BY n DESC;

-- How long runs take, by engine.
SELECT json_extract(fields, '$.engine') AS engine, json_extract(fields, '$.minutes') AS minutes, SUM(n) AS n
FROM counts WHERE event = 'generate_finished'
GROUP BY engine, minutes ORDER BY engine, minutes;

-- Share of finished charts that get exported.
SELECT
  (SELECT SUM(n) FROM counts WHERE event = 'exported') * 1.0 /
  (SELECT SUM(n) FROM counts WHERE event = 'generate_finished') AS exported_share;

-- The Lite offer: shown, taken, declined.
SELECT event, SUM(n) AS n FROM counts WHERE event LIKE 'lite_%' GROUP BY event;
