/**
 * Search orchestration: parameter validation, single/multi query execution,
 * bounded pagination, merging, de-duplication and payload assembly.
 *
 * Kept separate from MCP tool registration so it can be exercised directly by
 * tests without a stdio transport.
 *
 * Scope note: the IEEE Xplore Metadata Search API performs a free-text search of
 * *configured metadata fields and the abstract*. It is not a full-text search of
 * article bodies, and this server never describes it as one.
 */

import { InputError } from "./errors.js";
import { log } from "./logger.js";
import { processCounters } from "./budget.js";
import type { Config } from "./config.js";
import type { IeeeClient } from "./ieeeClient.js";
import { normalizeArticles, SOURCE_LABEL } from "./normalize.js";
import { dedupeRecords, type DedupOutcome } from "./dedupe.js";
import {
  CONTENT_TYPES,
  DEFAULT_MAX_RECORDS,
  MAX_RECORDS_PER_REQUEST,
  PUBLISHERS,
  SORT_FIELDS,
  SORT_ORDERS,
} from "./ieeeSpec.js";
import type { ResultStore } from "./resultStore.js";
import { newSearchId } from "./resultStore.js";
import type { IEEEArticle, IEEESearchResponse, PaginationInfo, PaperRecord, SearchResultPayload, UsageInfo } from "./types.js";
import { getUsageSnapshot } from "./budget.js";

export interface SearchArgs {
  querytext?: string;
  queries?: string[];
  meta_data?: string;
  article_title?: string;
  abstract?: string;
  author?: string;
  affiliation?: string;
  index_terms?: string;
  thesaurus_terms?: string;
  doi?: string;
  article_number?: string;
  publication_title?: string;
  publication_number?: string;
  publication_year?: string;
  start_year?: string;
  end_year?: string;
  start_date?: string;
  end_date?: string;
  content_type?: string;
  open_access?: boolean;
  isbn?: string;
  issn?: string;
  is_number?: string;
  publisher?: string;
  max_records?: number;
  start_record?: number;
  auto_paginate?: boolean;
  max_total_records?: number;
  max_requests?: number;
  sort_field?: string;
  sort_order?: "asc" | "desc";
  no_cache?: boolean;
}

export interface SearchContext {
  config: Config;
  client: IeeeClient;
  results: ResultStore;
}

interface JobResult {
  label: string;
  params: Record<string, string>;
  total_records: number | null;
  articles: IEEEArticle[];
  requests: number;
  cache_hits: number;
  pages: number;
  has_more: boolean;
  next_start_record: number | null;
  stop_reason: string | null;
  from_cache: boolean;
  retrieved_at: string;
}

/** Clone of the params without the paging keys, used as a stable query description. */
function describeParams(params: Record<string, string>): string {
  const entries = Object.entries(params).filter(([key]) => key !== "start_record" && key !== "max_records");
  return entries.map(([key, value]) => `${key}="${value}"`).join(" & ") || "(no filters)";
}

function readTotalRecords(payload: IEEESearchResponse): number | null {
  for (const key of ["total_records", "totalfound", "total_searched", "totalsearched"] as const) {
    const value = payload[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function asInt(value: unknown, fallback: number | null, min: number, max: number): number | null {
  if (value === undefined || value === null) return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function rejectUnknown<T extends string>(field: string, value: string, allowed: readonly T[]): T {
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new InputError(
    `Invalid ${field}: "${value}".`,
    `IEEE documents this parameter as case-sensitive. Allowed values: ${allowed.join(" | ")}`
  );
}

export interface BuiltParams {
  params: Record<string, string>;
  warnings: string[];
  /** True when the query is a direct identifier lookup. */
  identifierLookup: boolean;
}

/** Translate tool arguments into documented IEEE query parameters. */
export function buildApiParams(args: SearchArgs): BuiltParams {
  const warnings: string[] = [];
  const params: Record<string, string> = {};

  if (args.content_type) rejectUnknown("content_type", args.content_type, CONTENT_TYPES);
  if (args.sort_field) rejectUnknown("sort_field", args.sort_field, SORT_FIELDS);
  if (args.sort_order) rejectUnknown("sort_order", args.sort_order, SORT_ORDERS);
  if (args.publisher) rejectUnknown("publisher", args.publisher, PUBLISHERS);

  const direct: Array<[keyof SearchArgs, string]> = [
    ["querytext", "querytext"],
    ["meta_data", "meta_data"],
    ["article_title", "article_title"],
    ["abstract", "abstract"],
    ["author", "author"],
    ["affiliation", "affiliation"],
    ["index_terms", "index_terms"],
    ["thesaurus_terms", "thesaurus_terms"],
    ["publication_title", "publication_title"],
    ["publication_number", "publication_number"],
    ["publication_year", "publication_year"],
    ["start_year", "start_year"],
    ["end_year", "end_year"],
    ["start_date", "start_date"],
    ["end_date", "end_date"],
    ["content_type", "content_type"],
    ["isbn", "isbn"],
    ["issn", "issn"],
    ["is_number", "is_number"],
    ["publisher", "publisher"],
    ["sort_field", "sort_field"],
    ["sort_order", "sort_order"],
  ];
  for (const [argKey, apiKey] of direct) {
    const value = args[argKey];
    if (typeof value === "string" && value.trim().length > 0) params[apiKey] = value.trim();
  }

  if (typeof args.open_access === "boolean") {
    // IEEE documents this value as `True` / `False` with that exact casing.
    params.open_access = args.open_access ? "True" : "False";
  }

  // Documented constraint: `author` needs at least 3 characters before a wildcard.
  const author = params.author;
  if (author && author.includes("*")) {
    const beforeWildcard = author.split("*")[0] ?? "";
    if (beforeWildcard.trim().length < 3) {
      throw new InputError(
        `Invalid author filter "${author}": IEEE requires at least 3 characters before a wildcard (*).`,
        "For example use \"Zhan*\" instead of \"Zh*\"."
      );
    }
  }

  // Documented identifier precedence.
  const articleNumber = (args.article_number ?? "").trim();
  const doi = (args.doi ?? "").trim();
  if (articleNumber.length > 0) {
    if (Object.keys(params).length > 0) {
      warnings.push(
        "article_number was supplied: IEEE ignores every other search parameter when article_number is used, " +
          `so these were dropped: ${Object.keys(params).join(", ")}.`
      );
    }
    return {
      params: { article_number: articleNumber },
      warnings,
      identifierLookup: true,
    };
  }
  if (doi.length > 0) {
    if (Object.keys(params).length > 0) {
      warnings.push(
        "doi was supplied: IEEE ignores every other search parameter except article_number, " +
          `so these were dropped: ${Object.keys(params).join(", ")}.`
      );
    }
    return { params: { doi }, warnings, identifierLookup: true };
  }

  const hasQueryVariants = (args.queries ?? []).some((value) => value.trim().length > 0);
  if (Object.keys(params).length === 0 && !hasQueryVariants) {
    throw new InputError(
      "No search criteria were provided.",
      "Supply at least one of: querytext, queries, meta_data, article_title, abstract, author, " +
        "affiliation, index_terms, thesaurus_terms, doi, article_number, publication_title, isbn, issn."
    );
  }

  return { params, warnings, identifierLookup: false };
}

interface JobSpec {
  label: string;
  params: Record<string, string>;
}

/** Expand the tool arguments into the list of queries to execute. */
export function buildJobSpecs(args: SearchArgs, base: BuiltParams): JobSpec[] {
  if (base.identifierLookup) {
    return [{ label: describeParams(base.params), params: base.params }];
  }

  const variants = (args.queries ?? [])
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  if (variants.length === 0) {
    return [{ label: describeParams(base.params), params: base.params }];
  }

  if (variants.length > 1 && base.params.querytext) {
    base.warnings.push(
      `Both querytext and queries were supplied; querytext was replaced by the ${variants.length} query variants.`
    );
  }

  const seen = new Set<string>();
  const specs: JobSpec[] = [];
  for (const variant of variants) {
    if (seen.has(variant)) {
      base.warnings.push(`Duplicate query variant ignored: "${variant}".`);
      continue;
    }
    seen.add(variant);
    const params = { ...base.params, querytext: variant };
    specs.push({ label: `querytext="${variant}"`, params });
  }
  return specs.length > 0 ? specs : [{ label: describeParams(base.params), params: base.params }];
}

async function runJob(
  context: SearchContext,
  spec: JobSpec,
  options: {
    pageSize: number;
    startRecord: number;
    autoPaginate: boolean;
    maxTotalRecords: number;
    maxRequestsForThisJob: number;
    noCache: boolean;
    via: string;
    identifierLookup: boolean;
  }
): Promise<JobResult> {
  const { client } = context;

  // IEEE documents `article_number` (and `doi`) as usable *only by themselves*.
  // Verified against the live API: adding `max_records` makes IEEE answer
  // `total_records: 1` with no `articles` array at all. So send the identifier
  // alone and never paginate.
  if (options.identifierLookup) {
    const result = await client.search({ ...spec.params }, { via: options.via, noCache: options.noCache });
    const payload = result.payload as IEEESearchResponse;
    const pageArticles = Array.isArray(payload.articles) ? payload.articles : [];
    return {
      label: spec.label,
      params: spec.params,
      total_records: readTotalRecords(payload),
      articles: pageArticles,
      requests: 1,
      cache_hits: result.fromCache ? 1 : 0,
      pages: 1,
      has_more: false,
      next_start_record: null,
      stop_reason: "identifier lookup returns at most one record",
      from_cache: result.fromCache,
      retrieved_at: result.retrievedAt,
    };
  }

  const articles: IEEEArticle[] = [];
  let requests = 0;
  let cacheHits = 0;
  let pages = 0;
  let totalRecords: number | null = null;
  let startRecord = options.startRecord;
  let hasMore = false;
  let nextStartRecord: number | null = null;
  let stopReason: string | null = null;
  let fromCache = false;
  let retrievedAt = new Date().toISOString();
  const seenFingerprints = new Set<string>();

  for (;;) {
    if (requests >= options.maxRequestsForThisJob) {
      stopReason = `reached max_requests limit (${options.maxRequestsForThisJob})`;
      break;
    }

    const params: Record<string, string> = {
      ...spec.params,
      max_records: String(options.pageSize),
      start_record: String(startRecord),
    };

    const result = await client.search(params, { via: options.via, noCache: options.noCache });
    requests += 1;
    if (result.fromCache) cacheHits += 1;
    pages += 1;
    fromCache = fromCache || result.fromCache;
    retrievedAt = result.retrievedAt;

    const payload = result.payload as IEEESearchResponse;
    const pageArticles = Array.isArray(payload.articles) ? payload.articles : [];
    if (totalRecords === null) totalRecords = readTotalRecords(payload);

    let added = 0;
    for (const article of pageArticles) {
      const fingerprint = `${article?.article_number ?? ""}|${article?.doi ?? ""}|${article?.title ?? ""}`;
      if (seenFingerprints.has(fingerprint)) continue;
      seenFingerprints.add(fingerprint);
      articles.push(article);
      added += 1;
    }

    // Off-by-one fix: the last returned index must be compared against the total.
    const lastReturnedIndex = startRecord + pageArticles.length - 1;
    const pageBasedMore =
      totalRecords !== null
        ? lastReturnedIndex < totalRecords
        : pageArticles.length >= options.pageSize;

    // A short page means the API has nothing further to hand out.
    if (pageArticles.length < options.pageSize) {
      hasMore = false;
      nextStartRecord = null;
      stopReason = stopReason ?? "IEEE returned fewer records than requested; no further pages available";
      break;
    }

    hasMore = pageBasedMore;
    nextStartRecord = hasMore ? lastReturnedIndex + 1 : null;

    if (!options.autoPaginate) {
      if (hasMore) stopReason = "auto_paginate is disabled";
      break;
    }
    if (!hasMore) break;
    if (articles.length >= options.maxTotalRecords) {
      stopReason = `reached max_total_records limit (${options.maxTotalRecords})`;
      hasMore = true;
      nextStartRecord = lastReturnedIndex + 1;
      break;
    }
    if (added === 0) {
      stopReason = "a page returned no new records; stopping to avoid an infinite paging loop";
      hasMore = false;
      nextStartRecord = null;
      break;
    }

    startRecord = lastReturnedIndex + 1;
  }

  log.debug(
    `Job ${spec.label}: pages=${pages} requests=${requests} articles=${articles.length} ` +
      `total=${totalRecords ?? "unknown"} has_more=${hasMore}`
  );

  return {
    label: spec.label,
    params: spec.params,
    total_records: totalRecords,
    articles,
    requests,
    cache_hits: cacheHits,
    pages,
    has_more: hasMore,
    next_start_record: nextStartRecord,
    stop_reason: stopReason,
    from_cache: fromCache,
    retrieved_at: retrievedAt,
  };
}

export interface SearchOutcome {
  payload: SearchResultPayload;
  /** Raw payload of the last IEEE response, for optional debugging dumps. */
  raw: unknown;
}

export async function executeSearch(context: SearchContext, args: SearchArgs, via: string): Promise<SearchOutcome> {
  const { config, client, results } = context;
  const base = buildApiParams(args);
  const warnings = [...base.warnings];
  const specs = buildJobSpecs(args, base);

  const pageSize = asInt(args.max_records, DEFAULT_MAX_RECORDS, 1, MAX_RECORDS_PER_REQUEST) as number;
  if (args.max_records !== undefined && args.max_records > MAX_RECORDS_PER_REQUEST) {
    warnings.push(
      `max_records=${args.max_records} exceeds the documented IEEE maximum of ` +
        `${MAX_RECORDS_PER_REQUEST}; clamped to ${MAX_RECORDS_PER_REQUEST}.`
    );
  }
  const startRecord = asInt(args.start_record, 1, 1, 100_000) as number;
  const autoPaginate = args.auto_paginate === true;
  const maxTotalRecords = asInt(args.max_total_records, 200, 1, 1000) as number;
  const defaultMaxRequests = autoPaginate ? 5 : Math.max(1, specs.length);
  const maxRequests = asInt(args.max_requests, defaultMaxRequests, 1, 20) as number;

  if (specs.length > maxRequests) {
    warnings.push(
      `max_requests=${maxRequests} is lower than the number of query variants (${specs.length}); ` +
        `only the first ${maxRequests} were executed.`
    );
  }

  const executed = specs.slice(0, maxRequests);
  const jobResults: JobResult[] = [];
  let budgetForJob = maxRequests;
  for (const spec of executed) {
    if (budgetForJob <= 0) break;
    const job = await runJob(context, spec, {
      pageSize,
      startRecord,
      autoPaginate,
      maxTotalRecords,
      maxRequestsForThisJob: budgetForJob,
      noCache: args.no_cache === true,
      via,
      identifierLookup: base.identifierLookup,
    });
    budgetForJob -= job.requests;
    jobResults.push(job);
  }

  const rawArticles: IEEEArticle[] = [];
  for (const job of jobResults) rawArticles.push(...job.articles);

  const normalized: PaperRecord[] = normalizeArticles(rawArticles, via);
  const deduped: DedupOutcome = dedupeRecords(normalized);
  const capped = deduped.records.slice(0, maxTotalRecords);
  if (deduped.records.length > capped.length) {
    warnings.push(
      `Result set truncated from ${deduped.records.length} unique records to max_total_records=${maxTotalRecords}.`
    );
  }

  const singleJob = jobResults.length === 1 ? jobResults[0] : null;
  const totalRecords = singleJob ? singleJob.total_records : null;
  const hasMore = jobResults.some((job) => job.has_more);
  const nextStart = singleJob ? singleJob.next_start_record : null;

  const pagination: PaginationInfo = {
    mode: singleJob ? "single" : "merged",
    start_record: singleJob ? startRecord : 1,
    max_records: pageSize,
    last_returned_index: singleJob && singleJob.articles.length > 0 ? startRecord + singleJob.articles.length - 1 : 0,
    total_records: totalRecords,
    has_more: hasMore,
    next_start_record: nextStart,
    pages_fetched: jobResults.reduce((sum, job) => sum + job.pages, 0),
    truncated_by_limit: jobResults.some((job) => job.stop_reason?.startsWith("reached")) || deduped.records.length > capped.length,
    stop_reason: singleJob ? singleJob.stop_reason : "merged multi-query result: page each query individually for full paging",
  };

  if (!singleJob) {
    warnings.push(
      "Multi-query (merged) result: total_records is not meaningful for a union of queries, so it is null. " +
        "See per_query for each query's own totals and paging state."
    );
  }
  if (base.identifierLookup && capped.length === 0 && (totalRecords ?? 0) > 0) {
    warnings.push(
      "IEEE reported a matching record for this identifier but returned no record body. " +
        "This happens for a small number of documents that are indexed for search but not " +
        "retrievable through the Metadata Search API."
    );
  }
  if (singleJob && hasMore && nextStart !== null) {
    warnings.push(`More results are available. Request the next page with start_record=${nextStart}.`);
  }

  const usageSnapshot = getUsageSnapshot(config);
  const usage: UsageInfo = {
    process_http_attempts: processCounters.httpAttempts,
    process_cache_hits: processCounters.cacheHits,
    local_calls_utc_day: usageSnapshot.localCallsUtcDay,
    local_calls_local_day: usageSnapshot.localCallsLocalDay,
    local_calls_rolling_24h: usageSnapshot.localCallsRolling24h,
    daily_budget: config.dailyBudget,
    budget_window: config.budgetWindow,
    remaining_local_budget: Math.max(0, config.dailyBudget - usageSnapshot.localCallsUtcDay),
    note:
      "Local bookkeeping in this MCP server only. It is NOT the official IEEE remaining quota; " +
      "IEEE does not publish its reset time zone, so several windows are tracked " +
      `(utc day ${usageSnapshot.utcDay}, local day ${usageSnapshot.localDay}, rolling 24h).`,
  };

  const requesterAttempts = jobResults.reduce((sum, job) => sum + job.requests, 0);
  const cacheHits = jobResults.reduce((sum, job) => sum + job.cache_hits, 0);

  const payload: SearchResultPayload = {
    search_id: newSearchId(),
    source: SOURCE_LABEL,
    search_scope: "metadata_and_abstract",
    retrieved_at: jobResults[0]?.retrieved_at ?? new Date().toISOString(),
    query: {
      executed_queries: executed.map((spec) => spec.label),
      api_params: executed.map((spec) => spec.params),
      max_records: pageSize,
      start_record: startRecord,
      auto_paginate: autoPaginate,
      max_total_records: maxTotalRecords,
      max_requests: maxRequests,
      cache_enabled: config.cacheTtlSeconds > 0,
      cache_ttl_seconds: config.cacheTtlSeconds,
    },
    total_records: totalRecords,
    returned_records: capped.length,
    pagination,
    usage,
    cache: {
      hit: cacheHits > 0 && cacheHits === requesterAttempts,
      ttl_seconds: config.cacheTtlSeconds,
      cache_enabled: config.cacheTtlSeconds > 0,
    },
    dedup: {
      duplicates_removed: deduped.duplicatesRemoved,
      matched_on: deduped.matchedOn,
      keys: ["doi", "article_number", "title_year"],
    },
    warnings,
    queries_executed: executed.map((spec) => spec.label),
    per_query: jobResults.map((job) => ({
      query: job.label,
      api_params: job.params,
      total_records: job.total_records,
      returned: job.articles.length,
      requests: job.requests,
      pages: job.pages,
      cache_hit: job.cache_hits === job.requests && job.requests > 0,
      has_more: job.has_more,
      next_start_record: job.next_start_record,
      stop_reason: job.stop_reason,
    })),
    articles: capped,
  } satisfies SearchResultPayload;

  payload.cache.hit = requesterAttempts > 0 && cacheHits === requesterAttempts;

  results.save(payload);
  return { payload, raw: client.lastRaw };
}

export interface LookupOutcome {
  payload: SearchResultPayload;
  raw: unknown;
}

/** Shared implementation for identifier lookups (`article_number` / `doi`). */export async function executeIdentifierLookup(
  context: SearchContext,
  args: { article_number?: string; doi?: string },
  via: string
): Promise<LookupOutcome> {
  const articleNumber = (args.article_number ?? "").trim();
  const doi = (args.doi ?? "").trim();
  if (articleNumber.length === 0 && doi.length === 0) {
    throw new InputError(
      "Provide either article_number or doi.",
      "Example: { \"doi\": \"10.1109/ACCESS.2023.1234567\" }"
    );
  }
  const searchArgs: SearchArgs = { max_records: 1 };
  if (articleNumber.length > 0) searchArgs.article_number = articleNumber;
  else searchArgs.doi = doi;

  return executeSearch(context, searchArgs, via);
}
