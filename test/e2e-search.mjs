/**
 * Search behaviour: pagination boundary, page chaining, cache, dedup/merge,
 * auto-pagination limits, and parameter correctness against the IEEE docs.
 */

import fs from "node:fs";
import path from "node:path";

import {
  byId,
  createReporter,
  defaultTarget,
  describeTarget,
  freshDir,
  mcpBatch,
  session,
  toolCall,
  toolJson,
} from "./harness.mjs";
import { startMockServer } from "./mock-ieee-server.mjs";

const API_KEY = "0123456789abcdef0123456789abcdef";

function baseEnv(mock, stateDir, extra = {}) {
  return {
    IEEE_API_KEY: API_KEY,
    IEEE_API_BASE: mock.baseUrl,
    IEEE_MCP_STATE_DIR: stateDir,
    IEEE_LOG_LEVEL: "warn",
    IEEE_DAILY_BUDGET: "200",
    ...extra,
  };
}

export async function run() {
  const reporter = createReporter("search");
  const target = defaultTarget();
  reporter.note(`target: ${describeTarget()}`);
  const mock = await startMockServer();

  try {
    // ── pagination boundary: 26 total, 25 returned ────────────────────────────
    reporter.section("pagination boundary (total 26, page size 25)");
    const pageDir = freshDir("search-page");
    mock.state.requests.length = 0;
    const pageRun = await mcpBatch(target, {
      label: "search-page",
      env: baseEnv(mock, pageDir),
      requests: session([
        toolCall(2, "search_papers", { querytext: "beamforming", max_records: 25 }),
        toolCall(3, "search_papers", { querytext: "beamforming", max_records: 25, start_record: 26 }),
      ]),
    });

    const firstPage = toolJson(byId(pageRun.responses, 2));
    reporter.check("first page call succeeded", firstPage !== null && firstPage.returned_records !== undefined, byId(pageRun.responses, 2)?.result?.content?.[0]?.text?.slice(0, 300));
    reporter.equal("total_records reported", firstPage?.total_records, 26);
    reporter.equal("first page record count", firstPage?.returned_records, 25);
    reporter.equal("first page last_returned_index", firstPage?.pagination?.last_returned_index, 25);
    // This is the exact reported bug: 25 returned out of 26 must advertise a next page.
    reporter.equal("has_more is true when 25 of 26 are returned", firstPage?.pagination?.has_more, true);
    reporter.equal("next_start_record is 26", firstPage?.pagination?.next_start_record, 26);
    reporter.equal("pagination mode is single", firstPage?.pagination?.mode, "single");
    reporter.check(
      "a next-page hint is present in warnings",
      (firstPage?.warnings ?? []).some((warning) => warning.includes("start_record=26")),
      JSON.stringify(firstPage?.warnings)
    );

    const secondPage = toolJson(byId(pageRun.responses, 3));
    reporter.equal("second page record count", secondPage?.returned_records, 1);
    reporter.equal("second page has_more is false", secondPage?.pagination?.has_more, false);
    reporter.equal("second page next_start_record is null", secondPage?.pagination?.next_start_record, null);
    reporter.equal(
      "pages do not overlap",
      secondPage?.articles?.[0]?.article_number !== firstPage?.articles?.[0]?.article_number,
      true
    );

    // ── record completeness and explicit missing fields ───────────────────────
    reporter.section("normalized record fields");
    const first = firstPage?.articles?.[0];
    reporter.check("title present", typeof first?.title === "string" && first.title.length > 0, JSON.stringify(first?.title));
    reporter.check("authors present with affiliations", (first?.authors ?? []).length === 2 && Boolean(first.authors[0].affiliation));
    reporter.check("author_names joined", typeof first?.author_names === "string" && first.author_names.includes("; "), first?.author_names);
    reporter.check("year present", /^\d{4}$/.test(first?.year ?? ""), first?.year);
    reporter.check("publication_title present", typeof first?.publication_title === "string", first?.publication_title);
    reporter.check("abstract present", typeof first?.abstract === "string" && first.abstract.length > 40);
    reporter.check("doi present", typeof first?.doi === "string" && first.doi.startsWith("10.1109/"), first?.doi);
    reporter.check("doi_url derived", first?.doi_url?.startsWith("https://doi.org/10.1109/"), first?.doi_url);
    reporter.check("article_number present", first?.article_number === "1000001", first?.article_number);
    reporter.check("abstract_url present", first?.abstract_url?.includes("ieeexplore.ieee.org"), first?.abstract_url);
    reporter.check("pdf_url present when IEEE provides one", first?.pdf_url === null || typeof first.pdf_url === "string", first?.pdf_url);
    reporter.equal("source label", first?.source, "IEEE Xplore");
    reporter.check(
      "author keywords extracted",
      (first?.keywords?.author_terms ?? []).length === 3,
      JSON.stringify(first?.keywords)
    );
    reporter.check(
      "IEEE terms extracted",
      (first?.keywords?.ieee_terms ?? []).length === 3,
      JSON.stringify(first?.keywords?.ieee_terms)
    );
    reporter.check(
      "MeSH terms extracted",
      (first?.keywords?.mesh_terms ?? []).length === 2,
      JSON.stringify(first?.keywords?.mesh_terms)
    );
    reporter.equal("complete record reports no missing fields", first?.missing_fields?.length, 0);
    reporter.equal("search scope is metadata, not full text", firstPage?.search_scope, "metadata_and_abstract");

    const incomplete = (firstPage?.articles ?? []).find((record) => record.article_number === "1000007");
    reporter.check("record without abstract/doi is present in the page", Boolean(incomplete), "article 1000007 not found");
    reporter.check(
      "missing fields are reported explicitly",
      (incomplete?.missing_fields ?? []).includes("abstract") && (incomplete?.missing_fields ?? []).includes("doi"),
      JSON.stringify(incomplete?.missing_fields)
    );
    reporter.equal("absent abstract is null, never invented", incomplete?.abstract, null);
    reporter.equal("absent doi is null, never invented", incomplete?.doi, null);
    reporter.equal("absent doi_url is null", incomplete?.doi_url, null);
    reporter.check(
      "non-ASCII titles survive round-trip",
      (firstPage?.articles ?? []).some((record) => /[\u4e00-\u9fff]/.test(record.title ?? "")),
      JSON.stringify((firstPage?.articles ?? []).map((record) => record.title).slice(0, 6))
    );

    // ── cache behaviour ──────────────────────────────────────────────────────
    reporter.section("cache");
    mock.state.requests.length = 0;
    const cacheDir = freshDir("search-cache");
    const cacheRun = await mcpBatch(target, {
      label: "search-cache",
      env: baseEnv(mock, cacheDir),
      requests: session([
        toolCall(2, "search_papers", { querytext: "cachetest" }),
        toolCall(3, "search_papers", { querytext: "cachetest" }),
        toolCall(4, "search_papers", { querytext: "cachetest", no_cache: true }),
      ]),
    });
    const coldCall = toolJson(byId(cacheRun.responses, 2));
    const second = toolJson(byId(cacheRun.responses, 3));
    const bypass = toolJson(byId(cacheRun.responses, 4));
    reporter.equal("cold call is a cache miss", coldCall?.cache?.hit, false);
    reporter.equal("repeat call is a cache hit", second?.cache?.hit, true);
    reporter.equal("no_cache bypasses the cache", bypass?.cache?.hit, false);
    reporter.equal("only two HTTP requests were made (1 cold + 1 bypass)", mock.state.requests.length, 2);
    reporter.check("cache files were written", fs.existsSync(path.join(cacheDir, "cache")), cacheDir);

    // Cache must survive a process restart and then honour TTL expiry.
    mock.state.requests.length = 0;
    const warmRun = await mcpBatch(target, {
      label: "search-cache-warm",
      env: baseEnv(mock, cacheDir),
      requests: session([toolCall(2, "search_papers", { querytext: "cachetest" })]),
    });
    reporter.equal("cache survives process restart", toolJson(byId(warmRun.responses, 2))?.cache?.hit, true);
    reporter.equal("restart used no HTTP request", mock.state.requests.length, 0);

    const cacheFiles = fs.readdirSync(path.join(cacheDir, "cache")).filter((name) => name.endsWith(".json"));
    reporter.check("cache directory holds entries", cacheFiles.length > 0, JSON.stringify(cacheFiles));
    for (const name of cacheFiles) {
      const file = path.join(cacheDir, "cache", name);
      const entry = JSON.parse(fs.readFileSync(file, "utf8"));
      entry.expires_ms = Date.now() - 1000;
      fs.writeFileSync(file, JSON.stringify(entry), "utf8");
    }
    mock.state.requests.length = 0;
    const expiredRun = await mcpBatch(target, {
      label: "search-cache-expired",
      env: baseEnv(mock, cacheDir),
      requests: session([toolCall(2, "search_papers", { querytext: "cachetest" })]),
    });
    reporter.equal("expired entry is not served", toolJson(byId(expiredRun.responses, 2))?.cache?.hit, false);
    reporter.equal("expired entry triggers a real request", mock.state.requests.length, 1);

    mock.state.requests.length = 0;
    const noCacheDir = freshDir("search-nocache");
    await mcpBatch(target, {
      label: "search-cache-off",
      env: baseEnv(mock, noCacheDir, { IEEE_CACHE_TTL_SECONDS: "0" }),
      requests: session([
        toolCall(2, "search_papers", { querytext: "cacheoff" }),
        toolCall(3, "search_papers", { querytext: "cacheoff" }),
      ]),
    });
    reporter.equal("cache disabled via TTL=0 issues both requests", mock.state.requests.length, 2);

    // ── multi-query merge + dedup ────────────────────────────────────────────
    reporter.section("multi-query merge and dedup");
    mock.state.requests.length = 0;
    const dedupeRun = await mcpBatch(target, {
      label: "search-dedupe",
      env: baseEnv(mock, freshDir("search-dedupe")),
      requests: session([
        toolCall(2, "search_papers", { queries: ["DUPA", "DUPB"], max_records: 25 }),
      ]),
    });
    const merged = toolJson(byId(dedupeRun.responses, 2));
    reporter.equal("merged result holds 5 unique records", merged?.returned_records, 5);
    reporter.equal("duplicates removed", merged?.dedup?.duplicates_removed, 5);
    reporter.check(
      "dedup matched on doi and/or article_number",
      (merged?.dedup?.matched_on ?? []).some((kind) => kind === "doi" || kind === "article_number"),
      JSON.stringify(merged?.dedup)
    );
    reporter.equal("merged pagination mode", merged?.pagination?.mode, "merged");
    reporter.equal("two requests were issued", mock.state.requests.length, 2);
    reporter.check(
      "merged records were back-filled from the duplicate copy",
      (merged?.articles ?? []).length === 5 &&
        (merged?.articles ?? []).every(
          (record) =>
            Boolean(record.abstract) &&
            Boolean(record.doi) &&
            Boolean(record.abstract_url) &&
            record.keywords.ieee_terms.length > 0
        ),
      JSON.stringify(
        (merged?.articles ?? []).map((record) => ({
          abstract: Boolean(record.abstract),
          doi: Boolean(record.doi),
          abstract_url: Boolean(record.abstract_url),
          terms: record.keywords.ieee_terms.length,
        }))
      )
    );
    reporter.check(
      "merged result warns that total_records is not meaningful",
      (merged?.warnings ?? []).some((warning) => warning.includes("union of queries")),
      JSON.stringify(merged?.warnings)
    );
    reporter.equal("per_query has one entry per query", merged?.per_query?.length, 2);

    // ── auto pagination with limits ──────────────────────────────────────────
    reporter.section("auto pagination limits");
    mock.state.requests.length = 0;
    const autoRun = await mcpBatch(target, {
      label: "search-auto",
      env: baseEnv(mock, freshDir("search-auto")),
      requests: session([
        toolCall(2, "search_papers", {
          querytext: "radar",
          max_records: 25,
          auto_paginate: true,
          max_total_records: 30,
          max_requests: 5,
        }),
        toolCall(3, "search_papers", {
          querytext: "radar2",
          max_records: 25,
          auto_paginate: true,
          max_total_records: 10,
          max_requests: 5,
        }),
        toolCall(4, "search_papers", {
          querytext: "radar3",
          max_records: 25,
          auto_paginate: true,
          max_total_records: 30,
          max_requests: 1,
        }),
      ]),
    });
    const auto = toolJson(byId(autoRun.responses, 2));
    reporter.equal("auto pagination collected all 26 records", auto?.returned_records, 26);
    reporter.equal("auto pagination fetched 2 pages", auto?.pagination?.pages_fetched, 2);
    reporter.equal("auto pagination exhausted results", auto?.pagination?.has_more, false);

    const capped = toolJson(byId(autoRun.responses, 3));
    reporter.equal("max_total_records caps the result set", capped?.returned_records, 10);
    reporter.check(
      "capping is reported",
      (capped?.warnings ?? []).some((warning) => warning.includes("max_total_records")),
      JSON.stringify(capped?.warnings)
    );

    const limited = toolJson(byId(autoRun.responses, 4));
    reporter.equal("max_requests=1 fetches a single page", limited?.pagination?.pages_fetched, 1);
    reporter.equal("max_requests=1 still advertises more", limited?.pagination?.has_more, true);
    reporter.equal("max_requests=1 hit the API exactly once overall", mock.state.requests.length, 4);

    // ── parameter correctness against the IEEE docs ──────────────────────────
    reporter.section("documented parameter handling");
    mock.state.requests.length = 0;
    const paramRun = await mcpBatch(target, {
      label: "search-params",
      env: baseEnv(mock, freshDir("search-params")),
      requests: session([
        toolCall(2, "search_papers", {
          querytext: "antenna array",
          content_type: "Conferences",
          open_access: true,
          start_year: "2020",
          end_year: "2024",
          sort_field: "article_title",
          sort_order: "asc",
          max_records: 5,
        }),
        toolCall(3, "search_papers", { doi: "10.1109/TEST.2024.1001", querytext: "should be ignored" }),
        toolCall(4, "search_papers", { content_type: "conference" }),
        toolCall(5, "search_papers", { sort_field: "publication_year" }),
        toolCall(6, "search_papers", { querytext: "x", author: "Zh*" }),
      ]),
    });

    const paramRequest = mock.state.requests[0];
    reporter.equal("content_type is sent verbatim", paramRequest?.params?.content_type, "Conferences");
    reporter.equal("open_access uses IEEE's documented casing", paramRequest?.params?.open_access, "True");
    reporter.equal("start_year is forwarded", paramRequest?.params?.start_year, "2020");
    reporter.equal("end_year is forwarded", paramRequest?.params?.end_year, "2024");
    reporter.equal("sort_field is forwarded", paramRequest?.params?.sort_field, "article_title");
    reporter.equal("sort_order is forwarded", paramRequest?.params?.sort_order, "asc");
    reporter.equal("max_records is forwarded", paramRequest?.params?.max_records, "5");
    reporter.equal(
      "spaces are encoded as %20 rather than '+'",
      paramRequest?.rawUrl?.includes("querytext=antenna%20array"),
      true
    );
    reporter.check("apikey was sent", typeof paramRequest?.apikey === "string" && paramRequest.apikey.length > 0);
    reporter.check("a User-Agent was sent", typeof paramRequest?.userAgent === "string" && paramRequest.userAgent.includes("ieee-mcp"));

    const doiPayload = toolJson(byId(paramRun.responses, 3));
    const doiRequest = mock.state.requests[1];
    reporter.equal(
      "doi lookup sends only doi",
      Object.keys(doiRequest?.params ?? {})
        .filter((key) => !["max_records", "start_record", "apikey"].includes(key))
        .join(","),
      "doi"
    );
    reporter.check(
      "doi exclusivity is explained",
      (doiPayload?.warnings ?? []).some((warning) => warning.includes("ignores")),
      JSON.stringify(doiPayload?.warnings)
    );

    reporter.check("invalid content_type casing is rejected", byId(paramRun.responses, 4)?.result?.isError === true, JSON.stringify(byId(paramRun.responses, 4)?.result).slice(0, 300));
    reporter.check(
      "undocumented sort_field (publication_year) is rejected",
      byId(paramRun.responses, 5)?.result?.isError === true,
      JSON.stringify(byId(paramRun.responses, 5)?.result).slice(0, 300)
    );
    reporter.check(
      "author wildcard shorter than 3 chars is rejected",
      byId(paramRun.responses, 6)?.result?.isError === true,
      JSON.stringify(byId(paramRun.responses, 6)?.result).slice(0, 300)
    );
  } finally {
    await mock.close();
  }

  return reporter.summary();
}
