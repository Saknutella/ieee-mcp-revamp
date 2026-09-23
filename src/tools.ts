/**
 * MCP tool registration.
 *
 * Scope statement repeated for every search-facing tool: IEEE's Metadata Search
 * API searches configured metadata fields and the abstract text. It is not a
 * full-text search of article bodies, and it does not retrieve PDFs.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { IeeeMcpError, InputError, toIeeeMcpError } from "./errors.js";
import { log } from "./logger.js";
import { processCounters, getUsageSnapshot, resetLocalUsage } from "./budget.js";
import { describeConfig, SERVER_NAME, SERVER_VERSION, type Config } from "./config.js";
import { getLastRateLimitHeaders } from "./ieeeClient.js";
import type { IeeeClient } from "./ieeeClient.js";
import type { DiskCache } from "./cache.js";
import { normalizeArticles } from "./normalize.js";
import { isValidSearchId, type ResultStore } from "./resultStore.js";
import { defaultExportName, exportRecords, type ExportFormat } from "./exporter.js";
import { payloadToMarkdown, toBibtex, toCsv, toJsonText, type OutputFormat } from "./format.js";
import {
  CONTENT_TYPES,
  MAX_RECORDS_PER_REQUEST,
  PUBLISHERS,
  SORT_FIELDS,
  SORT_ORDERS,
  type ContentType,
  type SortField,
  type SortOrder,
} from "./ieeeSpec.js";
import { executeIdentifierLookup, executeSearch, type SearchContext } from "./searchService.js";
import type { CrossrefClient } from "./crossref.js";
import {
  attachIeeeVerifyLinks,
  lookupReferences,
  resolveDoiList,
  type BibtexMode,
} from "./references.js";
import { referencesToBibtex, referencesToMarkdown } from "./format.js";
import type { PaperRecord, SearchResultPayload } from "./types.js";

const CONTENT_TYPE_ENUM = z.enum([...CONTENT_TYPES] as [ContentType, ...ContentType[]]);
const SORT_FIELD_ENUM = z.enum([...SORT_FIELDS] as [SortField, ...SortField[]]);
const SORT_ORDER_ENUM = z.enum([...SORT_ORDERS] as [SortOrder, ...SortOrder[]]);
const PUBLISHER_ENUM = z.enum([...PUBLISHERS] as [string, ...string[]]);
const OUTPUT_FORMAT_ENUM = z.enum(["json", "markdown", "csv", "bibtex"]);
const EXPORT_FORMAT_ENUM = z.enum(["csv", "json", "bibtex"]);

const SCOPE_NOTE =
  "SCOPE: the IEEE Xplore Metadata Search API free-text parameters (querytext/meta_data) search " +
  "configured metadata fields and the abstract. This is NOT a full-text search of article bodies, " +
  "and this server cannot download PDFs or full text.";

const FILTER_DESCRIPTIONS = {
  querytext:
    "Free-text query over configured metadata fields and abstract text. Supports Boolean operators " +
    "(AND, OR, NOT) and wildcards (*) with at least 3 characters before each wildcard (max two wildcard words).",
  queries:
    "Optional list of querytext variants (e.g. synonyms or sub-topics). Each variant is executed as its own " +
    "API request, then all results are merged and de-duplicated by DOI / article_number / title+year. " +
    "Subject to max_requests.",
  author: "Author name. IEEE requires >=3 characters before a wildcard (*).",
  publication_title: "Journal, conference or standard title.",
  content_type: "IEEE content type. Case-sensitive per IEEE documentation.",
  open_access: "When true, restrict to open access content.",
  start_year: "Start of the publication-year range (inclusive).",
  end_year: "End of the publication-year range (inclusive).",
};

export interface ToolDependencies {
  config: Config;
  client: IeeeClient;
  cache: DiskCache;
  results: ResultStore;
  searchContext: SearchContext;
  crossref: CrossrefClient;
}

function renderPayload(payload: SearchResultPayload, format: OutputFormat): string {
  switch (format) {
    case "markdown":
      return payloadToMarkdown(payload);
    case "csv":
      return toCsv(payload.articles, payload.retrieved_at, payload.search_id);
    case "bibtex":
      return toBibtex(payload.articles, {
        queryId: payload.search_id,
        retrievedAt: payload.retrieved_at,
        endpoint: "https://ieeexploreapi.ieee.org/api/v1/search/articles",
        query: payload.query,
      });
    case "json":
    default:
      return toJsonText(payload);
  }
}

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function ok(payload: SearchResultPayload, format: OutputFormat): ToolResult {
  const result: ToolResult = { content: [{ type: "text", text: renderPayload(payload, format) }] };
  if (format === "json") {
    result.structuredContent = payload as unknown as Record<string, unknown>;
  }
  return result;
}

function fail(error: unknown): ToolResult {
  const normalized = error instanceof IeeeMcpError ? error : toIeeeMcpError(error);
  log.warn(`Tool error ${normalized.code}: ${normalized.message}`);
  return {
    content: [{ type: "text", text: toJsonText(normalized.toJSON()) }],
    isError: true,
  };
}

export function registerTools(server: McpServer, deps: ToolDependencies): void {
  const { config, cache, results, searchContext, crossref } = deps;

  // ── search_papers ────────────────────────────────────────────────────────────
  server.registerTool(
    "search_papers",
    {
      title: "Search IEEE Xplore (metadata + abstract)",
      description:
        "Search IEEE Xplore and return structured candidate papers for relevance screening. " +
        "Returns title, authors, year, publication, abstract, author/IEEE/MeSH keywords, DOI, " +
        "article_number, abstract_url, HTML and PDF links, plus explicit `missing_fields` so absent " +
        "metadata is never invented. Results are cacheable and de-duplicated. " +
        SCOPE_NOTE,
      inputSchema: {
        querytext: z.string().optional().describe(FILTER_DESCRIPTIONS.querytext),
        queries: z.array(z.string()).max(10).optional().describe(FILTER_DESCRIPTIONS.queries),
        meta_data: z
          .string()
          .optional()
          .describe(
            "Free-text search over all configured metadata fields plus the abstract, using explicit " +
              "field names and Boolean operators (e.g. \"Document Title:radar AND Author Terms:beamforming\")."
          ),
        article_title: z.string().optional().describe("Match against the document title."),
        abstract: z.string().optional().describe("Match against the abstract text."),
        author: z.string().optional().describe(FILTER_DESCRIPTIONS.author),
        affiliation: z
          .string()
          .optional()
          .describe("Author affiliation/organisation, minimum 3 characters."),
        index_terms: z
          .string()
          .optional()
          .describe("Combined search over author keywords, IEEE terms and MeSH terms."),
        thesaurus_terms: z.string().optional().describe("IEEE controlled vocabulary (IEEE Terms)."),
        doi: z
          .string()
          .optional()
          .describe("Look up a single DOI. IEEE ignores all other search parameters when doi is supplied."),
        article_number: z
          .string()
          .optional()
          .describe("Look up a single IEEE article number. IEEE ignores all other search parameters."),
        publication_title: z.string().optional().describe(FILTER_DESCRIPTIONS.publication_title),
        publication_number: z.string().optional().describe("IEEE publication identifier."),
        publication_year: z.string().optional().describe("Exact publication year, e.g. \"2023\"."),
        start_year: z.string().optional().describe(FILTER_DESCRIPTIONS.start_year),
        end_year: z.string().optional().describe(FILTER_DESCRIPTIONS.end_year),
        start_date: z.string().optional().describe("Insertion date lower bound, format YYYYMMDD."),
        end_date: z.string().optional().describe("Insertion date upper bound, format YYYYMMDD."),
        content_type: CONTENT_TYPE_ENUM.optional().describe(FILTER_DESCRIPTIONS.content_type),
        open_access: z.boolean().optional().describe(FILTER_DESCRIPTIONS.open_access),
        isbn: z.string().optional().describe("ISBN of a book or non-serial."),
        issn: z.string().optional().describe("ISSN of a journal or serial."),
        is_number: z.string().optional().describe("Issue number (journals only)."),
        publisher: PUBLISHER_ENUM.optional().describe("Publisher, from IEEE's documented list."),
        max_records: z
          .number()
          .int()
          .min(1)
          .max(MAX_RECORDS_PER_REQUEST)
          .optional()
          .describe(`Records per API request (IEEE default 25, maximum ${MAX_RECORDS_PER_REQUEST}).`),
        start_record: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("1-based sequence number of the first record to fetch (pagination)."),
        auto_paginate: z
          .boolean()
          .optional()
          .describe(
            "When true, keep requesting pages until max_total_records or max_requests is reached, " +
              "or IEEE runs out of results."
          ),
        max_total_records: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe("Upper bound on unique records returned in this call (default 200)."),
        max_requests: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe("Hard cap on HTTP requests this call may spend, retries included (default 5)."),
        sort_field: SORT_FIELD_ENUM.optional().describe(
          "Sort field. IEEE documents exactly these three values."
        ),
        sort_order: SORT_ORDER_ENUM.optional().describe("asc or desc."),
        output_format: OUTPUT_FORMAT_ENUM.optional().describe(
          "Rendering of the text block. `json` (default) also fills structuredContent."
        ),
        no_cache: z
          .boolean()
          .optional()
          .describe("Bypass the on-disk cache read for this call (fresh results are still cached)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const { payload } = await executeSearch(searchContext, args, "search_papers");
        return ok(payload, (args.output_format ?? "json") as OutputFormat);
      } catch (error) {
        return fail(error);
      }
    }
  );

  // ── get_paper_details ────────────────────────────────────────────────────────
  server.registerTool(
    "get_paper_details",
    {
      title: "Get IEEE paper metadata by DOI or article number",
      description:
        "Fetch the complete metadata record for one IEEE document by DOI or article_number. " +
        "Returns author affiliations, abstract, author/IEEE/MeSH keywords, citation counts, " +
        "abstract_url, HTML and PDF links. " +
        SCOPE_NOTE,
      inputSchema: {
        article_number: z
          .string()
          .optional()
          .describe("IEEE article number. Takes precedence over doi if both are supplied."),
        doi: z.string().optional().describe("Document DOI, e.g. 10.1109/ACCESS.2023.1234567."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const { payload } = await executeIdentifierLookup(searchContext, args, "get_paper_details");
        return ok(payload, "json");
      } catch (error) {
        return fail(error);
      }
    }
  );

  // ── get_paper_citations ──────────────────────────────────────────────────────
  server.registerTool(
    "get_paper_citations",
    {
      title: "Get citation counts for one IEEE paper",
      description:
        "Return the citing-paper and citing-patent counts IEEE reports for one document " +
        "identified by DOI or article_number. Citation counts are metadata-only and may lag.",
      inputSchema: {
        article_number: z.string().optional().describe("IEEE article number."),
        doi: z.string().optional().describe("Document DOI."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const { payload } = await executeIdentifierLookup(searchContext, args, "get_paper_citations");
        const record = payload.articles[0];
        const summary = {
          search_id: payload.search_id,
          source: payload.source,
          query: payload.query,
          found: payload.articles.length > 0,
          article_number: record?.article_number ?? null,
          doi: record?.doi ?? null,
          title: record?.title ?? null,
          citing_paper_count: record?.citing_paper_count ?? null,
          citing_patent_count: record?.citing_patent_count ?? null,
          note:
            payload.articles.length === 0
              ? "IEEE returned no metadata record for this identifier."
              : "Counts come from IEEE metadata and are not real-time.",
          usage: payload.usage,
        };
        return {
          content: [{ type: "text", text: toJsonText(summary) }],
          structuredContent: summary as unknown as Record<string, unknown>,
        };
      } catch (error) {
        return fail(error);
      }
    }
  );

  // ── search_by_author ─────────────────────────────────────────────────────────
  server.registerTool(
    "search_by_author",
    {
      title: "Search IEEE Xplore by author",
      description:
        "Convenience wrapper around search_papers with the author filter pre-filled. " +
        "Returns the same structured, de-duplicated metadata records. " +
        SCOPE_NOTE,
      inputSchema: {
        author: z.string().describe(FILTER_DESCRIPTIONS.author),
        start_year: z.string().optional().describe(FILTER_DESCRIPTIONS.start_year),
        end_year: z.string().optional().describe(FILTER_DESCRIPTIONS.end_year),
        content_type: CONTENT_TYPE_ENUM.optional().describe(FILTER_DESCRIPTIONS.content_type),
        publication_title: z.string().optional().describe(FILTER_DESCRIPTIONS.publication_title),
        max_records: z.number().int().min(1).max(MAX_RECORDS_PER_REQUEST).optional(),
        start_record: z.number().int().min(1).optional(),
        auto_paginate: z.boolean().optional(),
        max_total_records: z.number().int().min(1).max(1000).optional(),
        max_requests: z.number().int().min(1).max(20).optional(),
        sort_field: SORT_FIELD_ENUM.optional(),
        sort_order: SORT_ORDER_ENUM.optional(),
        output_format: OUTPUT_FORMAT_ENUM.optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const { payload } = await executeSearch(
          searchContext,
          { ...args, author: args.author } as Parameters<typeof executeSearch>[1],
          "search_by_author"
        );
        return ok(payload, (args.output_format ?? "json") as OutputFormat);
      } catch (error) {
        return fail(error);
      }
    }
  );

  // ── search_by_publication ────────────────────────────────────────────────────
  server.registerTool(
    "search_by_publication",
    {
      title: "Search inside one IEEE journal or conference",
      description:
        "Convenience wrapper around search_papers with publication_title pre-filled, optionally " +
        "narrowed by a querytext and a year range. " +
        SCOPE_NOTE,
      inputSchema: {
        publication_title: z.string().describe(FILTER_DESCRIPTIONS.publication_title),
        querytext: z.string().optional().describe(FILTER_DESCRIPTIONS.querytext),
        start_year: z.string().optional().describe(FILTER_DESCRIPTIONS.start_year),
        end_year: z.string().optional().describe(FILTER_DESCRIPTIONS.end_year),
        content_type: CONTENT_TYPE_ENUM.optional().describe(FILTER_DESCRIPTIONS.content_type),
        max_records: z.number().int().min(1).max(MAX_RECORDS_PER_REQUEST).optional(),
        start_record: z.number().int().min(1).optional(),
        auto_paginate: z.boolean().optional(),
        max_total_records: z.number().int().min(1).max(1000).optional(),
        max_requests: z.number().int().min(1).max(20).optional(),
        sort_field: SORT_FIELD_ENUM.optional(),
        sort_order: SORT_ORDER_ENUM.optional(),
        output_format: OUTPUT_FORMAT_ENUM.optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const { payload } = await executeSearch(
          searchContext,
          args as Parameters<typeof executeSearch>[1],
          "search_by_publication"
        );
        return ok(payload, (args.output_format ?? "json") as OutputFormat);
      } catch (error) {
        return fail(error);
      }
    }
  );

  // ── export_results ───────────────────────────────────────────────────────────
  server.registerTool(
    "export_results",
    {
      title: "Export search results to CSV / JSON / BibTeX",
      description:
        "Write a set of IEEE metadata records to a UTF-8 file and return its path, size and SHA-256. " +
        "Every export also writes a `.meta.json` sidecar recording the source database, the exact search " +
        "conditions, the retrieval timestamp and the IEEE endpoint. Use `search_id` from a previous " +
        "search, or pass raw IEEE records explicitly. CSV is written as UTF-8 with BOM for Excel.",
      inputSchema: {
        search_id: z
          .string()
          .optional()
          .describe("search_id returned by search_papers / search_by_author / search_by_publication."),
        records: z
          .array(z.record(z.string(), z.any()))
          .optional()
          .describe("Explicit list of raw IEEE metadata records to export (used when search_id is absent)."),
        format: EXPORT_FORMAT_ENUM.describe("csv, json or bibtex."),
        output_path: z
          .string()
          .optional()
          .describe(
            "Target file path. Absolute, or relative to IEEE_OUTPUT_DIR / the working directory. " +
              "A missing extension is filled in for the chosen format."
          ),
        retrieved_at: z
          .string()
          .optional()
          .describe("Override the retrieval timestamp recorded in the export provenance."),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        let records: PaperRecord[] = [];
        let searchId = args.search_id ?? "srch_manual";
        let query: Record<string, unknown> = {};
        let totalRecords: number | null = null;
        let retrievedAt = args.retrieved_at ?? new Date().toISOString();
        let endpoint = config.apiBase;
        let warnings: string[] = [];

        if (args.search_id) {
          if (!isValidSearchId(args.search_id)) {
            throw new InputError(
              `Malformed search_id "${args.search_id}".`,
              "Use the search_id returned by a search tool, e.g. srch_abc123."
            );
          }
          const stored = results.load(args.search_id);
          if (!stored) {
            throw new InputError(
              `No stored result set for search_id "${args.search_id}".`,
              `Result sets expire after ${config.resultTtlSeconds}s and only the ${20} most recent are kept. ` +
                "Run the search again, or pass `records` explicitly."
            );
          }
          records = stored.articles;
          searchId = stored.search_id;
          query = stored.query;
          totalRecords = stored.total_records;
          retrievedAt = stored.retrieved_at;
          warnings = stored.warnings;
        } else if (args.records && args.records.length > 0) {
          records = normalizeArticles(args.records, "export_results");
          if (records.length === 0) {
            throw new InputError(
              "None of the supplied records could be interpreted as IEEE metadata.",
              "Pass the raw IEEE article objects (as returned in `articles` by the search tools)."
            );
          }
        } else {
          throw new InputError(
            "Provide either search_id or records.",
            "search_id comes from a previous search; records lets you export raw IEEE metadata directly."
          );
        }

        if (args.output_path === undefined) {
          log.debug("No output_path supplied; using a generated filename in IEEE_OUTPUT_DIR.");
        }
        const outcome = exportRecords(config, {
          format: args.format as ExportFormat,
          outputPath: args.output_path ?? defaultExportName(args.format as ExportFormat, searchId),
          records,
          meta: {
            searchId,
            source: "IEEE Xplore",
            endpoint,
            retrievedAt,
            query,
            totalRecords,
            searchScope: "metadata_and_abstract",
            server: `${SERVER_NAME} ${SERVER_VERSION}`,
            warnings,
          },
        });

        return {
          content: [{ type: "text", text: toJsonText({ ok: true, ...outcome, search_id: searchId }) }],
          structuredContent: { ok: true, ...outcome, search_id: searchId } as unknown as Record<string, unknown>,
        };
      } catch (error) {
        return fail(error);
      }
    }
  );

  // ── get_references ───────────────────────────────────────────────────────────
  server.registerTool(
    "get_references",
    {
      title: "Get reference lists (source: Crossref, NOT IEEE)",
      description:
        "Return the OUTGOING reference list (bibliography) of one or more papers, with counts and " +
        "optional BibTeX. " +
        "DATA SOURCE IS CROSSREF, NOT IEEE: the IEEE Xplore Metadata Search API exposes no reference " +
        "list at all (citing_paper_count / citing_patent_count are INCOMING citation counts). Crossref " +
        "reference metadata is deposited by the publisher and keeps the publisher's citation keys " +
        "(ref1, ref2, ...), which preserve in-paper numbering. " +
        "VERIFICATION REQUIRED: Crossref matched IEEE Xplore exactly on the sampled papers (2 papers, " +
        "21 references, position by position), but that is a small sample - always compare the result " +
        "against the References section of the paper page on IEEE Xplore before relying on it. " +
        "Each entry reports whether a DOI was deposited; entries without a DOI cannot be resolved " +
        "automatically. These lookups are free and do NOT consume the IEEE daily budget.",
      inputSchema: {
        dois: z
          .array(z.string())
          .max(100)
          .optional()
          .describe("One or more DOIs. Non-IEEE DOIs work too; Crossref is not limited to IEEE content."),
        search_id: z
          .string()
          .optional()
          .describe(
            "Take the DOIs from a stored IEEE search result instead of listing them by hand. " +
              "Records without a DOI are reported as skipped, because Crossref needs a DOI."
          ),
        article_numbers: z
          .array(z.string())
          .optional()
          .describe("With search_id: restrict the lookup to these IEEE article numbers."),
        bibtex_mode: z
          .enum(["none", "generated", "crossref"])
          .optional()
          .describe(
            "`generated` (default) builds BibTeX from the deposited fields with no extra requests. " +
              "`crossref` fetches authoritative BibTeX per DOI-bearing reference (one request each, " +
              "capped by IEEE_MCP_MAX_BIBTEX_PER_CALL). `none` omits BibTeX."
          ),
        output_format: z
          .enum(["json", "markdown", "bibtex"])
          .optional()
          .describe("json (default, also fills structuredContent) | markdown | bibtex."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        let records: PaperRecord[] | undefined;
        if (args.search_id) {
          if (!isValidSearchId(args.search_id)) {
            throw new InputError(
              `Malformed search_id "${args.search_id}".`,
              "Use the search_id returned by a search tool, e.g. srch_abc123."
            );
          }
          const stored = results.load(args.search_id);
          if (!stored) {
            throw new InputError(
              `No stored result set for search_id "${args.search_id}".`,
              "Result sets expire and only the most recent are kept. Run the search again, or pass `dois`."
            );
          }
          records = stored.articles;
        }
        if (!args.dois?.length && !records) {
          throw new InputError(
            "Provide either `dois` or `search_id`.",
            "Crossref is keyed by DOI, so a DOI (or an IEEE result set containing DOIs) is required."
          );
        }

        const resolved = resolveDoiList({
          dois: args.dois,
          records,
          articleNumbers: args.article_numbers,
          maxDois: config.maxDoisPerCall,
        });
        const bibtexMode: BibtexMode = (args.bibtex_mode ?? "generated") as BibtexMode;
        const payload = await lookupReferences(
          { config, crossref },
          { ...resolved, bibtexMode }
        );
        if (records) attachIeeeVerifyLinks(payload, records);

        const format = args.output_format ?? "json";
        const text =
          format === "markdown"
            ? referencesToMarkdown(payload)
            : format === "bibtex"
              ? referencesToBibtex(payload)
              : toJsonText(payload);

        const result: ToolResult = { content: [{ type: "text", text }] };
        if (format === "json") {
          result.structuredContent = payload as unknown as Record<string, unknown>;
        }
        return result;
      } catch (error) {
        return fail(error);
      }
    }
  );

  // ── ieee_status ──────────────────────────────────────────────────────────────
  server.registerTool(
    "ieee_status",
    {
      title: "Show configuration, local IEEE usage and cache state",
      description:
        "Report the effective configuration (with a hashed key fingerprint and no key material), " +
        "this server's LOCAL IEEE call counting, cache statistics, Crossref status, and any rate-limit " +
        "headers IEEE returned. The local counter is not the official IEEE remaining quota. " +
        "Optionally clear the cache or reset the local counter.",
      inputSchema: {
        include_config: z.boolean().optional().describe("Include the configuration block (default true)."),
        clear_cache: z.boolean().optional().describe("Delete every cached API response."),
        reset_local_usage: z
          .boolean()
          .optional()
          .describe(
            "Delete the local call ledger. Only affects this server's local bookkeeping, never IEEE's own counter."
          ),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        let cleared: number | null = null;
        if (args.clear_cache === true) cleared = cache.clear();
        if (args.reset_local_usage === true) {
          resetLocalUsage(config);
          log.warn("Local usage ledger was reset on request.");
        }

        const usage = getUsageSnapshot(config);
        const summary = {
          ok: true,
          server: `${SERVER_NAME} ${SERVER_VERSION}`,
          config: args.include_config === false ? undefined : describeConfig(config),
          config_warnings: config.warnings,
          local_usage: {
            local_calls_utc_day: usage.localCallsUtcDay,
            local_calls_local_day: usage.localCallsLocalDay,
            local_calls_rolling_24h: usage.localCallsRolling24h,
            total_calls_recorded: usage.totalCalls,
            utc_day: usage.utcDay,
            local_day: usage.localDay,
            first_call_at: usage.firstCallAt,
            last_call_at: usage.lastCallAt,
            ledger_file: usage.ledgerFile,
            daily_budget: config.dailyBudget,
            budget_window: config.budgetWindow,
            remaining_local_budget: Math.max(0, config.dailyBudget - usage.localCallsUtcDay),
            disclaimer:
              "LOCAL bookkeeping only - NOT the official IEEE remaining quota. IEEE does not publish " +
              "the reset time zone of its Rate Limits, so UTC-day, local-day and rolling-24h windows are " +
              "all tracked and the configured budget is enforced against them.",
          },
          process: {
            pid: process.pid,
            http_attempts: processCounters.httpAttempts,
            retries: processCounters.retries,
            cache_hits: processCounters.cacheHits,
            cache_misses: processCounters.cacheMisses,
            uptime_seconds: Math.round((Date.now() - processCounters.startedAt) / 1000),
          },
          cache: {
            ...cache.stats(),
            ttl_seconds: config.cacheTtlSeconds,
            max_entries: config.cacheMaxEntries,
            directory: config.cacheDir,
            cleared_entries: cleared,
          },
          result_sets: { ...results.stats(), ttl_seconds: config.resultTtlSeconds },
          last_ieee_rate_limit_headers: getLastRateLimitHeaders(),
          crossref: {
            enabled: config.crossrefEnabled,
            api_base: config.crossrefApiBase,
            api_base_overridden: !config.crossrefIsDefaultBase,
            polite_pool: Boolean(config.crossrefMailto),
            max_rps: config.crossrefMaxRps,
            requests_this_process: crossref.stats.requests,
            cache_hits_this_process: crossref.stats.cacheHits,
            max_dois_per_call: config.maxDoisPerCall,
            max_bibtex_fetches_per_call: config.maxBibtexFetchesPerCall,
            role:
              "Second data source used ONLY for reference lists (get_references). Crossref requests do NOT " +
              "consume the IEEE daily budget and are not written to the IEEE usage ledger.",
          },
        };
        return {
          content: [{ type: "text", text: toJsonText(summary) }],
          structuredContent: summary as unknown as Record<string, unknown>,
        };
      } catch (error) {
        return fail(error);
      }
    }
  );
}
