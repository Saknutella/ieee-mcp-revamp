/**
 * Rendering: structured payload -> JSON / Markdown / CSV / BibTeX.
 *
 * Missing values are rendered as an explicit empty cell / omitted BibTeX field,
 * never as a placeholder that could be mistaken for real metadata.
 */

import type { PaperRecord, SearchResultPayload, UsageInfo } from "./types.js";
import type { ReferenceLookupPayload } from "./references.js";

export type OutputFormat = "json" | "markdown" | "csv" | "bibtex" | "citation";

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

// ── Crossref reference rendering ───────────────────────────────────────────────

const PROVENANCE_BANNER = [
  "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
  "!! SOURCE: Crossref REST API  --  NOT IEEE Xplore                          !!",
  "!! Crossref reference lists are publisher-deposited. Verified against IEEE  !!",
  "!! Xplore on a small sample only (2 papers, 21 references). VERIFY YOURSELF  !!",
  "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
];

export function referencesToBibtex(payload: ReferenceLookupPayload): string {
  const lines: string[] = [
    ...PROVENANCE_BANNER.map((line) => `% ${line}`),
    `% source: ${payload.source}`,
    `% retrieved_at: ${payload.retrieved_at}`,
    `% bibtex_mode: ${payload.bibtex_mode}`,
    `% references: ${payload.totals.references} (${payload.totals.with_doi} with DOI, ${payload.totals.without_doi} without)`,
    "%",
    "% Entries marked `generated_from_crossref_metadata` were built from the fields the",
    "% publisher deposited (entry type inferred from the container title, so it can be wrong;",
    "% `pages` is often only the first page, because that is all Crossref carries).",
    "% Entries fetched via Crossref content negotiation are authoritative Crossref BibTeX.",
    "%",
    "% Entries are ordered by the publisher's citation key (ref1, ref2, ...), which preserves",
    "% the numbering used in the paper. Anything without a derivable key is placed last.",
    "%",
    "% This is NOT IEEE metadata. IEEE Xplore exposes no reference list.",
    "% Compare against the References section of each paper's IEEE Xplore page.",
  ];

  for (const paper of payload.papers) {
    lines.push("%");
    lines.push(`% ===== ${paper.requested_doi} =====`);
    if (paper.work?.title) lines.push(`% ${paper.work.title}`);
    if (!paper.ok) {
      lines.push(`% LOOKUP FAILED (${paper.error?.code}): ${paper.error?.message}`);
      continue;
    }
    lines.push(`% references returned: ${paper.references_returned}` +
      (paper.references_count_from_crossref !== null
        ? ` | Crossref references-count: ${paper.references_count_from_crossref}`
        : ""));
    if (paper.verify.ieee_xplore) lines.push(`% verify at: ${paper.verify.ieee_xplore}`);
    lines.push(`% Crossref record: ${paper.crossref_url}`);
    lines.push("");
    for (const reference of paper.references) {
      if (reference.bibtex) {
        lines.push(reference.bibtex);
        lines.push("");
      }
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * Best-effort IEEE-style author string: "Alice Zhang" -> "A. Zhang",
 * "Zhang, Alice" -> "A. Zhang", and tokens that already look like initials are
 * kept as-is. Name order is a convention that varies by culture, so the caller
 * is told this is mechanical.
 */
export function ieeeAuthorName(fullName: string): string {
  const cleaned = fullName.trim();
  if (cleaned.length === 0) return cleaned;
  const initialOf = (word: string): string =>
    /^([A-Z]\.){1,4}$/.test(word) ? word : `${word[0]?.toUpperCase() ?? ""}.`;

  if (cleaned.includes(",")) {
    const [last, rest] = cleaned.split(",", 2);
    const initials = (rest ?? "")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(initialOf)
      .join(" ");
    return `${initials ? `${initials} ` : ""}${(last ?? "").trim()}`;
  }
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return cleaned;
  const last = parts[parts.length - 1];
  const initials = parts.slice(0, -1).map(initialOf).join(" ");
  return `${initials} ${last}`;
}

function ieeeAuthorList(record: PaperRecord): string | null {
  const names = record.authors.map((author) => ieeeAuthorName(author.name));
  if (names.length === 0) return null;
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

/** Plain-text IEEE-style reference string, built only from returned metadata. */
export function toIeeeCitation(record: PaperRecord, index?: number): string {
  const parts: string[] = [];
  const authors = ieeeAuthorList(record);
  if (authors) parts.push(authors);
  parts.push(record.title ? `"${record.title}"` : "(title not returned by IEEE)");
  if (record.publication_title) parts.push(record.publication_title);
  if (record.volume) parts.push(`vol. ${record.volume}`);
  if (record.issue) parts.push(`no. ${record.issue}`);
  if (record.pages) parts.push(`pp. ${record.pages}`);
  if (record.year) parts.push(record.year);
  if (record.doi) parts.push(`doi: ${record.doi}`);
  const prefix = index === undefined ? "" : `[${index}] `;
  return `${prefix}${parts.join(", ")}.`;
}

const RIS_TYPE: Record<string, string> = {
  journals: "JOUR",
  magazines: "JOUR",
  "early access": "JOUR",
  conferences: "CPAPER",
  books: "BOOK",
  standards: "STD",
  courses: "GEN",
};

function risType(record: PaperRecord): string {
  const contentType = (record.content_type ?? "").toLowerCase();
  for (const [key, value] of Object.entries(RIS_TYPE)) {
    if (contentType.includes(key)) return value;
  }
  return "GEN";
}

function splitPages(pages: string | null): { start: string | null; end: string | null } {
  if (!pages) return { start: null, end: null };
  const match = /^\s*([A-Za-z]?\d+)\s*[-–]\s*([A-Za-z]?\d+)\s*$/.exec(pages);
  if (match) return { start: match[1], end: match[2] };
  return { start: pages.trim(), end: null };
}

/**
 * RIS record, importable by Zotero, EndNote, Mendeley and most reference
 * managers. This is the format to use for "put this paper in my library".
 */
export function toRis(record: PaperRecord): string {
  const lines: string[] = [`TY  - ${risType(record)}`];
  for (const author of record.authors) {
    // RIS prefers "Family, Given"; fall back to the name as returned.
    const [first, ...rest] = author.name.split(/\s+/);
    const family = rest.length > 0 ? rest[rest.length - 1] : first;
    const given = rest.length > 1 ? rest.slice(0, -1).join(" ") : rest.length === 1 ? first : "";
    lines.push(`AU  - ${given ? `${family}, ${given}` : family}`);
  }
  if (record.title) lines.push(`TI  - ${record.title}`);
  if (record.publication_title) lines.push(`JO  - ${record.publication_title}`);
  if (record.volume) lines.push(`VL  - ${record.volume}`);
  if (record.issue) lines.push(`IS  - ${record.issue}`);
  const pages = splitPages(record.pages);
  if (pages.start) lines.push(`SP  - ${pages.start}`);
  if (pages.end) lines.push(`EP  - ${pages.end}`);
  if (record.year) lines.push(`PY  - ${record.year}`);
  if (record.publication_date) lines.push(`DA  - ${record.publication_date}`);
  if (record.publisher) lines.push(`PB  - ${record.publisher}`);
  if (record.issn) lines.push(`SN  - ${record.issn}`);
  else if (record.isbn) lines.push(`SN  - ${record.isbn}`);
  if (record.doi) lines.push(`DO  - ${record.doi}`);
  const url = record.html_url ?? record.abstract_url ?? (record.doi ? `https://doi.org/${record.doi}` : null);
  if (url) lines.push(`UR  - ${url}`);
  if (record.abstract) lines.push(`AB  - ${record.abstract.replace(/\s+/g, " ")}`);
  if (record.keywords.ieee_terms.length > 0 || record.keywords.author_terms.length > 0) {
    lines.push(`KW  - ${[...record.keywords.author_terms, ...record.keywords.ieee_terms].join(", ")}`);
  }
  lines.push(`AN  - ${record.article_number ?? ""}`);
  lines.push("ER  - ");
  return lines.join("\r\n");
}

/**
 * A citation bundle for one or more records: plain citation, BibTeX and RIS.
 * Generated mechanically from IEEE metadata - nothing is looked up elsewhere.
 */
export function citationBundle(records: PaperRecord[], retrievedAt: string): string {
  const lines: string[] = [
    "# Citation bundle",
    "",
    "Source of the underlying metadata: **IEEE Xplore Metadata Search API**.",
    `Retrieved: ${retrievedAt}`,
    "",
    "> The plain-text citation and the BibTeX entry are generated mechanically from the",
    "> metadata IEEE returned - nothing is invented, and nothing is looked up elsewhere.",
    "> IEEE-style author initials are a best-effort transformation (name order conventions",
    "> differ by culture), so check author formatting before submitting. RIS is the format",
    "> to import into Zotero / EndNote / Mendeley.",
    "",
  ];

  records.forEach((record, index) => {
    lines.push("---");
    lines.push("");
    lines.push(`## ${index + 1}. ${record.title ?? "(title not returned by IEEE)"}`);
    lines.push("");
    if (record.missing_fields.length > 0) {
      lines.push(`> Missing from the IEEE record: ${record.missing_fields.join(", ")}.`);
      lines.push("");
    }
    lines.push("**Plain citation**");
    lines.push("");
    lines.push("```");
    lines.push(toIeeeCitation(record));
    lines.push("```");
    lines.push("");
    lines.push("**BibTeX**");
    lines.push("");
    lines.push("```bibtex");
    lines.push(toBibtex([record], {
      queryId: `citation-${index + 1}`,
      retrievedAt,
      endpoint: record.retrieved_via,
      query: {},
    }).split("\n").filter((line) => !line.startsWith("%")).join("\n").trim());
    lines.push("```");
    lines.push("");
    lines.push("**RIS**");
    lines.push("");
    lines.push("```ris");
    lines.push(toRis(record));
    lines.push("```");
    lines.push("");
  });

  return lines.join("\n").trimEnd();
}

export function referencesToMarkdown(payload: ReferenceLookupPayload): string {
  const lines: string[] = [];
  lines.push("# Crossref reference lookup");
  lines.push("");
  lines.push(...PROVENANCE_BANNER.map((line) => `> ${line}`));
  lines.push("");
  lines.push(`- **source**: ${payload.source} (\`source_is_ieee: false\`)`);
  lines.push(`- **retrieved_at**: ${payload.retrieved_at}`);
  lines.push(`- **papers requested**: ${payload.requested} (succeeded ${payload.succeeded}, failed ${payload.failed})`);
  lines.push(
    `- **references found**: ${payload.totals.references} ` +
      `(${payload.totals.with_doi} with DOI, ${payload.totals.without_doi} without)`
  );
  lines.push(`- **bibtex_mode**: ${payload.bibtex_mode}`);
  lines.push(`- **IEEE calls consumed**: ${payload.usage.ieee_calls_consumed} (${payload.usage.note})`);
  lines.push("");
  lines.push(`**What this is**: ${payload.provenance.what_this_is}`);
  lines.push("");
  lines.push(`**What this is not**: ${payload.provenance.what_this_is_not}`);
  lines.push("");
  lines.push(`**Verification**: ${payload.provenance.verification_note}`);
  lines.push("");
  lines.push(`**Metric warning**: ${payload.provenance.metric_warning}`);
  lines.push("");

  if (payload.warnings.length > 0) {
    lines.push("Warnings:");
    for (const warning of payload.warnings) lines.push(`- ${warning}`);
    lines.push("");
  }

  for (const paper of payload.papers) {
    lines.push("---");
    lines.push("");
    lines.push(`## ${paper.requested_doi}`);
    if (!paper.ok) {
      lines.push("");
      lines.push(`**LOOKUP FAILED** — \`${paper.error?.code}\`: ${paper.error?.message}`);
      lines.push("");
      continue;
    }
    if (paper.work?.title) lines.push("");
    if (paper.work?.title) {
      lines.push(
        `*${paper.work.title}*` +
          (paper.work.container_title ? ` — ${paper.work.container_title}` : "") +
          (paper.work.year ? ` (${paper.work.year})` : "")
      );
    }
    lines.push("");
    lines.push(
      `- references returned: **${paper.references_returned}**` +
        (paper.references_count_from_crossref !== null
          ? ` | Crossref \`references-count\`: ${paper.references_count_from_crossref}` +
            (paper.counts_agree === false ? " **(MISMATCH)**" : "")
          : "")
    );
    lines.push(`- with DOI: ${paper.with_doi} | without DOI: ${paper.without_doi}`);
    lines.push(`- incoming citations (different metric): ${paper.work?.is_referenced_by_count ?? "(not reported)"}`);
    lines.push(`- Crossref record: ${paper.crossref_url}`);
    if (paper.verify.ieee_xplore) lines.push(`- **verify against IEEE Xplore**: ${paper.verify.ieee_xplore}`);
    lines.push("");
    lines.push("| # | DOI | Title | Author | Year | Container |");
    lines.push("|---|---|---|---|---|---|");
    for (const reference of paper.references) {
      const cell = (value: string | null): string =>
        (value ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").slice(0, 90);
      lines.push(
        `| ${reference.order ?? reference.key ?? ""} | ${cell(reference.doi) || "*(none deposited)*"} | ` +
          `${cell(reference.title)} | ${cell(reference.author)} | ${cell(reference.year)} | ${cell(reference.container)} |`
      );
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
