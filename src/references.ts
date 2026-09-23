/**
 * Reference lookup orchestration.
 *
 * Produces a payload that is explicit about three things the caller must not
 * lose sight of:
 *   1. the data comes from Crossref, not from IEEE Xplore;
 *   2. Crossref reference lists are publisher-deposited and were only verified
 *      against IEEE on a small sample, so they need manual checking;
 *   3. Crossref reference count and Crossref incoming-citation count are
 *      different metrics and are never merged.
 *
 * Crossref requests never consume the IEEE call budget.
 */

import { IeeeMcpError, InputError, toIeeeMcpError } from "./errors.js";
import { log } from "./logger.js";
import {
  CROSSREF_SOURCE_LABEL,
  type CrossrefClient,
  type CrossrefReferenceEntry,
  type CrossrefWorkResult,
} from "./crossref.js";
import type { Config } from "./config.js";
import type { PaperRecord } from "./types.js";

export type BibtexMode = "none" | "generated" | "crossref";

export interface ReferenceEntryOut extends CrossrefReferenceEntry {
  bibtex: string | null;
  bibtex_source: "crossref_content_negotiation" | "generated_from_crossref_metadata" | null;
}

export interface PaperReferencesOut {
  requested_doi: string;
  ok: boolean;
  error: { code: string; message: string } | null;
  work: CrossrefWorkResult["work"] | null;
  /** Crossref's own `references-count` field. */
  references_count_from_crossref: number | null;
  /** Number of entries actually present in Crossref's `reference` array. */
  references_returned: number;
  /** True when the count field equals the array length. */
  counts_agree: boolean | null;
  with_doi: number;
  without_doi: number;
  from_cache: boolean;
  crossref_url: string;
  /** Where a human can check this list against the publisher's page. */
  verify: { crossref: string; doi: string; ieee_xplore: string | null };
  references: ReferenceEntryOut[];
}

export interface ReferenceLookupPayload {
  ok: boolean;
  source: string;
  source_kind: "reference_list";
  source_is_ieee: false;
  provenance: {
    statement: string;
    what_this_is: string;
    what_this_is_not: string;
    verification_required: true;
    verification_note: string;
    evidence: string;
    metric_warning: string;
  };
  retrieved_at: string;
  bibtex_mode: BibtexMode;
  requested: number;
  succeeded: number;
  failed: number;
  totals: {
    references: number;
    with_doi: number;
    without_doi: number;
  };
  papers: PaperReferencesOut[];
  warnings: string[];
  usage: {
    crossref_requests: number;
    crossref_cache_hits: number;
    ieee_calls_consumed: 0;
    batching: {
      enabled: boolean;
      batch_size: number;
      batch_requests: number;
      note: string;
    };
    note: string;
  };
}

const PROVENANCE = {
  statement:
    "The reference lists below come from the Crossref REST API, NOT from IEEE Xplore.",
  verification_required: true as const,
  what_this_is:
    "Crossref reference metadata is deposited by the publisher. Each entry keeps the publisher's citation " +
    "key (ref1, ref2, ...), which preserves the numbering used in the paper, plus whatever fields were " +
    "deposited (DOI, title, author, year, journal, first page) - and nothing more.",
  what_this_is_not:
    "This is not IEEE metadata. The IEEE Xplore Metadata Search API exposes NO reference list at all: " +
    "citing_paper_count and citing_patent_count are INCOMING citation counts. IEEE cannot cross-check " +
    "or contradict what Crossref reports here.",
  verification_note:
    "VERIFY BEFORE RELYING ON IT. On two IEEE papers (21 references, checked position by position, " +
    "including entries the publisher deposited without a DOI) Crossref matched the IEEE Xplore reference " +
    "list exactly. That is a small sample, so treat this as a strong lead, not as a certified list, and " +
    "compare it against the References section of the paper page on IEEE Xplore.",
  evidence:
    "Verified 2026-09: IEEE Trans. Circuits Syst. II 2021 (art. 9422824) 14/14 and ESSCIRC 2019 " +
    "(art. 8902902) 7/7 both matched IEEE Xplore position by position.",
  metric_warning:
    "Do not confuse the reference count here with the citation counts reported by the IEEE search tools: " +
    "references are works this paper CITES (outgoing); citing_paper_count is how many works CITE it " +
    "(incoming). Crossref also exposes `is_referenced_by_count`, which is the incoming metric - it is " +
    "reported separately and never mixed in.",
} as const;

function escapeBibtex(value: string): string {
  return value.replace(/\\/g, "\\textbackslash{}").replace(/([{}])/g, "\\$1");
}

function bibtexField(name: string, value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return `  ${name} = {${escapeBibtex(trimmed)}}`;
}

/**
 * Heuristic entry type: Crossref references rarely carry an explicit type, so
 * this is inferred from the container title and CAN BE WRONG. Callers are told
 * so in the BibTeX header and in `bibtex_source`.
 */
export function inferEntryType(reference: CrossrefReferenceEntry): "article" | "inproceedings" | "misc" {
  const container = (reference.container ?? "").toLowerCase();
  if (container.length > 0) {
    if (/(conf|symp|proc|workshop|dig\.?\s*tech|congress|meeting|isscc|iscas|vlsic|esscirc|rfic)/.test(container)) {
      return "inproceedings";
    }
    if (
      /(journal|transactions|letters|review|magazine|express|access|solid\s*-?\s*state|ieee\s+j\b|\bj\.\s)/.test(
        container
      )
    ) {
      return "article";
    }
    return "inproceedings";
  }
  if (reference.unstructured) return "misc";
  return "misc";
}

function asciiFold(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9]/g, "");
}

function citationKey(reference: CrossrefReferenceEntry, used: Set<string>): string {
  const author = asciiFold((reference.author ?? "").split(/[,;]/)[0] ?? "") || "ref";
  const year = asciiFold(reference.year ?? "") || "nd";
  const tail = reference.order !== null ? String(reference.order).padStart(2, "0") : "";
  let base = `${author}${year}${tail}`.toLowerCase();
  if (base.length > 50) base = base.slice(0, 50);
  let candidate = base;
  let suffix = 0;
  while (used.has(candidate)) {
    suffix += 1;
    candidate = `${base}${String.fromCharCode(96 + Math.min(suffix, 26))}`;
  }
  used.add(candidate);
  return candidate;
}

/** Build a BibTeX entry from the fields the publisher actually deposited. */
export function generateReferenceBibtex(reference: CrossrefReferenceEntry, used: Set<string>): string {
  const type = inferEntryType(reference);
  const key = citationKey(reference, used);
  const hasDescriptiveField = Boolean(reference.title || reference.author || reference.year || reference.container);
  const fields = [
    bibtexField("author", reference.author),
    bibtexField("title", reference.title),
    type === "article" ? bibtexField("journal", reference.container) : null,
    type === "inproceedings" ? bibtexField("booktitle", reference.container) : null,
    type === "misc" ? bibtexField("howpublished", reference.container) : null,
    bibtexField("year", reference.year),
    bibtexField("volume", reference.volume),
    bibtexField("pages", reference.first_page),
    bibtexField("doi", reference.doi),
    bibtexField("note", reference.unstructured),
    // Many IEEE references are deposited with a DOI and nothing else. Say so
    // instead of emitting a bare @misc that looks like a broken entry.
    !hasDescriptiveField && reference.doi
      ? bibtexField(
          "note",
          "Crossref deposited only a DOI for this reference; no title/author/year is available " +
            "from the reference list. Use bibtex_mode=crossref to fetch the full record."
        )
      : null,
  ].filter((value): value is string => value !== null);

  if (fields.length === 0) {
    return `@misc{${key},\n  note = {Crossref reference entry ${reference.key ?? "?"} carried no usable fields}\n}`;
  }
  return `@${type}{${key},\n${fields.join(",\n")}\n}`;
}

export interface ReferenceLookupRequest {
  dois: string[];
  bibtexMode: BibtexMode;
  /** Records skipped because they carry no DOI, reported for honesty. */
  skipped: Array<{ article_number: string | null; title: string | null; reason: string }>;
  requestedTotal: number;
}

/** Turn user input into the DOI list to query, plus an explicit skip list. */
export function resolveDoiList(args: {
  dois?: string[];
  records?: PaperRecord[];
  maxDois: number;
  articleNumbers?: string[];
}): ReferenceLookupRequest {
  const skipped: ReferenceLookupRequest["skipped"] = [];
  const dois: string[] = [];
  const seen = new Set<string>();
  const wanted = args.articleNumbers && args.articleNumbers.length > 0 ? new Set(args.articleNumbers) : null;

  if (args.records) {
    for (const record of args.records) {
      if (wanted && !(record.article_number && wanted.has(record.article_number))) continue;
      if (!record.doi) {
        skipped.push({
          article_number: record.article_number,
          title: record.title,
          reason: "IEEE record carries no DOI, so Crossref cannot be queried for it.",
        });
        continue;
      }
      const doi = record.doi.trim().toLowerCase();
      if (seen.has(doi)) continue;
      seen.add(doi);
      dois.push(doi);
    }
  }

  for (const raw of args.dois ?? []) {
    const doi = raw.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").replace(/^doi:\s*/i, "").toLowerCase();
    if (doi.length === 0) continue;
    if (seen.has(doi)) continue;
    seen.add(doi);
    dois.push(doi);
  }

  const requestedTotal = dois.length;
  const limited = dois.slice(0, args.maxDois);
  return { dois: limited, bibtexMode: "generated", skipped, requestedTotal };
}

export interface LookupContext {
  config: Config;
  crossref: CrossrefClient;
}

export async function lookupReferences(
  context: LookupContext,
  request: ReferenceLookupRequest
): Promise<ReferenceLookupPayload> {
  const { config, crossref } = context;
  const warnings: string[] = [];

  if (!config.crossrefEnabled) {
    throw new InputError(
      "Crossref lookups are disabled.",
      "Set IEEE_MCP_CROSSREF_ENABLED=1 in the MCP client environment to enable reference lookups."
    );
  }
  if (request.dois.length === 0) {
    throw new InputError(
      "No DOI available to look up.",
      "Provide `dois`, or pass a `search_id` whose records carry DOIs. " +
        "The IEEE Metadata Search API does not expose reference lists, so a DOI is required to reach Crossref."
    );
  }
  if (request.requestedTotal > request.dois.length) {
    warnings.push(
      `Only the first ${request.dois.length} of ${request.requestedTotal} DOIs were looked up ` +
        `(cap IEEE_MCP_MAX_DOIS_PER_CALL=${config.maxDoisPerCall}).`
    );
  }
  for (const skip of request.skipped) {
    warnings.push(
      `Skipped ${skip.article_number ?? "(no article number)"}` +
        `${skip.title ? ` "${skip.title.slice(0, 60)}"` : ""}: ${skip.reason}`
    );
  }

  const papers: PaperReferencesOut[] = [];
  let totalBibtexFetches = 0;

  // Per-call counters. The client's own stats are process-wide, so subtracting
  // them over a window is wrong when a client issues several tool calls at once:
  // concurrent calls would each count the others' requests.
  let countedRequests = 0;
  let countedCacheHits = 0;
  const countWork = (fromCache: boolean): void => {
    if (fromCache) countedCacheHits += 1;
    else countedRequests += 1;
  };

  // ── Fetch: one batched request covers many DOIs ────────────────────────────
  // Crossref returns each work's complete reference array from a single
  // `filter=doi:A,doi:B,...` request, so N papers usually cost 1 request
  // instead of N. Anything the batch does not resolve (absent, or the batch
  // itself failed) falls through to an individual request, which also yields a
  // precise per-DOI error.
  const prefetched = new Map<string, CrossrefWorkResult>();
  const batchSize = Math.max(1, config.crossrefBatchSize);
  const batchingEnabled = request.dois.length > 1 && batchSize > 1;
  let batchRequests = 0;

  if (batchingEnabled) {
    for (let offset = 0; offset < request.dois.length; offset += batchSize) {
      const chunk = request.dois.slice(offset, offset + batchSize);
      try {
        const batch = await crossref.getWorksBatch(chunk);
        batchRequests += 1;
        countWork(batch.fromCache);
        for (const [doi, result] of batch.results) prefetched.set(doi, result);
      } catch (error) {
        const normalized = toIeeeMcpError(error);
        log.warn(
          `Crossref batch lookup of ${chunk.length} DOI(s) failed (${normalized.code}); ` +
            "falling back to individual requests."
        );
      }
    }
    if (prefetched.size < request.dois.length) {
      log.debug(
        `Batch resolved ${prefetched.size}/${request.dois.length} DOI(s); ` +
          `${request.dois.length - prefetched.size} will be fetched individually.`
      );
    }
  }

  for (const doi of request.dois) {
    let result: CrossrefWorkResult;
    const prefetchedResult = prefetched.get(doi);
    if (prefetchedResult) {
      result = prefetchedResult;
    } else {
      try {
        result = await crossref.getWork(doi);
        countWork(result.fromCache);
      } catch (error) {
        const normalized = toIeeeMcpError(error);
        log.warn(`Crossref lookup failed for ${doi}: ${normalized.code} ${normalized.message}`);
        papers.push({
          requested_doi: doi,
          ok: false,
          error: { code: normalized.code, message: normalized.message },
          work: null,
          references_count_from_crossref: null,
          references_returned: 0,
          counts_agree: null,
          with_doi: 0,
          without_doi: 0,
          from_cache: false,
          crossref_url: crossref.workUrl(doi),
          verify: {
            crossref: crossref.workUrl(doi),
            doi: `https://doi.org/${doi}`,
            ieee_xplore: null,
          },
          references: [],
        });
        continue;
      }
    }

    const used = new Set<string>();
    const entries: ReferenceEntryOut[] = [];
    for (const reference of result.references) {
      let bibtex: string | null = null;
      let bibtexSource: ReferenceEntryOut["bibtex_source"] = null;

      if (request.bibtexMode === "generated") {
        bibtex = generateReferenceBibtex(reference, used);
        bibtexSource = "generated_from_crossref_metadata";
      } else if (request.bibtexMode === "crossref" && reference.doi) {
        if (totalBibtexFetches >= config.maxBibtexFetchesPerCall) {
          bibtex = generateReferenceBibtex(reference, used);
          bibtexSource = "generated_from_crossref_metadata";
        } else {
          totalBibtexFetches += 1;
          try {
            const fetched = await crossref.getBibtex(reference.doi);
            countWork(fetched.fromCache);
            bibtex = fetched.bibtex;
            bibtexSource = "crossref_content_negotiation";
          } catch (error) {
            log.warn(`Authoritative BibTeX fetch failed for ${reference.doi}; falling back to generated.`);
            bibtex = generateReferenceBibtex(reference, used);
            bibtexSource = "generated_from_crossref_metadata";
            warnings.push(
              `Could not fetch authoritative BibTeX for ${reference.doi} (${toIeeeMcpError(error).code}); ` +
                "a generated entry was used instead."
            );
          }
        }
      } else if (request.bibtexMode === "crossref") {
        // No DOI, so content negotiation is impossible.
        bibtex = generateReferenceBibtex(reference, used);
        bibtexSource = "generated_from_crossref_metadata";
      }

      entries.push({ ...reference, bibtex, bibtex_source: bibtexSource });
    }

    const withDoi = entries.filter((entry) => entry.has_doi).length;
    const countField = result.work.references_count;
    const arrayLength = entries.length;
    const countsAgree = countField === null ? null : countField === arrayLength;
    if (countsAgree === false) {
      warnings.push(
        `Crossref reports references-count=${countField} but returned ${arrayLength} entries for ${doi}. ` +
          "Treat the count as approximate for this record."
      );
    }

    papers.push({
      requested_doi: doi,
      ok: true,
      error: null,
      work: result.work,
      references_count_from_crossref: countField,
      references_returned: arrayLength,
      counts_agree: countsAgree,
      with_doi: withDoi,
      without_doi: arrayLength - withDoi,
      from_cache: result.fromCache,
      crossref_url: result.crossrefUrl,
      verify: {
        crossref: result.crossrefUrl,
        doi: `https://doi.org/${doi}`,
        ieee_xplore: null,
      },
      references: entries,
    });
  }

  const succeeded = papers.filter((paper) => paper.ok);
  const totals = succeeded.reduce(
    (sum, paper) => ({
      references: sum.references + paper.references_returned,
      with_doi: sum.with_doi + paper.with_doi,
      without_doi: sum.without_doi + paper.without_doi,
    }),
    { references: 0, with_doi: 0, without_doi: 0 }
  );

  if (totals.without_doi > 0) {
    warnings.push(
      `${totals.without_doi} reference(s) were deposited without a DOI. Crossref still keeps their title/author/` +
        "year, but they cannot be resolved automatically - match them by hand."
    );
  }

  const payload: ReferenceLookupPayload = {
    ok: succeeded.length > 0,
    source: CROSSREF_SOURCE_LABEL,
    source_kind: "reference_list",
    source_is_ieee: false,
    provenance: { ...PROVENANCE },
    retrieved_at: new Date().toISOString(),
    bibtex_mode: request.bibtexMode,
    requested: request.dois.length,
    succeeded: succeeded.length,
    failed: papers.length - succeeded.length,
    totals,
    papers,
    warnings,
    usage: {
      crossref_requests: countedRequests,
      crossref_cache_hits: countedCacheHits,
      ieee_calls_consumed: 0,
      batching: {
        enabled: batchingEnabled,
        batch_size: batchSize,
        batch_requests: batchRequests,
        note:
          "One Crossref request returns each work's COMPLETE reference array, so cost does not scale " +
          "with the number of references. Only bibtex_mode='crossref' scales with the number of " +
          "DOI-bearing references (one content-negotiation request each).",
      },
      note:
        "Crossref is a separate, free data source. These requests did NOT consume the IEEE daily budget " +
        "and are not recorded in the IEEE usage ledger.",
    },
  };

  log.info(
    `Crossref reference lookup: ${payload.succeeded}/${payload.requested} papers, ` +
      `${totals.references} references (${totals.with_doi} with DOI), ` +
      `${payload.usage.crossref_requests} requests, ${payload.usage.crossref_cache_hits} cache hits.`
  );
  return payload;
}

/** Attach IEEE Xplore verification links when the caller came from an IEEE search. */
export function attachIeeeVerifyLinks(payload: ReferenceLookupPayload, records: PaperRecord[]): void {
  const byDoi = new Map<string, string>();
  for (const record of records) {
    if (record.doi && record.article_number) {
      byDoi.set(record.doi.trim().toLowerCase(), record.article_number);
    }
  }
  for (const paper of payload.papers) {
    const articleNumber = byDoi.get(paper.requested_doi);
    if (articleNumber) {
      paper.verify.ieee_xplore = `https://ieeexplore.ieee.org/document/${articleNumber}/`;
    }
  }
}

export { IeeeMcpError };
