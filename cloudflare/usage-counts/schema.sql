-- One row per day, event and exact set of fields; n is how many times it was
-- counted that day. Nothing finer is kept.
CREATE TABLE IF NOT EXISTS counts (
  day TEXT NOT NULL,      -- 2026-11-02 (UTC)
  event TEXT NOT NULL,    -- generate_finished, exported, ...
  fields TEXT NOT NULL,   -- {"browser":"chrome","device":"desktop",...}, keys sorted
  n INTEGER NOT NULL,
  PRIMARY KEY (day, event, fields)
);
