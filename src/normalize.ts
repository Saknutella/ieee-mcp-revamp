/**
 * Normalization: raw IEEE Xplore metadata -> stable, explicit `PaperRecord`.
 *
 * Contract: a missing field is `null` and is listed in `missing_fields`.
 * Nothing is guessed, defaulted to a plausible value, or synthesized.
 */

import { ACCESS_TYPES } from "./ieeeSpec.js";
import type { IEEEArticle, IEEEAuthor, IEEETermList, PaperAuthor, PaperKeywords, PaperRecord } from "./types.js";

export const SOURCE_LABEL = "IEEE Xplore";

/** Fields that callers are told to expect; absence is reported explicitly. */
const REQUIRED_FIELDS = [
  "title",
  "authors",
  "year",
  "publication_title",
  "abstract",
  "keywords",
  "doi",
  "article_number",
  "abstract_url",
] as const;

function toStr(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return null;
}

function toNum(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function termListToArray(value: IEEETermList | string[] | undefined): string[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map((item) => toStr(item)).filter((item): item is string => item !== null);
  }
  const terms = (value as IEEETermList).terms;
  if (!Array.isArray(terms)) return [];
  return terms.map((item) => toStr(item)).filter((item): item is string => item !== null);
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function normalizeAuthors(article: IEEEArticle): PaperAuthor[] {
  const raw = article.authors;
  let list: IEEEAuthor[] = [];
  if (Array.isArray(raw)) list = raw;
  else if (raw && Array.isArray(raw.authors)) list = raw.authors;

  const authors: PaperAuthor[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const name = toStr(entry.full_name) ?? toStr(entry.name);
    if (!name) continue;
    authors.push({
      name,
      affiliation: toStr(entry.affiliation),
      order: toNum(entry.author_order),
    });
  }
  // The API documents `author_order`; fall back to array order when absent.
  const allHaveOrder = authors.every((author) => author.order !== null);
  if (!allHaveOrder) {
    authors.forEach((author, index) => {
      if (author.order === null) author.order = index + 1;
    });
  }
  authors.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  return authors;
}

export function normalizeKeywords(article: IEEEArticle): PaperKeywords {
  const index = article.index_terms ?? {};
  const author = uniqueStrings([
    ...termListToArray(index.author_terms),
    ...termListToArray(article.author_terms as IEEETermList | string[] | undefined),
  ]);
  const ieee = uniqueStrings([
    ...termListToArray(index.ieee_terms),
    ...termListToArray(article.ieee_terms as IEEETermList | string[] | undefined),
  ]);
  const mesh = uniqueStrings([
    ...termListToArray(index.mesh_terms),
    ...termListToArray(article.mesh_terms as IEEETermList | string[] | undefined),
  ]);

  const other: Record<string, string[]> = {};
  for (const [category, value] of Object.entries(index)) {
    if (category === "author_terms" || category === "ieee_terms" || category === "mesh_terms") continue;
    const terms = termListToArray(value);
    if (terms.length > 0) other[category] = terms;
  }

  return { author_terms: author, ieee_terms: ieee, mesh_terms: mesh, other };
}

function deriveOpenAccess(article: IEEEArticle): { isOpenAccess: boolean | null; accessType: string | null } {
  const accessType = toStr(article.accessType);
  const raw = article.is_open_access;
  if (typeof raw === "boolean") return { isOpenAccess: raw, accessType };
  if (accessType) {
    const normalized = accessType.toLowerCase();
    if (ACCESS_TYPES.some((known) => known.toLowerCase() === normalized)) {
      return { isOpenAccess: normalized === "open access" || normalized === "ephemera", accessType };
    }
    return { isOpenAccess: null, accessType };
  }
  return { isOpenAccess: null, accessType: null };
}

function derivePages(article: IEEEArticle): { start: string | null; end: string | null; pages: string | null } {
  const start = toStr(article.start_page);
  const end = toStr(article.end_page);
  const range = toStr(article.page_range);
  if (start && end) return { start, end, pages: start === end ? start : `${start}-${end}` };
  if (range) return { start, end, pages: range };
  if (start) return { start, end: null, pages: start };
  return { start: null, end: null, pages: null };
}

export function normalizeArticle(article: IEEEArticle, retrievedVia: string): PaperRecord {
  const title = toStr(article.title);
  const doi = toStr(article.doi);
  const articleNumber = toStr(article.article_number);
  const authors = normalizeAuthors(article);
  const authorNames = authors.length > 0 ? authors.map((author) => author.name).join("; ") : null;
  const year = toStr(article.publication_year);
  const publicationTitle = toStr(article.publication_title);
  const abstract = toStr(article.abstract);
  const keywords = normalizeKeywords(article);
  const keywordCount =
    keywords.author_terms.length +
    keywords.ieee_terms.length +
    keywords.mesh_terms.length +
    Object.values(keywords.other).reduce((sum, terms) => sum + terms.length, 0);
  const abstractUrl = toStr(article.abstract_url);
  const { isOpenAccess, accessType } = deriveOpenAccess(article);
  const pages = derivePages(article);
  const htmlUrl = toStr(article.html_url);
  const pdfUrl = toStr(article.pdf_url);

  const record: PaperRecord = {
    article_number: articleNumber,
    doi,
    doi_url: doi ? `https://doi.org/${doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")}` : null,
    title,
    authors,
    author_names: authorNames,
    year,
    publication_date: toStr(article.publication_date),
    publication_title: publicationTitle,
    content_type: toStr(article.content_type),
    abstract,
    keywords,
    abstract_url: abstractUrl,
    html_url: htmlUrl,
    pdf_url: pdfUrl,
    is_open_access: isOpenAccess,
    access_type: accessType,
    start_page: pages.start,
    end_page: pages.end,
    pages: pages.pages,
    volume: toStr(article.volume),
    issue: toStr(article.issue),
    publisher: toStr(article.publisher),
    isbn: toStr(article.isbn),
    issn: toStr(article.issn),
    conference_location: toStr(article.conference_location),
    conference_dates: toStr(article.conference_dates),
    standard_number: toStr(article.standard_number),
    citing_paper_count: toNum(article.citing_paper_count),
    citing_patent_count: toNum(article.citing_patent_count),
    insert_date: toStr(article.insert_date),
    source: SOURCE_LABEL,
    retrieved_via: retrievedVia,
    missing_fields: [],
  };

  const absent: string[] = [];
  for (const field of REQUIRED_FIELDS) {
    if (field === "keywords") {
      if (keywordCount === 0) absent.push(field);
      continue;
    }
    if (field === "authors") {
      if (authors.length === 0) absent.push(field);
      continue;
    }
    if (record[field] === null) absent.push(field);
  }
  record.missing_fields = absent;
  return record;
}

export function normalizeArticles(articles: IEEEArticle[] | undefined, retrievedVia: string): PaperRecord[] {
  if (!Array.isArray(articles)) return [];
  const out: PaperRecord[] = [];
  for (const article of articles) {
    if (!article || typeof article !== "object") continue;
    out.push(normalizeArticle(article, retrievedVia));
  }
  return out;
}
