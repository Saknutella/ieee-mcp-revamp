/**
 * Bounded on-disk store for recent search result sets.
 *
 * `search_papers` returns a `search_id`; `export_results` accepts that id so a
 * later call (or a different process) can export the same candidate set without
 * re-querying IEEE and spending budget. Entries expire and the count is capped.
 */

import fs from "node:fs";
import path from "node:path";

import { log } from "./logger.js";
import type { Config } from "./config.js";
import { atomicWriteFileSync, ensureDir } from "./store.js";
import type { SearchResultPayload } from "./types.js";

const MAX_STORED_RESULT_SETS = 20;
const SEARCH_ID_RE = /^srch_[A-Za-z0-9]{4,64}$/;

export function newSearchId(): string {
  const stamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `srch_${stamp}${random}`;
}

export function isValidSearchId(id: string): boolean {
  return SEARCH_ID_RE.test(id);
}

export class ResultStore {
  constructor(private readonly config: Config) {}

  private fileFor(searchId: string): string {
    // isValidSearchId rejects separators and dots, so this cannot escape the dir.
    return path.join(this.config.resultsDir, `${searchId}.json`);
  }

  save(payload: SearchResultPayload): void {
    if (this.config.resultTtlSeconds <= 0) return;
    try {
      ensureDir(this.config.resultsDir);
      atomicWriteFileSync(this.fileFor(payload.search_id), `${JSON.stringify(payload)}\n`);
      this.prune();
    } catch (error) {
      log.warn(`Could not persist result set ${payload.search_id}: ${String(error)}`);
    }
  }

  load(searchId: string): SearchResultPayload | null {
    if (!isValidSearchId(searchId)) return null;
    let text: string;
    try {
      text = fs.readFileSync(this.fileFor(searchId), "utf8");
    } catch {
      return null;
    }
    try {
      const payload = JSON.parse(text) as SearchResultPayload & { stored_at_ms?: number };
      const storedAt = typeof payload.stored_at_ms === "number" ? payload.stored_at_ms : null;
      if (storedAt !== null && Date.now() - storedAt > this.config.resultTtlSeconds * 1000) {
        fs.rmSync(this.fileFor(searchId), { force: true });
        return null;
      }
      return payload;
    } catch {
      return null;
    }
  }

  prune(): void {
    let files: string[];
    try {
      files = fs.readdirSync(this.config.resultsDir).filter((name) => name.endsWith(".json"));
    } catch {
      return;
    }
    const now = Date.now();
    const survivors: Array<{ file: string; mtime: number }> = [];
    for (const name of files) {
      const full = path.join(this.config.resultsDir, name);
      try {
        const stat = fs.statSync(full);
        if (now - stat.mtimeMs > this.config.resultTtlSeconds * 1000) {
          fs.rmSync(full, { force: true });
        } else {
          survivors.push({ file: full, mtime: stat.mtimeMs });
        }
      } catch {
        /* ignore */
      }
    }
    const overflow = survivors.length - MAX_STORED_RESULT_SETS;
    if (overflow > 0) {
      survivors.sort((a, b) => a.mtime - b.mtime);
      for (const item of survivors.slice(0, overflow)) {
        try {
          fs.rmSync(item.file, { force: true });
        } catch {
          /* ignore */
        }
      }
    }
  }

  stats(): { entries: number; bytes: number } {
    let files: string[];
    try {
      files = fs.readdirSync(this.config.resultsDir).filter((name) => name.endsWith(".json"));
    } catch {
      return { entries: 0, bytes: 0 };
    }
    let bytes = 0;
    for (const name of files) {
      try {
        bytes += fs.statSync(path.join(this.config.resultsDir, name)).size;
      } catch {
        /* ignore */
      }
    }
    return { entries: files.length, bytes };
  }
}
