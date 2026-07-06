// ═══════════════════════════════════════════════════════════════════════
//  src/backtest/replay.js — V5.8 Phase 3: Recording replay
// ═══════════════════════════════════════════════════════════════════════
//  Streams recorded NDJSON events (optionally .gz) back in chronological
//  order. Files are replayed in sorted filename order — the recorder's
//  hourly naming (books-YYYYMMDD-HH.ndjson) guarantees this equals
//  chronological order.
//
//  Corrupt lines are skipped and counted, never thrown: a multi-day
//  recording should survive one bad write.
// ═══════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import readline from "node:readline";

/** List recording files in a directory, sorted (== chronological). */
export async function listRecordingFiles(dir) {
  const entries = await fsp.readdir(dir);
  return entries
    .filter(f => f.endsWith(".ndjson") || f.endsWith(".ndjson.gz"))
    .sort()
    .map(f => path.join(dir, f));
}

/**
 * Async generator over events in a single file.
 * Yields parsed objects; increments counters on bad lines.
 */
export async function* readEventsFromFile(file, counters = {}) {
  let input = fs.createReadStream(file);
  if (file.endsWith(".gz")) input = input.pipe(zlib.createGunzip());

  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    const s = line.trim();
    if (!s) continue;
    try {
      const obj = JSON.parse(s);
      if (!obj || typeof obj !== "object" || !obj.type) {
        counters.skipped = (counters.skipped || 0) + 1;
        continue;
      }
      counters.parsed = (counters.parsed || 0) + 1;
      yield obj;
    } catch {
      counters.skipped = (counters.skipped || 0) + 1;
    }
  }
}

/**
 * Async generator over all events in a recording directory (or an
 * explicit list of files).
 */
export async function* replayEvents(dirOrFiles, counters = {}) {
  const files = Array.isArray(dirOrFiles)
    ? dirOrFiles
    : await listRecordingFiles(dirOrFiles);
  counters.files = files.length;
  for (const file of files) {
    yield* readEventsFromFile(file, counters);
  }
}
