/**
 * IEEE Xplore Metadata Search API - wire types and normalized record types.
 *
 * Wire types mirror the fields documented at
 * https://developer.ieee.org/docs/read/Metadata_API_responses
 * ("Only populated fields will be returned so content may differ by publication"),
 * therefore every field is optional and every value is treated as untrusted.
 */

// ── Wire types (what the API actually sends) ───────────────────────────────────

export interface IEEEAuthor {
  authorUrl?: string;
  id?: number | string;
  full_name?: string;
  /** Some response variants use `name` instead of `full_name`. */
  name?: string;
  affiliation?: string;
  author_order?: number | string;
}

export interface IEEETermList {
  terms?: string[];
}

/**
 * `index_terms` is a combined field that returns author keywords, IEEE terms and
 * (when present) MeSH terms, each wrapped in a `{ terms: [...] }` object.
 */
export interface IEEEIndexTerms {
  author_terms?: IEEETermList;
  ieee_terms?: IEEETermList;
  mesh_terms?: IEEETermList;
  [category: string]: IEEETermList | undefined;
}

export interface IEEEArticle {
  article_number?: string | number;
  doi?: string;
  title?: string;
  abstract?: string;
  abstract_url?: string;
  html_url?: string;
  pdf_url?: string;
  publication_title?: string;
  publication_year?: string | number;
  publication_date?: string;
  content_type?: string;
  start_page?: string | number;
  end_page?: string | number;
  /** Present in some responses instead of start/end page. */
  page_range?: string;
  volume?: string | number;
  issue?: string | number;
  is_number?: string | number;
  publication_number?: string | number;
  standard_number?: string;
  standard_status?: string;
  citing_paper_count?: number | string;
  citing_patent_count?: number | string;
  is_open_access?: boolean;
  accessType?: string;
  authors?: { authors?: IEEEAuthor[] } | IEEEAuthor[];
  index_terms?: IEEEIndexTerms;
  /** Some responses surface the term groups at the top level. */
  author_terms?: IEEETermList | string[];
  ieee_terms?: IEEETermList | string[];
  mesh_terms?: IEEETermList | string[];
  isbn?: string;
  issn?: string;
  publisher?: string;
  conference_location?: string;
  conference_dates?: string;
  insert_date?: string;
  rank?: number | string;
  /** NOT documented for the Metadata API; kept only so it can be detected/ignored. */
  full_text?: string;
}

export interface IEEESearchResponse {
  /**
   * Documented response field. `totalfound` is the documented spelling on the
   * "Data Fields Returned" page (XML/facet naming); live JSON responses use
   * `total_records`. Both are accepted, `total_records` wins.
   */
  total_records?: number | string;
  total_searched?: number | string;
  totalfound?: number | string;
  totalsearched?: number | string;
  articles?: IEEEArticle[];
  /** Mashery-style error envelope. */
  message?: string;
  error?: string;
}

// ── Normalized record (what this MCP returns) ──────────────────────────────────

export interface PaperAuthor {
  name: string;
  affiliation: string | null;
  order: number | null;
}

export interface PaperKeywords {
  /** Author supplied keywords (`author_terms`). */
  author_terms: string[];
  /** IEEE controlled vocabulary (`ieee_terms` / thesaurus terms). */
  ieee_terms: string[];
  /** MeSH terms, when the publication carries them. */
  mesh_terms: string[];
  /** Any other term bucket the API returned, kept verbatim. */
  other: Record<string, string[]>;
}

/**
 * Every field is `null` when IEEE did not return it. Values are never invented,
 * guessed, or back-filled. `missing_fields` lists the absent non-optional fields.
 */
export interface PaperRecord {
  article_number: string | null;
  doi: string | null;
  doi_url: string | null;
  title: string | null;
  authors: PaperAuthor[];
  author_names: string | null;
  year: string | null;
  publication_date: string | null;
  publication_title: string | null;
  content_type: string | null;
  abstract: string | null;
  keywords: PaperKeywords;
  abstract_url: string | null;
  html_url: string | null;
  pdf_url: string | null;
  is_open_access: boolean | null;
  access_type: string | null;
  start_page: string | null;
  end_page: string | null;
  pages: string | null;
  volume: string | null;
  issue: string | null;
  publisher: string | null;
  isbn: string | null;
  issn: string | null;
  conference_location: string | null;
  conference_dates: string | null;
  standard_number: string | null;
  citing_paper_count: number | null;
  citing_patent_count: number | null;
  insert_date: string | null;
  /** Constant, always "IEEE Xplore" - provenance for downstream filtering. */
  source: string;
  /** Which lookup produced this record, for auditability. */
  retrieved_via: string;
  /** Non-optional fields the API did not return. Empty array means complete. */
  missing_fields: string[];
}

export interface SearchProvenance {
  /** ISO-8601 UTC timestamp of retrieval (or of the cached retrieval). */
  retrieved_at: string;
  /** True when this payload came from the on-disk cache. */
  from_cache: boolean;
  /** The IEEE endpoint that produced the payload. */
  endpoint: string;
  /** Effective API parameters (never contains `apikey`). */
  api_params: Record<string, string>;
}

export interface PaginationInfo {
  /** "single" for one query, "merged" when several query variants were unioned. */
  mode: "single" | "merged";
  start_record: number;
  max_records: number;
  /** Absolute 1-based index of the last record returned by this call. */
  last_returned_index: number;
  total_records: number | null;
  has_more: boolean;
  next_start_record: number | null;
  pages_fetched: number;
  /** True when pagination stopped because a configured limit was reached. */
  truncated_by_limit: boolean;
  /** Why pagination stopped, when it stopped early. */
  stop_reason: string | null;
}

export interface PerQueryInfo {
  query: string;
  api_params: Record<string, string>;
  total_records: number | null;
  returned: number;
  requests: number;
  pages: number;
  cache_hit: boolean;
  has_more: boolean;
  next_start_record: number | null;
  stop_reason: string | null;
}

export interface UsageInfo {
  /** Every HTTP attempt made by this process, including retries. */
  process_http_attempts: number;
  /** Cached lookups served without touching the IEEE API. */
  process_cache_hits: number;
  /** Local bookkeeping only. Not the official IEEE remaining quota. */
  local_calls_utc_day: number;
  local_calls_local_day: number;
  local_calls_rolling_24h: number;
  daily_budget: number;
  budget_window: string;
  remaining_local_budget: number;
  note: string;
}

export interface DedupInfo {
  duplicates_removed: number;
  /** Dedup keys that actually removed something. */
  matched_on: string[];
  keys: string[];
}

export interface SearchResultPayload {
  search_id: string;
  source: string;
  /** Always "metadata" - this API searches metadata and abstracts, not full text. */
  search_scope: string;
  /** ISO-8601 UTC timestamp of the most recent retrieval backing this payload. */
  retrieved_at: string;
  query: Record<string, unknown>;
  total_records: number | null;
  returned_records: number;
  pagination: PaginationInfo;
  usage: UsageInfo;
  cache: { hit: boolean; ttl_seconds: number; cache_enabled: boolean };
  dedup: DedupInfo;
  /** Non-fatal notes: ignored parameters, clamp warnings, API quirks. */
  warnings: string[];
  queries_executed: string[];
  /** Per-query detail; always populated, one entry per executed query. */
  per_query: PerQueryInfo[];
  articles: PaperRecord[];
}
