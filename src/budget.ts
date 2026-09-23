/**
 * Local rate limiting + call budgeting, shared across processes.
 *
 * Design notes
 * ------------
 * - Every HTTP attempt (including each retry) reserves exactly one slot *before*
 *   the request is issued, so retries are counted against the budget.
 * - The ledger is a single JSON file guarded by an atomic `mkdir` lock, so two
 *   concurrently running MCP clients cannot double-spend the same slot or both
 *   slip past the requests-per-second ceiling.
 * - The counter is local bookkeeping only. IEEE's documented Rate Limits are
 *   enforced on their side and their reset time zone is not published, so this
 *   module deliberately does NOT claim to know the official remaining quota. It
 *   reports several windows (UTC day, local day, rolling 24h) and enforces the
 *   configured budget against them.
 */

import path from "node:path";

import { BudgetExceededError } from "./errors.js";
import { log } from "./logger.js";
import type { BudgetWindow, Config } from "./config.js";
import { atomicWriteFileSync, readJsonFile, sleep, withLock } from "./store.js";

const LEDGER_VERSION = 1;
/** Keep 48h of timestamps: enough for a UTC day, a local day and a rolling 24h. */
const RETENTION_MS = 48 * 60 * 60 * 1000;
const RATE_WINDOW_MS = 1000;

export interface Ledger {
  version: number;
  /** Epoch-ms timestamps of consumed slots, pruned to RETENTION_MS. */
  calls: number[];
  total_calls: number;
  first_call_at: string | null;
  last_call_at: string | null;
  last_block_at: string | null;
  last_block_reason: string | null;
}

function emptyLedger(): Ledger {
  return {
    version: LEDGER_VERSION,
    calls: [],
    total_calls: 0,
    first_call_at: null,
    last_call_at: null,
    last_block_at: null,
    last_block_reason: null,
  };
}

function ledgerPath(config: Config): string {
  return path.join(config.stateDir, "usage-ledger.json");
}

function ledgerLockPath(config: Config): string {
  return path.join(config.stateDir, "usage-ledger.lock");
}

function readLedger(config: Config): Ledger {
  const raw = readJsonFile<Partial<Ledger>>(ledgerPath(config));
  if (!raw || !Array.isArray(raw.calls)) return emptyLedger();
  return {
    version: LEDGER_VERSION,
    calls: raw.calls.filter((value): value is number => typeof value === "number" && Number.isFinite(value)),
    total_calls: typeof raw.total_calls === "number" ? raw.total_calls : 0,
    first_call_at: typeof raw.first_call_at === "string" ? raw.first_call_at : null,
    last_call_at: typeof raw.last_call_at === "string" ? raw.last_call_at : null,
    last_block_at: typeof raw.last_block_at === "string" ? raw.last_block_at : null,
    last_block_reason: typeof raw.last_block_reason === "string" ? raw.last_block_reason : null,
  };
}

function writeLedger(config: Config, ledger: Ledger): void {
  ledger.calls.sort((a, b) => a - b);
  atomicWriteFileSync(ledgerPath(config), `${JSON.stringify(ledger, null, 2)}\n`);
}

function prune(ledger: Ledger, now: number): void {
  const cutoff = now - RETENTION_MS;
  ledger.calls = ledger.calls.filter((timestamp) => timestamp >= cutoff);
}

export function utcDayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function localDayKey(ms: number): string {
  const date = new Date(ms);
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export interface UsageCounts {
  utcDay: string;
  localDay: string;
  localCallsUtcDay: number;
  localCallsLocalDay: number;
  localCallsRolling24h: number;
  totalCalls: number;
  lastCallAt: string | null;
  firstCallAt: string | null;
}

export function countUsage(ledger: Ledger, now: number): UsageCounts {
  const utcDay = utcDayKey(now);
  const localDay = localDayKey(now);
  let localCallsUtcDay = 0;
  let localCallsLocalDay = 0;
  let localCallsRolling24h = 0;
  const dayCutoff = now - 24 * 60 * 60 * 1000;
  for (const timestamp of ledger.calls) {
    if (utcDayKey(timestamp) === utcDay) localCallsUtcDay += 1;
    if (localDayKey(timestamp) === localDay) localCallsLocalDay += 1;
    if (timestamp >= dayCutoff) localCallsRolling24h += 1;
  }
  return {
    utcDay,
    localDay,
    localCallsUtcDay,
    localCallsLocalDay,
    localCallsRolling24h,
    totalCalls: ledger.total_calls,
    lastCallAt: ledger.last_call_at,
    firstCallAt: ledger.first_call_at,
  };
}

function budgetChecks(
  counts: UsageCounts,
  config: Config
): Array<{ window: BudgetWindow; used: number }> {
  const wanted: Array<{ window: BudgetWindow; used: number }> = [];
  const window = config.budgetWindow;
  if (window === "both" || window === "utc-day") {
    wanted.push({ window: "utc-day", used: counts.localCallsUtcDay });
  }
  if (window === "both" || window === "local-day") {
    wanted.push({ window: "local-day", used: counts.localCallsLocalDay });
  }
  if (window === "both" || window === "rolling-24h") {
    wanted.push({ window: "rolling-24h", used: counts.localCallsRolling24h });
  }
  return wanted;
}

export interface Reservation {
  counts: UsageCounts;
  /** Milliseconds spent waiting for a rate-limit slot. */
  waitedMs: number;
}

export const processCounters = {
  httpAttempts: 0,
  cacheHits: 0,
  cacheMisses: 0,
  retries: 0,
  startedAt: Date.now(),
};

function budgetError(config: Config, counts: UsageCounts, breached: { window: BudgetWindow; used: number }): BudgetExceededError {
  const detail = [
    `utc-day=${counts.localCallsUtcDay}`,
    `local-day=${counts.localCallsLocalDay}`,
    `rolling-24h=${counts.localCallsRolling24h}`,
  ].join(", ");
  return new BudgetExceededError(
    `Local daily budget reached: window "${breached.window}" already used ${breached.used}/` +
      `${config.dailyBudget} calls (${detail}). Blocked before sending a request. ` +
      "This is LOCAL bookkeeping in this MCP server, NOT the official IEEE remaining quota.",
    "IEEE does not publish the reset time zone of its Rate Limits. Raise IEEE_DAILY_BUDGET if " +
      "the budget was set too low, or wait for the window to roll over. " +
      `Ledger file: ${ledgerPath(config)}`
  );
}

/**
 * Reserve one API call slot. Blocks (short sleeps) until the requests-per-second
 * ceiling allows the call, then records the attempt in the cross-process ledger.
 * Throws BudgetExceededError when the configured budget window is exhausted.
 */
export async function reserveApiCall(config: Config): Promise<Reservation> {
  const started = Date.now();
  let waitedMs = 0;

  for (;;) {
    const decision = await withLock(ledgerLockPath(config), () => {
      const now = Date.now();
      const ledger = readLedger(config);
      prune(ledger, now);
      const counts = countUsage(ledger, now);

      const breached = budgetChecks(counts, config).find((check) => check.used >= config.dailyBudget);
      if (breached) {
        ledger.last_block_at = new Date(now).toISOString();
        ledger.last_block_reason = `budget:${breached.window}`;
        writeLedger(config, ledger);
        return { kind: "budget" as const, counts, breached };
      }

      const recent = ledger.calls.filter((timestamp) => now - timestamp < RATE_WINDOW_MS);
      if (recent.length >= config.maxRps) {
        const oldest = recent[0] ?? now;
        const waitMs = Math.max(5, RATE_WINDOW_MS - (now - oldest) + 5);
        return { kind: "wait" as const, waitMs };
      }

      ledger.calls.push(now);
      ledger.total_calls += 1;
      const isoTimestamp = new Date(now).toISOString();
      if (!ledger.first_call_at) ledger.first_call_at = isoTimestamp;
      ledger.last_call_at = isoTimestamp;
      writeLedger(config, ledger);
      return { kind: "ok" as const, counts: countUsage(ledger, now) };
    });

    if (decision.kind === "ok") {
      return { counts: decision.counts, waitedMs };
    }
    if (decision.kind === "budget") {
      log.warn(
        `Budget guard blocked a request (${decision.breached.window} ${decision.breached.used}/${config.dailyBudget}).`
      );
      throw budgetError(config, decision.counts, decision.breached);
    }

    waitedMs += decision.waitMs;
    // Guard against pathological waits if the clock jumps.
    if (Date.now() - started > 30_000) {
      throw new BudgetExceededError(
        "Gave up waiting for a rate-limit slot after 30s; the requests-per-second ceiling " +
          "could not be satisfied. Lower IEEE_MAX_RPS or reduce concurrency."
      );
    }
    await sleep(decision.waitMs);
  }
}

/** Read-only usage snapshot for the `ieee_status` tool. */
export function getUsageSnapshot(config: Config): UsageCounts & { ledgerFile: string } {
  const now = Date.now();
  const ledger = readLedger(config);
  return { ...countUsage(ledger, now), ledgerFile: ledgerPath(config) };
}

/** Delete the local ledger. Affects local bookkeeping only. */
export function resetLocalUsage(config: Config): void {
  writeLedger(config, emptyLedger());
}
