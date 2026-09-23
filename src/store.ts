/**
 * Filesystem primitives: UTF-8 path handling, atomic writes, cross-process locks.
 *
 * All paths flow through Node's `fs`, which on Windows uses UTF-16 Win32 APIs,
 * so non-ASCII (e.g. Chinese) directory names and paths containing spaces work
 * without shelling out or code-page juggling.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

export function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

/** Resolve a possibly user-supplied path against a base directory. */
export function resolveUserPath(input: string, base: string): string {
  const trimmed = input.trim().replace(/^"|"$/g, "");
  if (trimmed.length === 0) throw new Error("Empty path");
  return path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.resolve(base, trimmed);
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/** Write bytes to `file` via a temp file + rename so readers never see a partial file. */
export function atomicWriteFileSync(file: string, data: string | Buffer): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, data, typeof data === "string" ? { encoding: "utf8" } : undefined);
  try {
    fs.renameSync(tmp, file);
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    throw error;
  }
}

export function readJsonFile<T>(file: string): T | null {
  try {
    const text = fs.readFileSync(file, "utf8");
    if (text.trim().length === 0) return null;
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * Probe whether a directory is writable by creating and removing a tiny file.
 * Used to pick a state directory without assuming the install location is writable.
 */
export function isWritableDir(dir: string): boolean {
  try {
    ensureDir(dir);
    const probe = path.join(dir, `.write-probe-${process.pid}-${crypto.randomBytes(3).toString("hex")}`);
    fs.writeFileSync(probe, "ok", { encoding: "utf8" });
    fs.rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Pick the first candidate directory that is actually writable.
 * Falls back to the OS temp directory so the server always starts.
 */
export function pickWritableDir(candidates: string[], fallbackSubdir: string): string {
  const all = [...candidates, path.join(os.tmpdir(), fallbackSubdir)];
  for (const candidate of all) {
    if (isWritableDir(candidate)) return candidate;
  }
  return path.join(os.tmpdir(), fallbackSubdir);
}

// ── Cross-process locking ──────────────────────────────────────────────────────

export interface LockOptions {
  /** How long to keep retrying before giving up. */
  timeoutMs?: number;
  /** A lock directory older than this is considered abandoned and is reclaimed. */
  staleMs?: number;
}

/**
 * Acquire a cross-process exclusive lock using `mkdir`, which is atomic on NTFS
 * and POSIX filesystems. Returns a release function, or null on timeout.
 */
export async function acquireLock(
  lockDir: string,
  options: LockOptions = {}
): Promise<(() => void) | null> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const staleMs = options.staleMs ?? 30_000;
  const started = Date.now();
  ensureDir(path.dirname(lockDir));

  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          fs.rmSync(lockDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;

      // Reclaim an abandoned lock (crashed process) so we cannot deadlock forever.
      try {
        const stat = fs.statSync(lockDir);
        if (Date.now() - stat.mtimeMs > staleMs) {
          fs.rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue; // lock vanished between mkdir and stat: retry immediately
      }

      if (Date.now() - started >= timeoutMs) return null;
      await sleep(10 + Math.floor(Math.random() * 30));
    }
  }
}

/** Run `fn` while holding `lockDir`; throws if the lock cannot be acquired. */
export async function withLock<T>(
  lockDir: string,
  fn: () => Promise<T> | T,
  options: LockOptions = {}
): Promise<T> {
  const release = await acquireLock(lockDir, options);
  if (!release) {
    throw new Error(`Timed out acquiring lock at ${lockDir}`);
  }
  try {
    return await fn();
  } finally {
    release();
  }
}

/** Recursively list files in a directory, returning [] when it does not exist. */
export function listFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}
