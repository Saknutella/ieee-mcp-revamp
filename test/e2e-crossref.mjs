/**
 * Crossref reference lookup (`get_references`) end-to-end checks.
 *
 * Verifies the three things the feature must never obscure: that the source is
 * labelled Crossref rather than IEEE, that the response carries an explicit
 * verification requirement, and that these lookups leave the IEEE budget alone.
 */

import {
  byId,
  createReporter,
  defaultTarget,
  describeTarget,
  freshDir,
  mcpBatch,
  paramKeys,
  session,
  toolCall,
  toolJson,
  toolText,
} from "./harness.mjs";
import { startMockServer } from "./mock-ieee-server.mjs";
import { startMockCrossrefServer, MISSING_MARKER } from "./mock-crossref-server.mjs";

const API_KEY = "0123456789abcdef0123456789abcdef";
const MAILTO = "researcher@example.org";

function baseEnv(ieeeMock, crossrefMock, stateDir, extra = {}) {
  return {
    IEEE_API_KEY: API_KEY,
    IEEE_API_BASE: ieeeMock.baseUrl,
    CROSSREF_API_BASE: crossrefMock.baseUrl,
    CROSSREF_MAILTO: MAILTO,
    IEEE_MCP_STATE_DIR: stateDir,
    IEEE_LOG_LEVEL: "warn",
    IEEE_DAILY_BUDGET: "200",
    ...extra,
  };
}

export async function run() {
  const reporter = createReporter("crossref");
  const target = defaultTarget();
  reporter.note(`target: ${describeTarget()}`);
  const ieeeMock = await startMockServer();
  const crossrefMock = await startMockCrossrefServer();

  try {
    // ── tool surface ─────────────────────────────────────────────────────────
    reporter.section("tool surface");
    const stateDir = freshDir("crossref");
    const listRun = await mcpBatch(target, {
      label: "crossref-list",
      env: baseEnv(ieeeMock, crossrefMock, stateDir),
      requests: session([
        { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      ]),
    });
    const tools = byId(listRun.responses, 2)?.result?.tools ?? [];
    const refTool = tools.find((tool) => tool.name === "get_references");
    reporter.check("get_references is registered", Boolean(refTool), JSON.stringify(tools.map((t) => t.name)));
    reporter.check(
      "its description states the source is Crossref, not IEEE",
      /CROSSREF,\s*NOT IEEE/i.test(refTool?.description ?? ""),
      refTool?.description
    );
    reporter.check(
      "its description tells the caller to verify",
      /verif/i.test(refTool?.description ?? ""),
      refTool?.description
    );
    reporter.check(
      "its description says the IEEE budget is untouched",
      /do NOT consume the IEEE daily budget/i.test(refTool?.description ?? ""),
      refTool?.description
    );

    // ── single DOI, references with and without a DOI ────────────────────────
    reporter.section("single DOI lookup");
    crossrefMock.state.requests.length = 0;
    const oneRun = await mcpBatch(target, {
      label: "crossref-one",
      env: baseEnv(ieeeMock, crossrefMock, stateDir),
      requests: session([
        toolCall(2, "get_references", { dois: ["10.1109/mock.tcsii.2021"] }),
      ]),
    });
    const one = toolJson(byId(oneRun.responses, 2));
    reporter.check("single DOI lookup succeeds", one?.ok === true, toolText(byId(oneRun.responses, 2))?.slice(0, 300));
    reporter.equal("source is labelled Crossref", one?.source, "Crossref REST API");
    reporter.equal("source_is_ieee is false", one?.source_is_ieee, false);
    reporter.equal("verification_required is true", one?.provenance?.verification_required, true);
    reporter.check(
      "provenance says this is not IEEE metadata",
      /not IEEE metadata|NOT from IEEE Xplore/i.test(one?.provenance?.what_this_is_not ?? ""),
      one?.provenance?.what_this_is_not
    );
    reporter.check(
      "provenance warns against mixing reference and citation metrics",
      /incoming|outgoing/i.test(one?.provenance?.metric_warning ?? ""),
      one?.provenance?.metric_warning
    );
    reporter.equal("one paper requested", one?.requested, 1);
    reporter.equal("one paper succeeded", one?.succeeded, 1);
    reporter.equal("fourteen references returned", one?.totals?.references, 14);
    reporter.equal("ten references carry a DOI", one?.totals?.with_doi, 10);
    reporter.equal("four references lack a DOI", one?.totals?.without_doi, 4);
    reporter.check(
      "a warning explains the DOI-less references",
      (one?.warnings ?? []).some((warning) => warning.includes("without a DOI")),
      JSON.stringify(one?.warnings)
    );

    const paper = one?.papers?.[0];
    reporter.equal("Crossref references-count is reported", paper?.references_count_from_crossref, 14);
    reporter.equal("counts agree", paper?.counts_agree, true);
    reporter.check("crossref_url points at the work endpoint", paper?.crossref_url?.includes("/works/"), paper?.crossref_url);
    reporter.check("doi.org verification link present", paper?.verify?.doi === "https://doi.org/10.1109/mock.tcsii.2021", paper?.verify?.doi);
    reporter.equal("no IEEE link when no search_id was used", paper?.verify?.ieee_xplore, null);
    reporter.check(
      "reference keys preserve in-paper numbering",
      paper?.references?.[0]?.key === "ref1" && paper?.references?.[13]?.key === "ref14",
      JSON.stringify(paper?.references?.map((r) => r.key))
    );
    reporter.check(
      "references are re-sorted into citation order despite Crossref's deposit order",
      JSON.stringify(paper?.references?.map((entry) => entry.order)) ===
        JSON.stringify(Array.from({ length: 14 }, (_, i) => i + 1)),
      JSON.stringify(paper?.references?.map((entry) => entry.key))
    );
    reporter.check(
      "DOI-less references still carry title/author/year",
      paper?.references?.[2]?.doi === null &&
        Boolean(paper.references[2].title) &&
        Boolean(paper.references[2].author) &&
        Boolean(paper.references[2].year),
      JSON.stringify(paper?.references?.[2])
    );
    // A very common IEEE deposit: a reference with a DOI and nothing else.
    const doiOnly = (paper?.references ?? []).find((entry) => entry.has_doi && !entry.title && !entry.author);
    reporter.check("the fixture includes a DOI-only reference", Boolean(doiOnly), JSON.stringify(paper?.references?.map((r) => ({ d: r.doi, t: r.title }))));
    reporter.check(
      "a DOI-only reference is emitted with an explanatory note, not an empty entry",
      /note = \{Crossref deposited only a DOI/.test(doiOnly?.bibtex ?? ""),
      doiOnly?.bibtex
    );
    reporter.check(
      "no IEEE call was made for this lookup",
      ieeeMock.state.requests.length === 0,
      `${ieeeMock.state.requests.length} IEEE requests`
    );
    reporter.equal("Crossref usage reports zero IEEE budget use", one?.usage?.ieee_calls_consumed, 0);
    reporter.check(
      "polite pool: the User-Agent carries the contact address",
      crossrefMock.state.requests.every((request) => (request.userAgent ?? "").includes(MAILTO)),
      JSON.stringify(crossrefMock.state.requests.map((r) => r.userAgent))
    );
    reporter.check(
      "requests ask for JSON",
      crossrefMock.state.requests.every((request) => (request.accept ?? "").includes("application/json")),
      JSON.stringify(crossrefMock.state.requests.map((r) => r.accept))
    );

    // ── caching ──────────────────────────────────────────────────────────────
    reporter.section("caching");
    crossrefMock.state.requests.length = 0;
    const cacheRun = await mcpBatch(target, {
      label: "crossref-cache",
      env: baseEnv(ieeeMock, crossrefMock, stateDir),
      requests: session([
        toolCall(2, "get_references", { dois: ["10.1109/mock.tcsii.2021"] }),
      ]),
    });
    reporter.equal("a repeated lookup hits no Crossref endpoint", crossrefMock.state.requests.length, 0);
    reporter.check(
      "the cached result is marked",
      toolJson(byId(cacheRun.responses, 2))?.usage?.crossref_cache_hits >= 1,
      JSON.stringify(toolJson(byId(cacheRun.responses, 2))?.usage)
    );
    reporter.equal("cached lookup still returns 14 references", toolJson(byId(cacheRun.responses, 2))?.totals?.references, 14);

    // ── multiple DOIs, one of them missing ───────────────────────────────────
    reporter.section("multiple DOIs with a partial failure");
    crossrefMock.state.requests.length = 0;
    const multiRun = await mcpBatch(target, {
      label: "crossref-multi",
      env: baseEnv(ieeeMock, crossrefMock, freshDir("crossref-multi")),
      requests: session([
        toolCall(2, "get_references", {
          dois: ["10.1109/mock.tcsii.2021", `${MISSING_MARKER}.refs`, "10.1109/mock.esscirc.2019"],
        }),
      ]),
    });
    const multi = toolJson(byId(multiRun.responses, 2));
    reporter.equal("three papers requested", multi?.requested, 3);
    reporter.equal("two papers succeeded", multi?.succeeded, 2);
    reporter.equal("one paper failed", multi?.failed, 1);
    reporter.equal("total references across papers", multi?.totals?.references, 21);
    const failedPaper = multi?.papers?.find((entry) => !entry.ok);
    reporter.equal("the missing DOI reports NOT_FOUND", failedPaper?.error?.code, "NOT_FOUND");
    reporter.check(
      "the failure keeps a Crossref URL for inspection",
      failedPaper?.crossref_url?.includes("/works/") && failedPaper.crossref_url.includes("10.9999"),
      failedPaper?.crossref_url
    );
    reporter.check("the other two still returned data", multi?.papers?.filter((entry) => entry.ok).length === 2);

    // ── zero references and count mismatch ───────────────────────────────────
    reporter.section("edge cases");
    const edgeRun = await mcpBatch(target, {
      label: "crossref-edge",
      env: baseEnv(ieeeMock, crossrefMock, freshDir("crossref-edge")),
      requests: session([
        toolCall(2, "get_references", { dois: ["10.1109/mock.norefs"] }),
        toolCall(3, "get_references", { dois: ["10.1109/mock.mismatch"] }),
      ]),
    });
    const noRefs = toolJson(byId(edgeRun.responses, 2));
    reporter.equal("a paper with no references returns zero", noRefs?.totals?.references, 0);
    reporter.check("zero-reference lookup still succeeds", noRefs?.ok === true);
    reporter.equal("counts agree at zero", noRefs?.papers?.[0]?.counts_agree, true);

    const mismatch = toolJson(byId(edgeRun.responses, 3));
    reporter.equal("mismatch: Crossref count field", mismatch?.papers?.[0]?.references_count_from_crossref, 9);
    reporter.equal("mismatch: array length", mismatch?.papers?.[0]?.references_returned, 3);
    reporter.equal("mismatch is flagged", mismatch?.papers?.[0]?.counts_agree, false);
    reporter.check(
      "mismatch produces a warning",
      (mismatch?.warnings ?? []).some((warning) => warning.includes("references-count=9")),
      JSON.stringify(mismatch?.warnings)
    );

    // ── BibTeX modes ─────────────────────────────────────────────────────────
    reporter.section("BibTeX");
    const bibDir = freshDir("crossref-bibtex");

    // Phase 1: modes that must NOT fetch authoritative BibTeX. Kept in its own
    // batch so the request log cannot be polluted by the content-negotiation phase.
    crossrefMock.state.requests.length = 0;
    const noFetchRun = await mcpBatch(target, {
      label: "crossref-bibtex-nofetch",
      env: baseEnv(ieeeMock, crossrefMock, bibDir),
      requests: session([
        toolCall(2, "get_references", { dois: ["10.1109/mock.esscirc.2019"], bibtex_mode: "generated" }),
        toolCall(3, "get_references", { dois: ["10.1109/mock.esscirc.2019"], bibtex_mode: "none" }),
        toolCall(4, "get_references", { dois: ["10.1109/mock.esscirc.2019"], output_format: "bibtex" }),
        toolCall(5, "get_references", { dois: ["10.1109/mock.esscirc.2019"], output_format: "markdown" }),
      ]),
    });

    const generated = toolJson(byId(noFetchRun.responses, 2));
    reporter.equal(
      "generated mode labels the source",
      generated?.papers?.[0]?.references?.[0]?.bibtex_source,
      "generated_from_crossref_metadata"
    );
    reporter.check(
      "generated BibTeX is a well-formed entry",
      /^@(article|inproceedings|misc)\{[^,]+,/m.test(generated?.papers?.[0]?.references?.[0]?.bibtex ?? ""),
      generated?.papers?.[0]?.references?.[0]?.bibtex
    );
    reporter.check(
      "generated BibTeX contains a title field",
      (generated?.papers?.[0]?.references?.[0]?.bibtex ?? "").includes("title = {"),
      generated?.papers?.[0]?.references?.[0]?.bibtex
    );
    reporter.equal(
      "no phase-1 mode triggered an authoritative BibTeX fetch",
      crossrefMock.state.requests.filter((request) => request.transform).length,
      0
    );

    // Phase 2: content negotiation, one request per DOI-bearing reference.
    crossrefMock.state.requests.length = 0;
    const authoritativeRun = await mcpBatch(target, {
      label: "crossref-bibtex-authoritative",
      env: baseEnv(ieeeMock, crossrefMock, bibDir),
      requests: session([
        toolCall(2, "get_references", { dois: ["10.1109/mock.esscirc.2019"], bibtex_mode: "crossref" }),
      ]),
    });
    const authoritative = toolJson(byId(authoritativeRun.responses, 2));
    const authoritativeSources = (authoritative?.papers?.[0]?.references ?? []).map((entry) => entry.bibtex_source);
    reporter.check(
      "crossref mode uses content negotiation for DOI-bearing references",
      authoritativeSources.filter((source) => source === "crossref_content_negotiation").length === 6,
      JSON.stringify(authoritativeSources)
    );
    reporter.check(
      "crossref mode falls back to generated for the DOI-less reference",
      authoritativeSources.includes("generated_from_crossref_metadata"),
      JSON.stringify(authoritativeSources.slice(-2))
    );
    reporter.check(
      "authoritative BibTeX was actually requested",
      crossrefMock.state.requests.some((request) => request.transform === "application/x-bibtex"),
      JSON.stringify(crossrefMock.state.requests.filter((r) => r.transform).map((r) => r.transform))
    );
    reporter.equal(
      "one content-negotiation request per DOI-bearing reference",
      crossrefMock.state.requests.filter((request) => request.transform).length,
      6
    );

    reporter.equal("none mode omits BibTeX", toolJson(byId(noFetchRun.responses, 3))?.papers?.[0]?.references?.[0]?.bibtex, null);
    const inlineBibtex = toolText(byId(noFetchRun.responses, 4));
    reporter.check("bibtex output format starts with the source banner", inlineBibtex.startsWith("% !!!"), inlineBibtex.slice(0, 120));
    reporter.check("bibtex output names Crossref as the source", inlineBibtex.includes("SOURCE: Crossref REST API"), inlineBibtex.slice(0, 300));
    reporter.check("bibtex output tells the reader to verify", /VERIFY YOURSELF/i.test(inlineBibtex), inlineBibtex.slice(0, 300));
    reporter.check("bibtex output contains entries", /^@/m.test(inlineBibtex), inlineBibtex.slice(0, 500));

    const inlineMarkdown = toolText(byId(noFetchRun.responses, 5));
    reporter.check("markdown output carries the banner", inlineMarkdown.includes("SOURCE: Crossref REST API"), inlineMarkdown.slice(0, 200));
    reporter.check("markdown output renders a reference table", inlineMarkdown.includes("| # | DOI | Title |"), inlineMarkdown.slice(0, 1200));
    reporter.check(
      "markdown output shows the count and the metric warning",
      inlineMarkdown.includes("references returned") && inlineMarkdown.includes("Metric warning"),
      inlineMarkdown.slice(0, 1500)
    );

    // ── search_id integration, IEEE verify links, DOI-less records ───────────
    reporter.section("search_id integration");
    // One state directory shared across both processes so the stored result set survives.
    const ieeeStateDir = freshDir("crossref-ieee");
    const ieeeSearchRun = await mcpBatch(target, {
      label: "crossref-ieee-search",
      env: baseEnv(ieeeMock, crossrefMock, ieeeStateDir),
      requests: session([toolCall(2, "search_papers", { querytext: "radar", max_records: 8 })]),
    });
    const searchPayload = toolJson(byId(ieeeSearchRun.responses, 2));
    const searchId = searchPayload?.search_id;
    reporter.check("IEEE search produced a search_id", typeof searchId === "string", String(searchId));
    const recordsWithoutDoi = (searchPayload?.articles ?? []).filter((record) => !record.doi);
    reporter.check(
      "the fixture contains a record without a DOI",
      recordsWithoutDoi.length > 0,
      JSON.stringify((searchPayload?.articles ?? []).map((r) => r.doi))
    );

    const linkedRun = await mcpBatch(target, {
      label: "crossref-from-search",
      env: baseEnv(ieeeMock, crossrefMock, ieeeStateDir),
      requests: session([toolCall(2, "get_references", { search_id: searchId })]),
    });
    const linked = toolJson(byId(linkedRun.responses, 2));
    reporter.check("search_id lookup succeeds", linked?.ok === true, toolText(byId(linkedRun.responses, 2))?.slice(0, 300));
    reporter.equal("all DOI-bearing records were looked up", linked?.requested, (searchPayload?.articles ?? []).length - recordsWithoutDoi.length);
    reporter.check(
      "IEEE Xplore verification links are attached",
      (linked?.papers ?? []).every((entry) => typeof entry.verify?.ieee_xplore === "string" && entry.verify.ieee_xplore.includes("ieeexplore.ieee.org/document/")),
      JSON.stringify((linked?.papers ?? []).map((entry) => entry.verify?.ieee_xplore))
    );
    reporter.check(
      "records without a DOI are reported as skipped",
      (linked?.warnings ?? []).some((warning) => warning.includes("no DOI")),
      JSON.stringify(linked?.warnings)
    );

    // ── the IEEE budget must be untouched ────────────────────────────────────
    reporter.section("IEEE budget isolation");
    const isolateDir = freshDir("crossref-isolate");
    const beforeRun = await mcpBatch(target, {
      label: "crossref-isolate-search",
      env: baseEnv(ieeeMock, crossrefMock, isolateDir),
      requests: session([toolCall(2, "search_papers", { querytext: "isolate", max_records: 2 })]),
    });
    const beforeUsage = toolJson(byId(beforeRun.responses, 2))?.usage?.local_calls_utc_day;
    reporter.equal("one IEEE call consumed by the search", beforeUsage, 1);

    const refsOnlyRun = await mcpBatch(target, {
      label: "crossref-isolate-refs",
      env: baseEnv(ieeeMock, crossrefMock, isolateDir),
      requests: session([
        toolCall(2, "get_references", { dois: ["10.1109/mock.tcsii.2021", "10.1109/mock.esscirc.2019"] }),
        toolCall(3, "ieee_status", {}),
      ]),
    });
    const refsPayload = toolJson(byId(refsOnlyRun.responses, 2));
    reporter.equal("two reference lookups made no IEEE call", refsPayload?.usage?.ieee_calls_consumed, 0);
    reporter.check("Crossref requests were recorded separately", refsPayload?.usage?.crossref_requests >= 2, JSON.stringify(refsPayload?.usage));
    const status = toolJson(byId(refsOnlyRun.responses, 3));
    reporter.equal("the IEEE ledger still shows exactly one call", status?.local_usage?.local_calls_utc_day, 1);
    reporter.check("status reports Crossref separately", status?.crossref?.enabled === true, JSON.stringify(status?.crossref));
    reporter.check(
      "status explains Crossref does not consume the IEEE budget",
      /do NOT consume the IEEE daily budget/i.test(status?.crossref?.role ?? ""),
      status?.crossref?.role
    );

    // ── retries, disabling, and caps ─────────────────────────────────────────
    reporter.section("failures, disabling and caps");
    crossrefMock.state.failures = [{ status: 503, body: "temporarily unavailable", times: 1 }];
    const retryRun = await mcpBatch(target, {
      label: "crossref-retry",
      env: baseEnv(ieeeMock, crossrefMock, freshDir("crossref-retry")),
      requests: session([toolCall(2, "get_references", { dois: ["10.1109/mock.norefs"] })]),
    });
    reporter.check(
      "a transient 503 is retried and then succeeds",
      toolJson(byId(retryRun.responses, 2))?.ok === true,
      toolText(byId(retryRun.responses, 2))?.slice(0, 200)
    );
    crossrefMock.state.failures = [];

    const disabledRun = await mcpBatch(target, {
      label: "crossref-disabled",
      env: baseEnv(ieeeMock, crossrefMock, freshDir("crossref-disabled"), { IEEE_MCP_CROSSREF_ENABLED: "0" }),
      requests: session([toolCall(2, "get_references", { dois: ["10.1109/mock.tcsii.2021"] })]),
    });
    reporter.check("disabling Crossref turns the tool into an error", byId(disabledRun.responses, 2)?.result?.isError === true);
    reporter.check(
      "the disabled error explains the switch",
      /IEEE_MCP_CROSSREF_ENABLED/.test(toolText(byId(disabledRun.responses, 2))),
      toolText(byId(disabledRun.responses, 2)).slice(0, 300)
    );

    const capRun = await mcpBatch(target, {
      label: "crossref-cap",
      env: baseEnv(ieeeMock, crossrefMock, freshDir("crossref-cap"), { IEEE_MCP_MAX_DOIS_PER_CALL: "2" }),
      requests: session([
        toolCall(2, "get_references", {
          dois: ["10.1109/mock.tcsii.2021", "10.1109/mock.esscirc.2019", "10.1109/mock.norefs", "10.1109/mock.mismatch"],
        }),
      ]),
    });
    const capped = toolJson(byId(capRun.responses, 2));
    reporter.equal("the DOI cap limits the lookup", capped?.requested, 2);
    reporter.check(
      "the cap is reported",
      (capped?.warnings ?? []).some((warning) => warning.includes("IEEE_MCP_MAX_DOIS_PER_CALL")),
      JSON.stringify(capped?.warnings)
    );

    const noInputRun = await mcpBatch(target, {
      label: "crossref-noinput",
      env: baseEnv(ieeeMock, crossrefMock, freshDir("crossref-noinput")),
      requests: session([toolCall(2, "get_references", {})]),
    });
    reporter.check("an empty request is rejected", byId(noInputRun.responses, 2)?.result?.isError === true);
    reporter.check(
      "the rejection explains that Crossref needs a DOI",
      /DOI is required|Provide either/.test(toolText(byId(noInputRun.responses, 2))),
      toolText(byId(noInputRun.responses, 2)).slice(0, 300)
    );

    // ── the IEEE tools still behave ──────────────────────────────────────────
    reporter.section("no regression in the IEEE path");
    const regressionRun = await mcpBatch(target, {
      label: "crossref-regression",
      env: baseEnv(ieeeMock, crossrefMock, freshDir("crossref-regression")),
      requests: session([
        toolCall(2, "search_papers", { querytext: "regression", max_records: 5 }),
        toolCall(3, "get_paper_details", { article_number: "1000001" }),
      ]),
    });
    const searchAgain = toolJson(byId(regressionRun.responses, 2));
    reporter.equal("IEEE search still works", searchAgain?.returned_records, 5);
    reporter.equal("IEEE search scope is unchanged", searchAgain?.search_scope, "metadata_and_abstract");
    reporter.equal("IEEE identifier lookup still works", toolJson(byId(regressionRun.responses, 3))?.returned_records, 1);
    reporter.equal(
      "IEEE identifier lookup still sends only the identifier",
      paramKeys(ieeeMock.state.requests.find((request) => request.params?.article_number === "1000001")),
      "article_number"
    );
  } finally {
    await ieeeMock.close();
    await crossrefMock.close();
  }

  return reporter.summary();
}
