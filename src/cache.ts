/**
 * On-disk response cache with a TTL and a bounded entry count.
 *
 * - Keys are derived from the endpoint plus the effective API parameters, so a
 *   cached entry can never be served for a different query. The API key is
 *   deliberately excluded from the key material.
 * - Entries are stored as one JSON file each; writes go through an atomic
 *   temp-file + rename so a reader never sees a truncated entry.
 * - IEEE's API Terms of Use restrict retaining Content in bulk, so the cache is
 *   bounded (entry count, per-entry size, TTL) rather than an unbounded mirror.
 */

import fs from "node:fs";
import path from "node:path";

import { log } from "./logger.js";
import type { Config } from "./config.js";
import { atomicWriteFileSync, ensureDir, sha256Hex } from "./store.js";

/** Bump to invalidate every existing cache entry after a schema change. */
const CACHE_SCHEMA_VERSION = 2;

export interface CacheEntry<T> {
  schema: number;
  key: string;
  endpoint: string;
  params: Record<string, string>;
  created_at: string;
  created_ms: number;
  expires_ms: number;
  payload: T;
}

export function canonicalParams(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&");
}

export function buildCacheKey(endpoint: string, params: Record<string, string>): string {
  return sha256Hex(`${CACHE_SCHEMA_VERSION}\u0000${endpoint}\u0000${canonicalParams(params)}`);
}

export class DiskCache {
  constructor(private readonly config: Config) {}

  get enabled(): boolean {
    return this.config.cacheTtlSeconds > 0 && this.config.cacheMaxEntries > 0;
  }

  private fileFor(key: string): string {
    return path.join(this.config.cacheDir, `${key}.json`);
  }

  get<T>(key: string): CacheEntry<T> | null {
    if (!this.enabled) return null;
    const file = this.fileFor(key);
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      return null;
    }
    try {
      const entry = JSON.parse(text) as CacheEntry<T>;
      if (entry.schema !== CACHE_SCHEMA_VERSION) {
        fs.rmSync(file, { force: true });
        return null;
      }
      if (typeof entry.expires_ms !== "number" || entry.expires_ms <= Date.now()) {
        fs.rmSync(file, { force: true });
        return null;
      }
      return entry;
    } catch {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        /* ignore */
      }
      return null;
    }
  }

  set<T>(key: string, endpoint: string, params: Record<string, string>, payload: T): boolean {
    if (!this.enabled) return false;
    const now = Date.now();
    const entry: CacheEntry<T> = {
      schema: CACHE_SCHEMA_VERSION,
      key,
      endpoint,
      params,
      created_at: new Date(now).toISOString(),
      created_ms: now,
      expires_ms: now + this.config.cacheTtlSeconds * 1000,
      payload,
    };
    let serialized: string;
    try {
      serialized = JSON.stringify(entry);
    } catch {
      return false;
    }
    if (serialized.length > this.config.cacheMaxEntryBytes) {
      log.debug(
        `Skipping cache write: entry is ${serialized.length} bytes, limit is ${this.config.cacheMaxEntryBytes}.`
      );
      return false;
    }
    try {
      ensureDir(this.config.cacheDir);
      atomicWriteFileSync(this.fileFor(key), serialized);
    } catch (error) {
      log.warn(`Cache write failed: ${String(error)}`);
      return false;
    }
    this.evictIfNeeded();
    return true;
  }

  /** Drop expired entries, then the oldest entries beyond the configured cap. */
  private evictIfNeeded(): void {
    let files: string[];
    try {
      files = fs.readdirSync(this.config.cacheDir).filter((name) => name.endsWith(".json"));
    } catch {
      return;
    }
    const now = Date.now();
    const stats: Array<{ file: string; mtime: number }> = [];
    for (const name of files) {
      const full = path.join(this.config.cacheDir, name);
      try {
        const stat = fs.statSync(full);
        stats.push({ file: full, mtime: stat.mtimeMs });
        if (now - stat.mtimeMs > this.config.cacheTtlSeconds * 1000 * 4) {
          fs.rmSync(full, { force: true });
        }
      } catch {
        /* ignore */
      }
    }
    const survivors = stats.filter((item) => fs.existsSync(item.file));
    const overflow = survivors.length - this.config.cacheMaxEntries;
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

  stats(): { entries: number; bytes: number; expired: number } {
    let files: string[];
    try {
      files = fs.readdirSync(this.config.cacheDir).filter((name) => name.endsWith(".json"));
    } catch {
      return { entries: 0, bytes: 0, expired: 0 };
    }
    let bytes = 0;
    let expired = 0;
    const now = Date.now();
    for (const name of files) {
      const full = path.join(this.config.cacheDir, name);
      try {
        bytes += fs.statSync(full).size;
        const text = fs.readFileSync(full, "utf8");
        const entry = JSON.parse(text) as CacheEntry<unknown>;
        if (typeof entry.expires_ms !== "number" || entry.expires_ms <= now) expired += 1;
      } catch {
        /* ignore */
      }
    }
    return { entries: files.length, bytes, expired };
  }

  clear(): number {
    let files: string[];
    try {
      files = fs.readdirSync(this.config.cacheDir).filter((name) => name.endsWith(".json"));
    } catch {
      return 0;
    }
    let removed = 0;
    for (const name of files) {
      try {
        fs.rmSync(path.join(this.config.cacheDir, name), { force: true });
        removed += 1;
      } catch {
        /* ignore */
      }
    }
    return removed;
  }
}
