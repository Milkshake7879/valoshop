-- One row per public counter. "shops" is bumped once per successful store check.
CREATE TABLE counters (
  name TEXT PRIMARY KEY,
  n INTEGER NOT NULL DEFAULT 0
);

INSERT INTO counters (name, n) VALUES ('shops', 0);
