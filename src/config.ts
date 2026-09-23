/**
 * Runtime configuration, read once from the environment.
 *
 * The API key is read from `IEEE_API_KEY` (or `IEEE_API_KEY_FILE`) only. It is
 * never written to disk, never committed, never embedded in the binary, and is
 * registered with the logger so every log line and error path is scrubbed.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { fingerprintSecret, registerSecret, redact, type LogLevel } from "./logger.js";
import { pickWritableDir, resolveUserPath } from "./store.js";

export const SERVER_NAME = "ieee-mcp";
export const SERVER_VERSION = "2.0.0";
export const DEFAULT_API_BASE = "https://ieeexploreapi.ieee.org/api/v1/search/articles";

export type BudgetWindow = "utc-day" | "local-day" | "rolling-24h" | "both";

export interface Config {
  apiKey: string;
  apiKeySource: "IEEE_API_KEY" | "IEEE_API_KEY_FILE";
  /** Non-null when no usable key was found; tools then fail with CONFIG_ERROR. */
  apiKeyError: string | null;
  hasApiKey: boolean;
  keyFingerprint: string;
  apiBase: string;
  apiBaseIsDefault: boolean;
  maxRps: number;
  dailyBudget: number;
  budgetWindow: BudgetWindow;
  maxRetries: number;
  timeoutMs: number;
  cacheTtlSeconds: number;
  cacheMaxEntries: number;
  cacheMaxEntryBytes: number;
  resultTtlSeconds: number;
  /** How long to wait for in-flight requests after stdin closes. */
  shutdownGraceMs: number;
  stateDir: string;
  cacheDir: string;
  resultsDir: string;
  outputDir: string;
  logLevel: LogLevel;
  userAgent: string;

  /**
   * Crossref is a SECOND, independent data source used only for reference
   * lists. It never consumes the IEEE call budget.
   */
  crossrefEnabled: boolean;
  crossrefApiBase: string;
  crossrefIsDefaultBase: boolean;
  crossrefMailto: string | null;
  crossrefMaxRps: number;
  /** How many DOIs go into one Crossref `/works?filter=doi:...` request. */
  crossrefBatchSize: number;
  /** Upper bound on how many papers one reference lookup may query. */
  maxDoisPerCall: number;
  /** Upper bound on authoritative BibTeX fetches (one request each). */
  maxBibtexFetchesPerCall: number;

  /** Non-fatal problems found while reading the environment. */
  warnings: string[];
}

function rawEnv(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function intEnv(
  name: string,
  fallback: number,
  min: number,
  max: number,
  warnings: string[]
): number {
  const raw = rawEnv(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    warnings.push(`${name}="${raw}" is not an integer; using default ${fallback}.`);
    return fallback;
  }
  if (parsed < min || parsed > max) {
    const clamped = Math.min(max, Math.max(min, parsed));
    warnings.push(`${name}=${parsed} is outside [${min}, ${max}]; clamped to ${clamped}.`);
    return clamped;
  }
  return parsed;
}

function enumEnv<T extends string>(
  name: string,
  allowed: readonly T[],
  fallback: T,
  warnings: string[]
): T {
  const raw = rawEnv(name);
  if (raw === undefined) return fallback;
  if ((allowed as readonly string[]).includes(raw)) return raw as T;
  warnings.push(`${name}="${raw}" is not one of ${allowed.join(" | ")}; using "${fallback}".`);
  return fallback;
}

function readApiKey(warnings: string[]): {
  key: string;
  source: Config["apiKeySource"];
  error: string | null;
} {
  const direct = rawEnv("IEEE_API_KEY");
  if (direct) return { key: direct, source: "IEEE_API_KEY", error: null };

  const keyFile = rawEnv("IEEE_API_KEY_FILE");
  if (keyFile) {
    const resolved = path.isAbsolute(keyFile) ? keyFile : path.resolve(process.cwd(), keyFile);
    try {
      // Strip a UTF-8 BOM, which Windows editors love to add.
      const text = fs.readFileSync(resolved, "utf8").replace(/^\uFEFF/, "");
      const lines = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("#"));
      const first = lines[0];
      if (!first) {
        return {
          key: "",
          source: "IEEE_API_KEY_FILE",
          error: `IEEE_API_KEY_FILE (${resolved}) contains no usable key.`,
        };
      }
      if (lines.length > 1) {
        warnings.push(
          `IEEE_API_KEY_FILE contains ${lines.length} non-comment lines; only the first is used.`
        );
      }
      return { key: first, source: "IEEE_API_KEY_FILE", error: null };
    } catch (error) {
      return {
        key: "",
        source: "IEEE_API_KEY_FILE",
        error: `Cannot read IEEE_API_KEY_FILE at ${resolved}: ${redact(error)}`,
      };
    }
  }

  return {
    key: "",
    source: "IEEE_API_KEY",
    error:
      "No IEEE API key found. Set the IEEE_API_KEY environment variable (or IEEE_API_KEY_FILE " +
      "pointing at a file that contains it).",
  };
}

function defaultStateDirCandidates(): string[] {
  const candidates: string[] = [];
  const localAppData = rawEnv("LOCALAPPDATA");
  if (localAppData) candidates.push(path.join(localAppData, "ieee-mcp"));
  const appData = rawEnv("APPDATA");
  if (appData) candidates.push(path.join(appData, "ieee-mcp"));
  candidates.push(path.join(os.homedir(), ".ieee-mcp"));
  // Portable / portable-USB fallback next to the executable.
  candidates.push(path.join(path.dirname(process.execPath), ".ieee-mcp"));
  return candidates;
}

let cached: Config | null = null;

export function getConfig(): Config {
  if (cached) return cached;
  cached = loadConfig();
  return cached;
}

export function loadConfig(): Config {
  const warnings: string[] = [];

  const { key, source, error: keyError } = readApiKey(warnings);
  if (key.length > 0) registerSecret(key);
  if (keyError) warnings.push(keyError);

  const apiBaseOverride = rawEnv("IEEE_API_BASE");
  let apiBase = DEFAULT_API_BASE;
  let apiBaseIsDefault = true;
  if (apiBaseOverride) {
    try {
      const parsed = new URL(apiBaseOverride);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("must be http or https");
      }
      apiBase = parsed.toString();
      apiBaseIsDefault = false;
    } catch (error) {
      warnings.push(`IEEE_API_BASE is not a valid URL (${redact(error)}); using the official endpoint.`);
    }
  }

  const maxRps = intEnv("IEEE_MAX_RPS", 8, 1, 10, warnings);
  const dailyBudget = intEnv("IEEE_DAILY_BUDGET", 200, 1, 100_000, warnings);
  const budgetWindow = enumEnv<BudgetWindow>(
    "IEEE_BUDGET_WINDOW",
    ["both", "utc-day", "local-day", "rolling-24h"],
    "both",
    warnings
  );
  const maxRetries = intEnv("IEEE_MAX_RETRIES", 2, 0, 5, warnings);
  const timeoutMs = intEnv("IEEE_TIMEOUT_MS", 20_000, 1_000, 120_000, warnings);
  const cacheTtlSeconds = intEnv("IEEE_CACHE_TTL_SECONDS", 86_400, 0, 2_592_000, warnings);
  const cacheMaxEntries = intEnv("IEEE_CACHE_MAX_ENTRIES", 500, 0, 100_000, warnings);
  const cacheMaxEntryBytes = intEnv("IEEE_CACHE_MAX_ENTRY_BYTES", 2_000_000, 1_024, 64_000_000, warnings);
  const resultTtlSeconds = intEnv("IEEE_RESULT_TTL_SECONDS", 21_600, 0, 604_800, warnings);
  const shutdownGraceMs = intEnv("IEEE_SHUTDOWN_GRACE_MS", 120_000, 1_000, 900_000, warnings);
  const logLevel = enumEnv<LogLevel>(
    "IEEE_LOG_LEVEL",
    ["silent", "error", "warn", "info", "debug"],
    "info",
    warnings
  );

  const explicitStateDir = rawEnv("IEEE_MCP_STATE_DIR") ?? rawEnv("IEEE_STATE_DIR");
  const stateDir = explicitStateDir
    ? resolveUserPath(explicitStateDir, process.cwd())
    : pickWritableDir(defaultStateDirCandidates(), "ieee-mcp");

  const outputDir = rawEnv("IEEE_OUTPUT_DIR")
    ? resolveUserPath(rawEnv("IEEE_OUTPUT_DIR") as string, process.cwd())
    : process.cwd();

  const userAgent = rawEnv("IEEE_USER_AGENT") ?? `${SERVER_NAME}/${SERVER_VERSION} (MCP stdio server)`;

  const crossrefEnabled = (rawEnv("IEEE_MCP_CROSSREF_ENABLED") ?? "1") !== "0";
  const crossrefBaseOverride = rawEnv("CROSSREF_API_BASE");
  let crossrefApiBase = "https://api.crossref.org";
  let crossrefIsDefaultBase = true;
  if (crossrefBaseOverride) {
    try {
      const parsed = new URL(crossrefBaseOverride);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("must be http or https");
      crossrefApiBase = parsed.toString().replace(/\/$/, "");
      crossrefIsDefaultBase = false;
    } catch (error) {
      warnings.push(`CROSSREF_API_BASE is not a valid URL (${redact(error)}); using the official endpoint.`);
    }
  }
  const crossrefMailto = rawEnv("CROSSREF_MAILTO") ?? null;
  if (crossrefEnabled && !crossrefMailto) {
    warnings.push(
      "CROSSREF_MAILTO is not set. Crossref's polite pool gives better throughput and stability when " +
        "requests identify a contact address; set CROSSREF_MAILTO to your e-mail to join it."
    );
  }
  const crossrefMaxRps = intEnv("CROSSREF_MAX_RPS", 3, 1, 20, warnings);
  const crossrefBatchSize = intEnv("CROSSREF_BATCH_SIZE", 20, 1, 50, warnings);
  const maxDoisPerCall = intEnv("IEEE_MCP_MAX_DOIS_PER_CALL", 20, 1, 100, warnings);
  const maxBibtexFetchesPerCall = intEnv("IEEE_MCP_MAX_BIBTEX_PER_CALL", 25, 0, 200, warnings);

  if (maxRps > 10) {
    warnings.push(
      "IEEE_MAX_RPS above 10 exceeds the documented IEEE rate limit and has been clamped."
    );
  }

  const config: Config = {
    apiKey: key,
    apiKeySource: source,
    apiKeyError: keyError,
    hasApiKey: key.length > 0,
    keyFingerprint: key.length > 0 ? fingerprintSecret(key) : "none",
    apiBase,
    apiBaseIsDefault,
    maxRps,
    dailyBudget,
    budgetWindow,
    maxRetries,
    timeoutMs,
    cacheTtlSeconds,
    cacheMaxEntries,
    cacheMaxEntryBytes,
    resultTtlSeconds,
    shutdownGraceMs,
    stateDir,
    cacheDir: path.join(stateDir, "cache"),
    resultsDir: path.join(stateDir, "results"),
    outputDir,
    logLevel,
    userAgent,
    crossrefEnabled,
    crossrefApiBase,
    crossrefIsDefaultBase,
    crossrefMailto,
    crossrefMaxRps,
    crossrefBatchSize,
    maxDoisPerCall,
    maxBibtexFetchesPerCall,
    warnings,
  };
  return config;
}

/** Config summary that is safe to return to an MCP client (no key material, no paths). */
export function describeConfig(config: Config): Record<string, unknown> {
  return {
    server: `${SERVER_NAME} ${SERVER_VERSION}`,
    api_base: config.apiBase,
    api_base_overridden: !config.apiBaseIsDefault,
    api_key_present: config.hasApiKey,
    api_key_source: config.apiKeySource,
    api_key_fingerprint_sha256_12: config.keyFingerprint,
    max_rps: config.maxRps,
    daily_budget: config.dailyBudget,
    budget_window: config.budgetWindow,
    max_retries: config.maxRetries,
    timeout_ms: config.timeoutMs,
    cache_ttl_seconds: config.cacheTtlSeconds,
    cache_max_entries: config.cacheMaxEntries,
    state_dir: config.stateDir,
    output_dir: config.outputDir,
    log_level: config.logLevel,
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    crossref_enabled: config.crossrefEnabled,
    crossref_api_base: config.crossrefApiBase,
    crossref_api_base_overridden: !config.crossrefIsDefaultBase,
    crossref_polite_pool: Boolean(config.crossrefMailto),
    crossref_max_rps: config.crossrefMaxRps,
    crossref_batch_size: config.crossrefBatchSize,
    max_dois_per_call: config.maxDoisPerCall,
  };
}

/** Reset the memoized config. Test-only. */
export function resetConfigCache(): void {
  cached = null;
}
