/**
 * IEEE Xplore Metadata Search API HTTP client.
 *
 * Responsibilities:
 *   - build documented query URLs (apikey appended to every request)
 *   - reserve a budget/rate-limit slot before every attempt (retries included)
 *   - serve/renew the on-disk cache
 *   - apply a request timeout and a bounded, jittered retry policy
 *   - never retry 400/401/403/404, and never leak the API key in an error path
 */

import path from "node:path";

import { IeeeMcpError } from "./errors.js";
import { log } from "./logger.js";
import { processCounters, reserveApiCall } from "./budget.js";
import type { Config } from "./config.js";
import { buildCacheKey, type DiskCache } from "./cache.js";
import { atomicWriteFileSync, ensureDir } from "./store.js";

/** Statuses worth retrying. 400/401/403/404 are deliberately absent. */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 507, 509, 520, 522, 524]);
const MAX_BACKOFF_MS = 15_000;
const BASE_BACKOFF_MS = 500;

export interface SearchRequestOptions {
  /** Label recorded on each normalized record, e.g. "search_papers". */
  via: string;
  /** Skip the cache read (a fresh response is still written back). */
  noCache?: boolean;
}

export interface SearchRequestResult {
  payload: unknown;
  fromCache: boolean;
  cacheKey: string;
  params: Record<string, string>;
  endpoint: string;
  retrievedAt: string;
  attempts: number;
  /** Milliseconds spent waiting for rate-limit slots during this request. */
  waitedMs: number;
  /** True when this call joined an identical request already in flight. */
  coalesced?: boolean;
}

let lastRateLimitHeaders: Record<string, string> = {};

export function getLastRateLimitHeaders(): Record<string, string> {
  return { ...lastRateLimitHeaders };
}

function captureRateLimitHeaders(headers: Headers): void {
  const captured: Record<string, string> = {};
  headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower.includes("ratelimit") || lower.includes("rate-limit") || lower === "retry-after") {
      captured[lower] = value;
    }
  });
  if (Object.keys(captured).length > 0) lastRateLimitHeaders = captured;
}

/** Build the request URL. Spaces become %20 (not '+') for the IEEE gateway. */
export function buildRequestUrl(apiBase: string, params: Record<string, string>, apiKey: string): string {
  const parsed = new URL(apiBase);
  const base = `${parsed.origin}${parsed.pathname}`;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  search.set("apikey", apiKey);
  return `${base}?${search.toString().replace(/\+/g, "%20")}`;
}

function truncate(text: string, max = 600): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}...` : collapsed;
}

interface ApiErrorShape {
  apiCode: string | null;
  apiMessage: string | null;
}

/** Pull a machine code and message out of an IEEE/Mashery error body. */
export function extractApiError(body: string, status: number): ApiErrorShape {
  const trimmed = body.trim();
  if (trimmed.length === 0) return { apiCode: String(status), apiMessage: null };
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const message =
      (typeof parsed.message === "string" && parsed.message) ||
      (typeof parsed.error === "string" && parsed.error) ||
      (typeof parsed.error_description === "string" && parsed.error_description) ||
      null;
    const code =
      (typeof parsed.code === "string" && parsed.code) ||
      (typeof parsed.errorCode === "string" && parsed.errorCode) ||
      (typeof parsed.status === "string" && parsed.status) ||
      String(status);
    return { apiCode: String(code), apiMessage: message ? truncate(message) : null };
  } catch {
    const looksLikeHtml = /<\s*(html|head|body|!doctype)/i.test(trimmed);
    return {
      apiCode: String(status),
      apiMessage: looksLikeHtml ? "<non-JSON error page from the API gateway>" : truncate(trimmed),
    };
  }
}

export function classifyHttpStatus(status: number, api: ApiErrorShape): IeeeMcpError {
  const common = {
    httpStatus: status,
    apiCode: api.apiCode,
    apiMessage: api.apiMessage,
    retryable: RETRYABLE_STATUS.has(status),
  };
  switch (status) {
    case 400:
      return new IeeeMcpError({
        ...common,
        code: "BAD_REQUEST",
        message: `IEEE API rejected the query (HTTP 400).${api.apiMessage ? ` ${api.apiMessage}` : ""}`,
        hint: "Check parameter spelling and casing. Content types are case-sensitive.",
      });
    case 401:
      return new IeeeMcpError({
        ...common,
        code: "AUTH_ERROR",
        message: `IEEE API authentication failed (HTTP 401).${api.apiMessage ? ` ${api.apiMessage}` : ""}`,
        hint: "The API key is missing, inactive or wrong. Verify IEEE_API_KEY. Not retried.",
      });
    case 403:
      return new IeeeMcpError({
        ...common,
        code: "FORBIDDEN",
        message: `IEEE API refused the request (HTTP 403).${api.apiMessage ? ` ${api.apiMessage}` : ""}`,
        hint: "The key is not entitled to this endpoint, or the account is suspended. Not retried.",
      });
    case 404:
      return new IeeeMcpError({
        ...common,
        code: "NOT_FOUND",
        message: `IEEE API returned HTTP 404.${api.apiMessage ? ` ${api.apiMessage}` : ""}`,
        hint: "Verify IEEE_API_BASE points at the Metadata Search endpoint. Not retried.",
      });
    case 429:
      return new IeeeMcpError({
        ...common,
        code: "RATE_LIMITED",
        message: `IEEE API rate limit hit (HTTP 429).${api.apiMessage ? ` ${api.apiMessage}` : ""}`,
        hint: "The documented ceiling is roughly 10 calls/second and 200 calls/day per key.",
      });
    default:
      return new IeeeMcpError({
        ...common,
        code: "SERVER_ERROR",
        message: `IEEE API error (HTTP ${status}).${api.apiMessage ? ` ${api.apiMessage}` : ""}`,
      });
  }
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_BACKOFF_MS);
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.min(Math.max(date - Date.now(), 0), MAX_BACKOFF_MS);
  return null;
}

function backoffDelay(attempt: number, retryAfterMs: number | null): number {
  if (retryAfterMs !== null) return retryAfterMs;
  const exponential = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
  return Math.round(exponential * (0.75 + Math.random() * 0.5));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withAttempts(error: IeeeMcpError, attempts: number): IeeeMcpError {
  return new IeeeMcpError({
    code: error.code,
    message: error.message,
    httpStatus: error.httpStatus,
    retryable: error.retryable,
    apiCode: error.apiCode,
    apiMessage: error.apiMessage,
    attempts,
    hint: error.hint,
  });
}

function classifyThrown(thrown: unknown, aborted: boolean, timeoutMs: number): IeeeMcpError {
  if (aborted) {
    return new IeeeMcpError({
      code: "TIMEOUT",
      message: `IEEE API request exceeded the ${timeoutMs} ms timeout.`,
      retryable: true,
      hint: "Raise IEEE_TIMEOUT_MS or check the network/proxy path.",
    });
  }
  return new IeeeMcpError({
    code: "NETWORK_ERROR",
    message: `Network failure contacting the IEEE API: ${String(
      thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : thrown
    )}`,
    retryable: true,
    hint: "Check connectivity/DNS. IEEE endpoints are frequently unreachable without a proxy.",
  });
}

export class IeeeClient {
  private lastRawPayload: unknown = null;
  /**
   * Identical requests issued concurrently (an MCP client may send several tool
   * calls at once) are coalesced so the same query never spends budget twice.
   */
  private readonly inFlight = new Map<string, Promise<SearchRequestResult>>();

  constructor(
    private readonly config: Config,
    private readonly cache: DiskCache
  ) {}

  get lastRaw(): unknown {
    return this.lastRawPayload;
  }

  /**
   * Execute one logical IEEE search. Returns a cached payload when available;
   * otherwise performs the HTTP request with a bounded retry policy.
   */
  async search(params: Record<string, string>, options: SearchRequestOptions): Promise<SearchRequestResult> {
    if (!this.config.hasApiKey) {
      throw new IeeeMcpError({
        code: "CONFIG_ERROR",
        message: this.config.apiKeyError ?? "No IEEE API key is configured.",
        retryable: false,
        hint:
          "Set the IEEE_API_KEY environment variable in the MCP client configuration " +
          "(or IEEE_API_KEY_FILE pointing at a UTF-8 file containing the key).",
      });
    }

    const endpoint = this.config.apiBase;
    const stableParams = { ...params };
    const cacheKey = buildCacheKey(endpoint, stableParams);

    if (!options.noCache) {
      const cached = this.cache.get<unknown>(cacheKey);
      if (cached) {
        processCounters.cacheHits += 1;
        log.debug(`Cache hit for ${options.via} (created ${cached.created_at}).`);
        this.lastRawPayload = cached.payload;
        return {
          payload: cached.payload,
          fromCache: true,
          cacheKey,
          params: stableParams,
          endpoint,
          retrievedAt: cached.created_at,
          attempts: 0,
          waitedMs: 0,
        };
      }

      const existing = this.cache.enabled ? this.inFlight.get(cacheKey) : undefined;
      if (existing) {
        processCounters.cacheHits += 1;
        log.debug(`Coalescing an identical in-flight request for ${options.via}.`);
        const shared = await existing;
        return { ...shared, fromCache: true, coalesced: true, attempts: 0, waitedMs: 0 };
      }
    }
    processCounters.cacheMisses += 1;

    const promise = this.performRequest(endpoint, stableParams, cacheKey, options);
    if (!options.noCache && this.cache.enabled) {
      this.inFlight.set(cacheKey, promise);
      void promise
        .catch(() => undefined)
        .finally(() => {
          if (this.inFlight.get(cacheKey) === promise) this.inFlight.delete(cacheKey);
        });
    }
    return promise;
  }

  private async performRequest(
    endpoint: string,
    stableParams: Record<string, string>,
    cacheKey: string,
    options: SearchRequestOptions
  ): Promise<SearchRequestResult> {
    const url = buildRequestUrl(endpoint, stableParams, this.config.apiKey);
    const maxAttempts = this.config.maxRetries + 1;
    let waitedMs = 0;
    let lastError: IeeeMcpError | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      // Reserve BEFORE the request so retries and failed attempts both consume budget.
      const reservation = await reserveApiCall(this.config);
      waitedMs += reservation.waitedMs;
      processCounters.httpAttempts += 1;
      if (attempt > 0) processCounters.retries += 1;

      log.info(
        `IEEE request ${options.via} attempt ${attempt + 1}/${maxAttempts} params=${JSON.stringify(stableParams)}`
      );

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
      let response: Response;
      try {
        response = await fetch(url, {
          method: "GET",
          headers: { Accept: "application/json", "User-Agent": this.config.userAgent },
          signal: controller.signal,
          redirect: "follow",
        });
      } catch (thrown) {
        lastError = classifyThrown(thrown, controller.signal.aborted, this.config.timeoutMs);
        if (attempt + 1 >= maxAttempts) break;
        const delay = backoffDelay(attempt, null);
        log.warn(`${lastError.code}: ${lastError.message} Retrying in ${delay}ms.`);
        await sleep(delay);
        continue;
      } finally {
        clearTimeout(timer);
      }

      captureRateLimitHeaders(response.headers);

      if (response.ok) {
        const text = await response.text();
        let payload: unknown;
        try {
          payload = JSON.parse(text);
        } catch {
          lastError = new IeeeMcpError({
            code: "SERVER_ERROR",
            message: `IEEE API returned HTTP 200 with a non-JSON body (${text.length} bytes).`,
            httpStatus: 200,
            retryable: true,
            hint: "Usually a transient gateway page; it gets retried automatically.",
          });
          if (attempt + 1 >= maxAttempts) break;
          const delay = backoffDelay(attempt, null);
          log.warn(`${lastError.message} Retrying in ${delay}ms.`);
          await sleep(delay);
          continue;
        }
        this.cache.set(cacheKey, endpoint, stableParams, payload);
        this.lastRawPayload = payload;
        return {
          payload,
          fromCache: false,
          cacheKey,
          params: stableParams,
          endpoint,
          retrievedAt: new Date().toISOString(),
          attempts: attempt + 1,
          waitedMs,
        };
      }

      const body = await response.text().catch(() => "");
      const error = classifyHttpStatus(response.status, extractApiError(body, response.status));
      lastError = error;

      if (!error.retryable || attempt + 1 >= maxAttempts) {
        log.warn(
          `IEEE request failed: status=${response.status} code=${error.code} ` +
            `api_code=${error.apiCode ?? "n/a"} attempts=${attempt + 1}`
        );
        throw withAttempts(error, attempt + 1);
      }

      const delay = backoffDelay(attempt, parseRetryAfter(response.headers.get("retry-after")));
      log.warn(
        `IEEE retryable failure: status=${response.status} code=${error.code}; ` +
          `retrying in ${delay}ms (next attempt ${attempt + 2}/${maxAttempts}).`
      );
      await sleep(delay);
    }

    throw withAttempts(
      lastError ??
        new IeeeMcpError({
          code: "INTERNAL_ERROR",
          message: "IEEE request failed without a recorded error.",
        }),
      maxAttempts
    );
  }

  /** Persist the last raw payload for debugging (contains no key material). */
  dumpLastRaw(file: string): void {
    if (this.lastRawPayload === null) return;
    ensureDir(path.dirname(file));
    atomicWriteFileSync(file, `${JSON.stringify(this.lastRawPayload, null, 2)}\n`);
  }
}
