/**
 * De-duplication across merged queries and across pages.
 *
 * A record is considered a duplicate when it matches on any one of:
 *   - normalized DOI
 *   - IEEE article_number
 *   - normalized title + year (fallback for records that carry neither)
 *
 * Duplicates are merged rather than dropped: any field that is `null` on the
 * kept record is back-filled from the duplicate, so a record seen twice with
 * different completeness ends up as complete as the API allows.
 */

import { sha256Hex } from "./store.js";
import type { PaperRecord } from "./types.js";

export type DedupKeyKind = "doi" | "article_number" | "title_year";

export interface DedupKey {
  kind: DedupKeyKind;
  value: string;
}

export function normalizeDoi(doi: string | null): string | null {
  if (!doi) return null;
  const cleaned = doi
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//, "")
    .replace(/^doi:\s*/, "")
    .replace(/\s+/g, "");
  return cleaned.length > 0 ? cleaned : null;
}

export function normalizeArticleNumber(value: string | null): string | null {
  if (!value) return null;
  const cleaned = value.trim().replace(/^0+(?=\d)/, "");
  return cleaned.length > 0 ? cleaned : null;
}

export function normalizeTitle(title: string | null): string | null {
  if (!title) return null;
  const cleaned = title
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

export function dedupKeys(record: PaperRecord): DedupKey[] {
  const keys: DedupKey[] = [];
  const doi = normalizeDoi(record.doi);
  if (doi) keys.push({ kind: "doi", value: doi });
  const articleNumber = normalizeArticleNumber(record.article_number);
  if (articleNumber) keys.push({ kind: "article_number", value: articleNumber });
  const title = normalizeTitle(record.title);
  if (title && record.year) {
    keys.push({ kind: "title_year", value: `${title}|${record.year.trim().toLowerCase()}` });
  }
  return keys;
}

function keyId(key: DedupKey): string {
  return key.kind === "title_year" ? `title_year:${sha256Hex(key.value).slice(0, 16)}` : `${key.kind}:${key.value}`;
}

/** Back-fill `target` from `source` in place. Never overwrites an existing value. */
function mergeInto(target: PaperRecord, source: PaperRecord): void {
  for (const field of [
    "article_number",
    "doi",
    "doi_url",
    "title",
    "year",
    "publication_date",
    "publication_title",
    "content_type",
    "abstract",
    "abstract_url",
    "html_url",
    "pdf_url",
    "access_type",
    "start_page",
    "end_page",
    "pages",
    "volume",
    "issue",
    "publisher",
    "isbn",
    "issn",
    "conference_location",
    "conference_dates",
    "standard_number",
    "insert_date",
    "author_names",
  ] as const) {
    if (target[field] === null && source[field] !== null) {
      (target as unknown as Record<string, unknown>)[field] = source[field];
    }
  }
  if (target.is_open_access === null && source.is_open_access !== null) {
    target.is_open_access = source.is_open_access;
  }
  if (target.citing_paper_count === null && source.citing_paper_count !== null) {
    target.citing_paper_count = source.citing_paper_count;
  }
  if (target.citing_patent_count === null && source.citing_patent_count !== null) {
    target.citing_patent_count = source.citing_patent_count;
  }

  if (target.authors.length === 0 && source.authors.length > 0) target.authors = source.authors;
  if (!target.author_names && target.authors.length > 0) {
    target.author_names = target.authors.map((author) => author.name).join("; ");
  }

  const dedupeList = (a: string[], b: string[]): string[] => {
    const seen = new Set(a.map((value) => value.toLowerCase()));
    const out = [...a];
    for (const value of b) {
      const key = value.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(value);
    }
    return out;
  };
  target.keywords = {
    author_terms: dedupeList(target.keywords.author_terms, source.keywords.author_terms),
    ieee_terms: dedupeList(target.keywords.ieee_terms, source.keywords.ieee_terms),
    mesh_terms: dedupeList(target.keywords.mesh_terms, source.keywords.mesh_terms),
    other: { ...source.keywords.other, ...target.keywords.other },
  };

  // Recompute missing fields from scratch after back-filling.
  const absent: string[] = [];
  if (target.authors.length === 0) absent.push("authors");
  if (
    target.keywords.author_terms.length === 0 &&
    target.keywords.ieee_terms.length === 0 &&
    target.keywords.mesh_terms.length === 0 &&
    Object.keys(target.keywords.other).length === 0
  ) {
    absent.push("keywords");
  }
  for (const field of [
    "title",
    "year",
    "publication_title",
    "abstract",
    "doi",
    "article_number",
    "abstract_url",
  ] as const) {
    if (target[field] === null) absent.push(field);
  }
  target.missing_fields = absent;
}

export interface DedupOutcome {
  records: PaperRecord[];
  duplicatesRemoved: number;
  matchedOn: DedupKeyKind[];
}

export function dedupeRecords(records: PaperRecord[]): DedupOutcome {
  const index = new Map<string, PaperRecord>();
  const kept: PaperRecord[] = [];
  const matched = new Set<DedupKeyKind>();
  let duplicatesRemoved = 0;

  for (const record of records) {
    const keys = dedupKeys(record);
    let existing: PaperRecord | undefined;
    for (const key of keys) {
      const found = index.get(keyId(key));
      if (found) {
        existing = found;
        matched.add(key.kind);
        break;
      }
    }

    if (existing) {
      duplicatesRemoved += 1;
      mergeInto(existing, record);
      for (const key of dedupKeys(existing)) {
        if (!index.has(keyId(key))) index.set(keyId(key), existing);
      }
      continue;
    }

    kept.push(record);
    for (const key of keys) index.set(keyId(key), record);
  }

  return { records: kept, duplicatesRemoved, matchedOn: [...matched] };
}
