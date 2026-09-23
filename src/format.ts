/**
 * Rendering: structured payload -> JSON / Markdown / CSV / BibTeX.
 *
 * Missing values are rendered as an explicit empty cell / omitted BibTeX field,
 * never as a placeholder that could be mistaken for real metadata.
 */

import type { PaperRecord, SearchResultPayload, UsageInfo } from "./types.js";

export type OutputFormat = "json" | "markdown" | "csv" | "bibtex";

export const CSV_BOM = "\uFEFF";

export const CSV_COLUMNS = [
  "article_number",
  "doi",
  "title",
  "authors",
  "year",
  "publication_date",
  "publication_title",
  "content_type",
  "volume",
  "issue",
  "pages",
  "publisher",
  "isbn",
  "issn",
  "conference_location",
  "conference_dates",
  "abstract",
  "author_terms",
  "ieee_terms",
  "mesh_terms",
  "is_open_access",
  "access_type",
  "abstract_url",
  "html_url",
  "pdf_url",
  "citing_paper_count",
  "citing_patent_count",
  "standard_number",
  "missing_fields",
  "source",
  "retrieved_at",
  "query_id",
] as const;

export function toJsonText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = Array.isArray(value) ? value.join("; ") : String(value);
  if (/["\r\n,]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function toCsv(records: PaperRecord[], retrievedAt: string, queryId: string): string {
  const header = CSV_COLUMNS.join(",");
  const lines = [header];
  for (const record of records) {
    const row: Record<string, unknown> = {
      article_number: record.article_number,
      doi: record.doi,
      title: record.title,
      authors: record.author_names,
      year: record.year,
      publication_date: record.publication_date,
      publication_title: record.publication_title,
      content_type: record.content_type,
      volume: record.volume,
      issue: record.issue,
      pages: record.pages,
      publisher: record.publisher,
      isbn: record.isbn,
      issn: record.issn,
      conference_location: record.conference_location,
      conference_dates: record.conference_dates,
      abstract: record.abstract,
      author_terms: record.keywords.author_terms,
      ieee_terms: record.keywords.ieee_terms,
      mesh_terms: record.keywords.mesh_terms,
      is_open_access: record.is_open_access,
      access_type: record.access_type,
      abstract_url: record.abstract_url,
      html_url: record.html_url,
      pdf_url: record.pdf_url,
      citing_paper_count: record.citing_paper_count,
      citing_patent_count: record.citing_patent_count,
      standard_number: record.standard_number,
      missing_fields: record.missing_fields,
      source: record.source,
      retrieved_at: retrievedAt,
      query_id: queryId,
    };
    lines.push(CSV_COLUMNS.map((column) => csvCell(row[column])).join(","));
  }
  return `${CSV_BOM}${lines.join("\r\n")}\r\n`;
}

function bibtexEntryType(record: PaperRecord): string {
  const contentType = (record.content_type ?? "").toLowerCase();
  if (contentType.includes("conference")) return "inproceedings";
  if (contentType.includes("journal") || contentType.includes("magazine")) return "article";
  if (contentType.includes("early access")) return "article";
  if (contentType.includes("book")) return "book";
  return "misc";
}

function lastName(name: string): string {
  const cleaned = name.trim();
  if (cleaned.includes(",")) return cleaned.split(",")[0]?.trim() ?? cleaned;
  const parts = cleaned.split(/\s+/);
  return parts[parts.length - 1] ?? cleaned;
}

function asciiFold(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9]/g, "");
}

export function makeCitationKey(record: PaperRecord, used: Set<string>): string {
  const firstAuthor = record.authors[0]?.name;
  const stem = asciiFold(firstAuthor ? lastName(firstAuthor) : "ieee") || "ieee";
  const year = asciiFold(record.year ?? "") || "n.d.";
  const tail = asciiFold(record.article_number ?? record.doi?.replace(/[^A-Za-z0-9]/g, "") ?? "") || "";
  let base = `${stem}${year}${tail}`;
  if (base.length > 60) base = base.slice(0, 60);
  let candidate = base;
  let suffix = 0;
  while (used.has(candidate.toLowerCase())) {
    suffix += 1;
    candidate = `${base}${String.fromCharCode(96 + Math.min(suffix, 26))}${suffix > 26 ? suffix : ""}`;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

function bibtexField(name: string, value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (text.length === 0) return null;
  const escaped = text.replace(/\\/g, "\\textbackslash{}").replace(/([{}])/g, "\\$1");
  return `  ${name} = {${escaped}}`;
}

export function toBibtex(
  records: PaperRecord[],
  meta: { queryId: string; retrievedAt: string; endpoint: string; query: Record<string, unknown> }
): string {
  const used = new Set<string>();
  const blocks: string[] = [];
  blocks.push(
    [
      "% Generated by ieee-mcp (IEEE Xplore Metadata Search API)",
      "% NOTE: metadata search result, not a full-text retrieval.",
      `% search_id: ${meta.queryId}`,
      `% retrieved_at: ${meta.retrievedAt}`,
      `% source: ${meta.endpoint}`,
      `% query: ${JSON.stringify(meta.query)}`,
      `% records: ${records.length}`,
      "% Encoding: UTF-8. Use a UTF-8 aware BibTeX/biblatex setup.",
    ].join("\n")
  );

  for (const record of records) {
    const key = makeCitationKey(record, used);
    const type = bibtexEntryType(record);
    const authors = record.authors.length > 0 ? record.authors.map((author) => author.name).join(" and ") : null;

    const fields: Array<string | null> = [
      bibtexField("author", authors),
      bibtexField("title", record.title),
      type === "inproceedings" ? bibtexField("booktitle", record.publication_title) : null,
      type !== "inproceedings" ? bibtexField("journal", record.publication_title) : null,
      bibtexField("year", record.year),
      bibtexField("volume", record.volume),
      bibtexField("number", record.issue),
      bibtexField("pages", record.pages),
      bibtexField("publisher", record.publisher),
      bibtexField("doi", record.doi),
      bibtexField(
        "url",
        record.html_url ?? record.abstract_url ?? (record.doi ? `https://doi.org/${record.doi}` : null)
      ),
      bibtexField("isbn", record.isbn),
      bibtexField("issn", record.issn),
      bibtexField("note", record.content_type ? `IEEE Xplore content type: ${record.content_type}` : null),
    ].filter((value): value is string => value !== null);

    const body = fields.length > 0 ? fields.join(",\n") : "  note = {no metadata fields returned}";
    blocks.push(`@${type}{${key},\n${body}\n}`);
  }

  return `${blocks.join("\n\n")}\n`;
}

function line(label: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return `- ${label}: (not returned by IEEE)`;
  if (Array.isArray(value)) {
    return value.length === 0
      ? `- ${label}: (not returned by IEEE)`
      : `- ${label}: ${value.join("; ")}`;
  }
  return `- ${label}: ${String(value)}`;
}

export function recordToMarkdown(record: PaperRecord, index: number): string {
  const lines: string[] = [];
  lines.push(`### [${index}] ${record.title ?? "(title not returned by IEEE)"}`);
  lines.push("");
  lines.push(line("Authors", record.authors.map((author) => `${author.name}${author.affiliation ? ` (${author.affiliation})` : ""}`)));
  lines.push(line("Year", record.year));
  lines.push(line("Publication", record.publication_title));
  lines.push(line("Content type", record.content_type));
  lines.push(line("DOI", record.doi));
  lines.push(line("Article number", record.article_number));
  lines.push(line("Pages", record.pages));
  lines.push(line("Volume/Issue", [record.volume, record.issue].filter(Boolean).join("/") || null));
  lines.push(line("Publisher", record.publisher));
  lines.push(line("Conference", [record.conference_location, record.conference_dates].filter(Boolean).join(" | ") || null));
  lines.push(line("Open access", record.is_open_access === null ? null : record.is_open_access ? "yes" : "no"));
  lines.push(line("Citations", record.citing_paper_count === null ? null : `${record.citing_paper_count} papers / ${record.citing_patent_count ?? 0} patents`));
  lines.push(line("Author keywords", record.keywords.author_terms));
  lines.push(line("IEEE terms", record.keywords.ieee_terms));
  lines.push(line("MeSH terms", record.keywords.mesh_terms));
  lines.push(line("Abstract URL", record.abstract_url));
  lines.push(line("HTML URL", record.html_url));
  lines.push(line("PDF URL", record.pdf_url));
  if (record.missing_fields.length > 0) {
    lines.push(`- Missing fields: ${record.missing_fields.join(", ")}`);
  }
  lines.push("");
  lines.push("Abstract:");
  lines.push(record.abstract ?? "(not returned by IEEE - no abstract in the metadata record)");
  return lines.join("\n");
}

export function usageMarkdown(usage: UsageInfo): string {
  return [
    "Local usage counter (NOT the official IEEE remaining quota):",
    `- calls in current UTC day: ${usage.local_calls_utc_day}`,
    `- calls in current local day: ${usage.local_calls_local_day}`,
    `- calls in rolling 24h: ${usage.local_calls_rolling_24h}`,
    `- configured local daily budget: ${usage.daily_budget} (window: ${usage.budget_window})`,
    `- locally inferred remaining budget: ${usage.remaining_local_budget}`,
    `- HTTP attempts this process (includes retries): ${usage.process_http_attempts}`,
    `- cache hits this process: ${usage.process_cache_hits}`,
  ].join("\n");
}

export function payloadToMarkdown(payload: SearchResultPayload): string {
  const lines: string[] = [];
  lines.push("# IEEE Xplore metadata search result");
  lines.push("");
  lines.push(`- search_id: ${payload.search_id}`);
  lines.push("- search scope: metadata + abstract (NOT full text)");
  lines.push(`- executed queries: ${payload.queries_executed.join(" | ") || "(none)"}`);
  lines.push(`- effective API parameters: \`${JSON.stringify(payload.query)}\``);
  lines.push(`- total records reported by IEEE: ${payload.total_records ?? "(not returned)"}`);
  lines.push(`- records returned in this response: ${payload.returned_records}`);
  lines.push(
    `- page (${payload.pagination.mode}): start_record=${payload.pagination.start_record}, ` +
      `max_records=${payload.pagination.max_records}, last_index=${payload.pagination.last_returned_index}`
  );
  lines.push(`- has_more: ${payload.pagination.has_more}`);
  lines.push(`- next_start_record: ${payload.pagination.next_start_record ?? "(none)"}`);
  lines.push(`- pages fetched: ${payload.pagination.pages_fetched}`);
  if (payload.pagination.stop_reason) lines.push(`- pagination stop reason: ${payload.pagination.stop_reason}`);
  if (payload.per_query.length > 1) {
    lines.push("");
    lines.push("Per-query detail:");
    for (const entry of payload.per_query) {
      lines.push(
        `- ${entry.query}: total=${entry.total_records ?? "unknown"}, returned=${entry.returned}, ` +
          `requests=${entry.requests}, has_more=${entry.has_more}, ` +
          `next_start_record=${entry.next_start_record ?? "(none)"}${entry.cache_hit ? ", cache=hit" : ""}` +
          `${entry.stop_reason ? `, stop=${entry.stop_reason}` : ""}`
      );
    }
  }
  lines.push(`- duplicates removed: ${payload.dedup.duplicates_removed}`);
  lines.push(`- cache: ${payload.cache.hit ? "hit" : "miss"}`);
  if (payload.warnings.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    for (const warning of payload.warnings) lines.push(`- ${warning}`);
  }
  lines.push("");
  lines.push(usageMarkdown(payload.usage));
  lines.push("");

  if (payload.articles.length === 0) {
    lines.push("No records matched.");
    return lines.join("\n");
  }

  payload.articles.forEach((record, index) => {
    lines.push("---");
    lines.push("");
    lines.push(recordToMarkdown(record, payload.pagination.start_record + index));
    lines.push("");
  });
  return lines.join("\n");
}
