/**
 * IEEE Xplore Metadata Search API - documented parameter vocabulary.
 *
 * Source: https://developer.ieee.org/docs/read/Metadata_API_details
 *         https://developer.ieee.org/docs/read/metadata_api_details/Filtering_Parameters
 *         https://developer.ieee.org/docs/read/metadata_api_details/Sorting_and_Paging_Parameters
 *
 * Everything here is a constraint the API documents explicitly. Values are kept
 * verbatim (including casing) because IEEE documents several of them as
 * case-sensitive. This module contains no API key and performs no I/O.
 */

/** Documented hard limit for `max_records`. */
export const MAX_RECORDS_PER_REQUEST = 200;

/** Documented default for `max_records`. */
export const DEFAULT_MAX_RECORDS = 25;

/**
 * `content_type` values - the docs state these "are case sensitive and must be
 * spelled as presented here to get a result".
 */
export const CONTENT_TYPES = [
  "Books",
  "Conferences",
  "Courses",
  "Early Access",
  "Journals",
  "Journals,Magazines",
  "Magazines",
  "Standards",
] as const;

export type ContentType = (typeof CONTENT_TYPES)[number];

/** `sort_field` accepts exactly these three values (not `publication_year`/`author`). */
export const SORT_FIELDS = ["article_number", "article_title", "publication_title"] as const;
export type SortField = (typeof SORT_FIELDS)[number];

export const SORT_ORDERS = ["asc", "desc"] as const;
export type SortOrder = (typeof SORT_ORDERS)[number];

/** `publisher` is a closed list per the Filtering Parameters page. */
export const PUBLISHERS = [
  "Alcatel-Lucent",
  "AGU",
  "BIAI",
  "CSEE",
  "IBM",
  "IEEE",
  "IET",
  "MITP",
  "Morgan & Claypool",
  "SMPTE",
  "TUP",
  "VDE",
] as const;

/** `accessType` values documented on the "Data Fields Returned" page. */
export const ACCESS_TYPES = ["Open Access", "Ephemera", "Locked", "Plagarized"] as const;

/**
 * Parameters that search *configured metadata fields and the abstract*.
 * They are explicitly NOT full-text search of the article body. Do not describe
 * them as full-text search in tool descriptions or README text.
 */
export const METADATA_SEARCH_PARAMS = [
  "querytext",
  "meta_data",
  "article_title",
  "abstract",
  "author",
  "affiliation",
  "index_terms",
  "thesaurus_terms",
] as const;

/** `article_number` may only be used by itself; other parameters are ignored. */
export const EXCLUSIVE_PARAMS = ["article_number", "doi"] as const;

/** Free text parameters capped by IEEE at two wildcard words. */
export const WILDCARD_LIMITED_PARAMS = [
  "querytext",
  "meta_data",
  "index_terms",
  "thesaurus_terms",
] as const;

export const IEEE_ENDPOINT_DOCS = "https://developer.ieee.org/docs/read/Metadata_API_details";
