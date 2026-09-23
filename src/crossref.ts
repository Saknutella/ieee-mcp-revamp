/**
 * Crossref REST API client.
 *
 * SECOND data source. It exists because the IEEE Metadata Search API exposes no
 * reference list at all: `citing_paper_count` / `citing_patent_count` are both
 * incoming-citation counts. Crossref carries the publisher-deposited bibliography
 * (outgoing references), including the `key` that preserves the numbering used
 * in the paper.
 *
 * Verified against IEEE Xplore on two papers (21 references, position by
 * position, including the entries the publisher deposited without a DOI).
 * That is a small sample, so every response this client feeds is labelled as
 * Crossref-sourced and flagged as needing manual verification.
 *
 * This client deliberately does NOT touch the IEEE budget ledger: Crossref is
 * free and has no daily quota. It has its own politeness rate limiter instead.
 */

import { IeeeMcpError } from "./errors.js";
import { log } from "./logger.js";
import type { Config } from "./config.js";
import { buildCacheKey, type DiskCache } from "./cache.js";
import { sleep } from "./store.js";

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 520, 522, 524]);
const MAX_BACKOFF_MS = 10_000;
const BASE_BACKOFF_MS = 500;

export const CROSSREF_SOURCE_LABEL = "Crossref REST API";

/** In-process politeness limiter. Crossref asks callers to be gentle. */
class RateLimiter {
  private timestamps: number[] = [];

  constructor(private readonly maxRps: number) {}

  async acquire(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.timestamps = this.timestamps.filter((timestamp) => now - timestamp < 1000);
      if (this.timestamps.length < this.maxRps) {
        this.timestamps.push(now);
        return;
      }
      const oldest = this.timestamps[0] ?? now;
      await sleep(Math.max(5, 1000 - (now - oldest) + 5));
    }
  }
}

/**
 * Crossref reference metadata occasionally contains HTML entities
 * (the measured example: `9.2&#x00B5;W`, i.e. a micro sign).
 */
export function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _match;
    })
    .replace(/&#(\d+);/g, (_match, dec: string) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _match;
    })
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const decoded = decodeEntities(value).trim();
  return decoded.length > 0 ? decoded : null;
}

function firstOf(value: unknown): string | null {
  if (Array.isArray(value)) return text(value[0]);
  return text(value);
}

export interface CrossrefReferenceEntry {
  /** 1-based position reconstructed from `key` (ref7 -> 7), when derivable. */
  order: number | null;
  /** The publisher's citation key, e.g. "ref7". Preserves in-paper numbering. */
  key: string | null;
  doi: string | null;
  /** `doi-asserted-by` as deposited (commonly "publisher"). */
  doi_asserted_by: string | null;
  title: string | null;
  /** The reference's own authors, as deposited (may be a surname only). */
  author: string | null;
  year: string | null;
  container: string | null;
  volume: string | null;
  first_page: string | null;
  /** Free-text citation string, when the publisher supplied one instead of fields. */
  unstructured: string | null;
  /** True when this reference could be tied to a DOI. */
  has_doi: boolean;
}

export interface CrossrefWorkSummary {
  doi: string;
  title: string | null;
  container_title: string | null;
  publisher: string | null;
  type: string | null;
  year: string | null;
  volume: string | null;
  issue: string | null;
  page: string | null;
  issn: string | null;
  isbn: string | null;
  authors: string | null;
  /** Crossref's own reference count field. */
  references_count: number | null;
  /** Incoming citations - a different metric; included only for disambiguation. */
  is_referenced_by_count: number | null;
  deposited: string | null;
  indexed: string | null;
}

export interface CrossrefWorkResult {
  work: CrossrefWorkSummary;
  references: CrossrefReferenceEntry[];
  fromCache: boolean;
  crossrefUrl: string;
  retrievedAt: string;
}

function orderFromKey(key: string | null): number | null {
  if (!key) return null;
  const match = /(\d+)/.exec(key);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function normalizeReference(raw: Record<string, unknown>): CrossrefReferenceEntry {
  const doi = text(raw.DOI);
  const key = text(raw.key);
  return {
    order: orderFromKey(key),
    key,
    doi: doi ? doi.toLowerCase() : null,
    doi_asserted_by: text(raw["doi-asserted-by"]),
    title: text(raw["article-title"]) ?? text(raw["volume-title"]) ?? text(raw["series-title"]),
    author: text(raw.author) ?? text(raw.editor),
    year: text(raw.year),
    container: text(raw["journal-title"]),
    volume: text(raw.volume),
    first_page: text(raw["first-page"]),
    unstructured: text(raw.unstructured),
    has_doi: Boolean(doi),
  };
}

/**
 * Crossref returns `reference` in deposit order, not in the order the paper
 * cites them. The `key` (ref1, ref2, ...) is the whole reason this data is
 * useful, so sort by it. Array.prototype.sort is stable, so entries without a
 * derivable order keep their relative position at the end.
 */
export function sortReferences(references: CrossrefReferenceEntry[]): CrossrefReferenceEntry[] {
  return [...references].sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER));
}

function normalizeWork(message: Record<string, unknown>, fallbackDoi: string): CrossrefWorkSummary {
  const authors = Array.isArray(message.author)
    ? (message.author as Array<Record<string, unknown>>)
        .map((entry) => [text(entry.given), text(entry.family)].filter(Boolean).join(" "))
        .filter((name) => name.length > 0)
        .join("; ")
    : "";
  const issued = message.issued as { "date-parts"?: number[][] } | undefined;
  const referenceCount = message["references-count"];
  const referencedBy = message["is-referenced-by-count"];
  const deposited = message.deposited as { "date-time"?: string } | undefined;
  const indexed = message.indexed as { "date-time"?: string } | undefined;
  return {
    doi: text(message.DOI) ?? fallbackDoi,
    title: firstOf(message.title),
    container_title: firstOf(message["container-title"]),
    publisher: text(message.publisher),
    type: text(message.type),
    year: issued?.["date-parts"]?.[0]?.[0] !== undefined ? String(issued["date-parts"][0][0]) : null,
    volume: text(message.volume),
    issue: text(message.issue),
    page: text(message.page),
    issn: Array.isArray(message.ISSN) ? message.ISSN.join(", ") : text(message.ISSN),
    isbn: Array.isArray(message.ISBN) ? message.ISBN.join(", ") : text(message.ISBN),
    authors: authors.length > 0 ? authors : null,
    references_count: typeof referenceCount === "number" ? referenceCount : null,
    is_referenced_by_count: typeof referencedBy === "number" ? referencedBy : null,
    deposited: deposited?.["date-time"] ?? null,
    indexed: indexed?.["date-time"] ?? null,
  };
}

interface RequestOptions {
  accept: string;
  cacheKey: string;
  /** Response body kind. */
  kind: "json" | "text";
}

export class CrossrefClient {
  private readonly limiter: RateLimiter;
  private requests = 0;
  private cacheHits = 0;

  constructor(
    private readonly config: Config,
    private readonly cache: DiskCache
  ) {
    this.limiter = new RateLimiter(config.crossrefMaxRps);
  }

  get stats(): { requests: number; cacheHits: number } {
    return { requests: this.requests, cacheHits: this.cacheHits };
  }

  resetStats(): void {
    this.requests = 0;
    this.cacheHits = 0;
  }

  private get enabled(): boolean {
    return this.config.crossrefEnabled;
  }

  private userAgent(): string {
    const base = this.config.userAgent;
    return this.config.crossrefMailto ? `${base} (mailto:${this.config.crossrefMailto})` : base;
  }

  workUrl(doi: string): string {
    return `${this.config.crossrefApiBase}/works/${encodeURIComponent(doi)}`;
  }

  bibtexUrl(doi: string): string {
    return `${this.config.crossrefApiBase}/works/${encodeURIComponent(doi)}/transform/application/x-bibtex`;
  }

  /** GET with cache, politeness limiting, timeout and bounded retries. */
  private async request(url: string, options: RequestOptions): Promise<{ body: string; fromCache: boolean }> {
    if (!this.enabled) {
      throw new IeeeMcpError({
        code: "CONFIG_ERROR",
        message: "Crossref lookups are disabled (IEEE_MCP_CROSSREF_ENABLED=0).",
        hint: "Set IEEE_MCP_CROSSREF_ENABLED=1 to enable reference lookups.",
      });
    }

    const cacheKey = buildCacheKey(url, {});
    const cached = this.cache.get<string>(cacheKey);
    if (cached && typeof cached.payload === "string") {
      this.cacheHits += 1;
      return { body: cached.payload, fromCache: true };
    }

    const maxAttempts = this.config.maxRetries + 1;
    let lastError: IeeeMcpError | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      await this.limiter.acquire();
      this.requests += 1;
      log.debug(`Crossref request attempt ${attempt + 1}/${maxAttempts}: ${url}`);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
      let response: Response;
      try {
        response = await fetch(url, {
          method: "GET",
          headers: { Accept: options.accept, "User-Agent": this.userAgent() },
          signal: controller.signal,
          redirect: "follow",
        });
      } catch (thrown) {
        clearTimeout(timer);
        lastError = new IeeeMcpError({
          code: controller.signal.aborted ? "TIMEOUT" : "NETWORK_ERROR",
          message: controller.signal.aborted
            ? `Crossref request exceeded the ${this.config.timeoutMs} ms timeout.`
            : `Network failure contacting Crossref: ${String(thrown instanceof Error ? thrown.message : thrown)}`,
          retryable: true,
          attempts: attempt + 1,
          hint: "Crossref (api.crossref.org) is normally reachable without a proxy.",
        });
        if (attempt + 1 >= maxAttempts) break;
        await sleep(BASE_BACKOFF_MS * 2 ** attempt);
        continue;
      } finally {
        clearTimeout(timer);
      }

      if (response.ok) {
        const body = await response.text();
        if (options.kind === "json") {
          try {
            JSON.parse(body);
          } catch {
            lastError = new IeeeMcpError({
              code: "SERVER_ERROR",
              message: `Crossref returned HTTP 200 with a non-JSON body (${body.length} bytes).`,
              httpStatus: 200,
              retryable: true,
              attempts: attempt + 1,
            });
            if (attempt + 1 >= maxAttempts) break;
            await sleep(BASE_BACKOFF_MS * 2 ** attempt);
            continue;
          }
        }
        this.cache.set(cacheKey, url, {}, body);
        return { body, fromCache: false };
      }

      const body = await response.text().catch(() => "");
      const retryable = RETRYABLE_STATUS.has(response.status);
      lastError = new IeeeMcpError({
        code:
          response.status === 404
            ? "NOT_FOUND"
            : response.status === 429
              ? "RATE_LIMITED"
              : response.status >= 500
                ? "SERVER_ERROR"
                : "BAD_REQUEST",
        message: `Crossref returned HTTP ${response.status}.`,
        httpStatus: response.status,
        retryable,
        apiCode: String(response.status),
        apiMessage: body.trim().slice(0, 300) || null,
        attempts: attempt + 1,
        hint:
          response.status === 404
            ? "Crossref has no record for this DOI. The paper may not be deposited there."
            : null,
      });
      if (!retryable || attempt + 1 >= maxAttempts) break;
      const retryAfter = Number(response.headers.get("retry-after"));
      const delay = Number.isFinite(retryAfter) && retryAfter >= 0
        ? Math.min(retryAfter * 1000, MAX_BACKOFF_MS)
        : Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
      log.warn(`Crossref retryable failure (HTTP ${response.status}); retrying in ${delay}ms.`);
      await sleep(delay);
    }

    throw (
      lastError ??
      new IeeeMcpError({ code: "INTERNAL_ERROR", message: "Crossref request failed without a recorded error." })
    );
  }

  /** Fetch one work plus its reference list. */
  async getWork(doi: string): Promise<CrossrefWorkResult> {
    const url = this.workUrl(doi);
    const { body, fromCache } = await this.request(url, {
      accept: "application/json",
      cacheKey: url,
      kind: "json",
    });
    const parsed = JSON.parse(body) as { message?: Record<string, unknown> };
    const message = parsed.message;
    if (!message || typeof message !== "object") {
      throw new IeeeMcpError({
        code: "SERVER_ERROR",
        message: "Crossref response did not contain a `message` object.",
        hint: "This usually means the DOI resolved to something unexpected.",
      });
    }
    const rawReferences = Array.isArray(message.reference)
      ? (message.reference as Array<Record<string, unknown>>)
      : [];
    return {
      work: normalizeWork(message, doi.toLowerCase()),
      references: sortReferences(rawReferences.map((entry) => normalizeReference(entry))),
      fromCache,
      crossrefUrl: url,
      retrievedAt: new Date().toISOString(),
    };
  }

  /**
   * Fetch several works in ONE request.
   *
   * Crossref's `/works` endpoint accepts a repeated-field filter and returns the
   * full records, including each work's complete `reference` array. Measured:
   * 3 works carrying 14 + 7 + 21 references came back in a single 14.9 KB response.
   *
   * Filter syntax matters: `doi:A,doi:B` (field name repeated). `doi:A,B` is
   * rejected with HTTP 400 - "should be of the form: key:val,...,keyN:valN".
   */
  async getWorksBatch(dois: string[]): Promise<{ results: Map<string, CrossrefWorkResult>; fromCache: boolean }> {
    const results = new Map<string, CrossrefWorkResult>();
    if (dois.length === 0) return { results, fromCache: false };

    const filter = dois.map((doi) => `doi:${doi}`).join(",");
    const url = `${this.config.crossrefApiBase}/works?filter=${encodeURIComponent(filter)}&rows=${dois.length}`;
    const { body, fromCache } = await this.request(url, {
      accept: "application/json",
      cacheKey: url,
      kind: "json",
    });
    const parsed = JSON.parse(body) as { message?: { items?: Array<Record<string, unknown>> } };
    const items = parsed.message?.items;
    if (!Array.isArray(items)) {
      throw new IeeeMcpError({
        code: "SERVER_ERROR",
        message: "Crossref batch response did not contain `message.items`.",
        hint: "The caller falls back to per-DOI requests.",
      });
    }

    const byDoi = new Map<string, Record<string, unknown>>();
    for (const item of items) {
      const itemDoi = text(item.DOI);
      if (itemDoi) byDoi.set(itemDoi.toLowerCase(), item);
    }
    for (const doi of dois) {
      const item = byDoi.get(doi.toLowerCase());
      if (!item) continue; // absent = Crossref has no such record
      const rawReferences = Array.isArray(item.reference)
        ? (item.reference as Array<Record<string, unknown>>)
        : [];
      results.set(doi.toLowerCase(), {
        work: normalizeWork(item, doi.toLowerCase()),
        references: sortReferences(rawReferences.map((entry) => normalizeReference(entry))),
        fromCache,
        crossrefUrl: this.workUrl(doi),
        retrievedAt: new Date().toISOString(),
      });
    }
    return { results, fromCache };
  }

  /** Fetch authoritative BibTeX for one DOI via Crossref content negotiation. */
  async getBibtex(doi: string): Promise<{ bibtex: string; fromCache: boolean; url: string }> {
    const url = this.bibtexUrl(doi);
    const { body, fromCache } = await this.request(url, {
      accept: "application/x-bibtex",
      cacheKey: url,
      kind: "text",
    });
    return { bibtex: body.trim(), fromCache, url };
  }
}
