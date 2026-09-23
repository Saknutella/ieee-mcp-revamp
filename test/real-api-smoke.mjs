/**
 * Real IEEE API verification, deliberately tiny.
 *
 * Runs the packaged executable against the OFFICIAL endpoint with a hard local
 * budget and reports exactly how many API calls were consumed. The API key is
 * read from IEEE_API_KEY or IEEE_API_KEY_FILE and is never printed.
 *
 *   $env:IEEE_API_KEY_FILE=".ieee-key.local"
 *   $env:IEEE_SMOKE_QUERY="radar beamforming"
 *   node test/real-api-smoke.mjs
 *
 * Optional:
 *   IEEE_SMOKE_MAX_RECORDS   records per request (default 5)
 *   IEEE_SMOKE_PUBLICATION   restrict to one publication
 *   IEEE_SMOKE_START_YEAR / IEEE_SMOKE_END_YEAR
 *   IEEE_SMOKE_BUDGET        hard local call cap (default 12)
 *   HTTPS_PROXY / NODE_USE_ENV_PROXY  for networks that need a proxy
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { byId, defaultTarget, describeTarget, freshDir, mcpBatch, REPO_ROOT, session, toolCall, toolJson } from "./harness.mjs";

const QUERY = process.env.IEEE_SMOKE_QUERY ?? "radar beamforming";
const MAX_RECORDS = Number(process.env.IEEE_SMOKE_MAX_RECORDS ?? "5");
const BUDGET = Number(process.env.IEEE_SMOKE_BUDGET ?? "12");

function readKey() {
  const direct = process.env.IEEE_API_KEY?.trim();
  if (direct) return { key: direct, source: "IEEE_API_KEY" };
  const file = process.env.IEEE_API_KEY_FILE?.trim();
  if (!file) {
    throw new Error(
      "Set IEEE_API_KEY or IEEE_API_KEY_FILE before running the real-API smoke test. " +
        "Recommended: write the key to a git-ignored file and point IEEE_API_KEY_FILE at it."
    );
  }
  const resolved = path.isAbsolute(file) ? file : path.resolve(REPO_ROOT, file);
  const text = fs.readFileSync(resolved, "utf8").replace(/^\uFEFF/, "");
  const first = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("#"));
  if (!first) throw new Error(`No usable key in ${resolved}`);
  return { key: first, source: `IEEE_API_KEY_FILE(${path.basename(resolved)})` };
}

const { key, source } = readKey();
const target = defaultTarget();
const stateDir = freshDir("real-api");

const env = {
  IEEE_API_KEY: key,
  IEEE_MCP_STATE_DIR: stateDir,
  IEEE_OUTPUT_DIR: stateDir,
  IEEE_DAILY_BUDGET: String(BUDGET),
  IEEE_MAX_RPS: "2",
  IEEE_MAX_RETRIES: "1",
  IEEE_TIMEOUT_MS: "40000",
  IEEE_LOG_LEVEL: "info",
  ...(process.env.HTTPS_PROXY || process.env.HTTP_PROXY ? { NODE_USE_ENV_PROXY: "1" } : {}),
};

process.stdout.write("ieee-mcp real API smoke test\n");
process.stdout.write(`  target : ${describeTarget()}\n`);
process.stdout.write(`  key    : from ${source} (never printed)\n`);
process.stdout.write(`  query  : ${QUERY}\n`);
process.stdout.write(`  budget : ${BUDGET} local calls max\n\n`);

const searchArgs = { querytext: QUERY, max_records: MAX_RECORDS, output_format: "json" };
if (process.env.IEEE_SMOKE_PUBLICATION) searchArgs.publication_title = process.env.IEEE_SMOKE_PUBLICATION;
if (process.env.IEEE_SMOKE_START_YEAR) searchArgs.start_year = process.env.IEEE_SMOKE_START_YEAR;
if (process.env.IEEE_SMOKE_END_YEAR) searchArgs.end_year = process.env.IEEE_SMOKE_END_YEAR;

// ── Phase 1: search, repeat (must be cached), detail lookup, export ───────────
const phase1 = await mcpBatch(target, {
  label: "real-api-phase1",
  env,
  timeoutMs: 240_000,
  requests: session([
    toolCall(2, "search_papers", searchArgs),
    toolCall(3, "search_papers", searchArgs), // must be served from cache: 0 extra calls
  ]),
});

const search1 = toolJson(byId(phase1.responses, 2));
const search2 = toolJson(byId(phase1.responses, 3));

if (!search1 || search1.ok === false) {
  process.stdout.write("SEARCH FAILED\n");
  process.stdout.write(`${byId(phase1.responses, 2)?.result?.content?.[0]?.text}\n`);
  process.stdout.write(`\nstderr tail:\n${phase1.stderr.slice(-2000)}\n`);
  process.exit(1);
}

const articles = search1.articles ?? [];
const first = articles[0] ?? null;

process.stdout.write(
  `search #1: total_records=${search1.total_records} returned=${search1.returned_records} ` +
    `has_more=${search1.pagination?.has_more} next_start_record=${search1.pagination?.next_start_record}\n`
);
process.stdout.write(`search #2 served from cache: ${search2?.cache?.hit}\n`);
process.stdout.write(`search scope: ${search1.search_scope}\n\n`);

// ── Phase 2: identifier lookup + export, then a status-only process ──────────
let phase2 = null;
let detailPayload = null;
let exportOutcome = null;
if (first) {
  const identifier = first.doi
    ? { doi: first.doi }
    : first.article_number
      ? { article_number: first.article_number }
      : null;
  if (identifier) {
    phase2 = await mcpBatch(target, {
      label: "real-api-phase2",
      env,
      timeoutMs: 240_000,
      requests: session([
        toolCall(2, "get_paper_details", identifier),
        toolCall(3, "export_results", { search_id: search1.search_id, format: "csv", output_path: "real-api-export.csv" }),
      ]),
    });
    detailPayload = toolJson(byId(phase2.responses, 2));
    exportOutcome = toolJson(byId(phase2.responses, 3));
    process.stdout.write(
      `detail lookup by ${Object.keys(identifier)[0]}="${Object.values(identifier)[0]}": ` +
        `${detailPayload?.returned_records ?? "n/a"} record(s)\n`
    );
    process.stdout.write(`export: ${exportOutcome?.output_path ?? "(failed)"} (${exportOutcome?.bytes ?? 0} bytes)\n`);
  }
}

// Status comes from its own process so the cross-process ledger is settled; the
// per-process HTTP counters would read 0 in a fresh process, hence the ledger.
const statusRun = await mcpBatch(target, {
  label: "real-api-status",
  env,
  timeoutMs: 60_000,
  requests: session([toolCall(2, "ieee_status", {})]),
});
const status = toolJson(byId(statusRun.responses, 2));

// ── Sample record ────────────────────────────────────────────────────────────
process.stdout.write("\nfirst search record:\n");
if (first) {
  process.stdout.write(
    `${JSON.stringify(
      {
        article_number: first.article_number,
        doi: first.doi,
        title: first.title,
        year: first.year,
        publication_title: first.publication_title,
        content_type: first.content_type,
        authors: first.author_names,
        keywords_author: first.keywords?.author_terms?.slice(0, 3),
        keywords_ieee: first.keywords?.ieee_terms?.slice(0, 3),
        abstract_length: first.abstract ? first.abstract.length : 0,
        abstract_url: first.abstract_url,
        pdf_url: first.pdf_url,
        citing_paper_count: first.citing_paper_count,
        missing_fields: first.missing_fields,
      },
      null,
      2
    )}\n`
  );
}

const summary = {
  ran_at: new Date().toISOString(),
  target: describeTarget(),
  key_source: source,
  query: QUERY,
  max_records: MAX_RECORDS,
  budget: BUDGET,
  total_records: search1.total_records,
  returned_records: search1.returned_records,
  has_more: search1.pagination?.has_more ?? null,
  next_start_record: search1.pagination?.next_start_record ?? null,
  search_scope: search1.search_scope,
  cache_hit_on_repeat: search2?.cache?.hit ?? null,
  api_calls_consumed: status?.local_usage?.local_calls_utc_day ?? null,
  api_calls_rolling_24h: status?.local_usage?.local_calls_rolling_24h ?? null,
  budget_window: status?.local_usage?.budget_window ?? null,
  remaining_local_budget: status?.local_usage?.remaining_local_budget ?? null,
  last_ieee_rate_limit_headers: status?.last_ieee_rate_limit_headers ?? {},
  detail_lookup: detailPayload
    ? {
        returned_records: detailPayload.returned_records,
        article_number: detailPayload.articles?.[0]?.article_number ?? null,
        doi: detailPayload.articles?.[0]?.doi ?? null,
        missing_fields: detailPayload.articles?.[0]?.missing_fields ?? null,
      }
    : null,
  export: exportOutcome
    ? { path: path.basename(exportOutcome.output_path ?? ""), bytes: exportOutcome.bytes, records: exportOutcome.records, sha256: exportOutcome.sha256 }
    : null,
  first_record: first
    ? { article_number: first.article_number, doi: first.doi, title: first.title, missing_fields: first.missing_fields }
    : null,
};

const outFile = path.join(REPO_ROOT, "build", "real-api-run.json");
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

const combined = `${phase1.stdout}${phase1.stderr}${phase2?.stdout ?? ""}${phase2?.stderr ?? ""}${statusRun.stdout}${statusRun.stderr}`;
const leaked = combined.includes(key);

process.stdout.write("\n-----------------------------------------\n");
process.stdout.write(`API calls consumed (cross-process ledger): ${summary.api_calls_consumed} / budget ${BUDGET}\n`);
process.stdout.write(`cache hit on the repeated query: ${summary.cache_hit_on_repeat}\n`);
process.stdout.write(`local budget window: ${summary.budget_window}, remaining: ${summary.remaining_local_budget}\n`);
process.stdout.write(
  `IEEE rate-limit response headers seen: ${JSON.stringify(summary.last_ieee_rate_limit_headers)}\n`
);
process.stdout.write(`summary written to ${outFile}\n`);
process.stdout.write(leaked ? "REDACTION CHECK: FAILED (key found in output)\n" : "REDACTION CHECK: OK (key absent from stdout and stderr)\n");
process.exit(leaked ? 1 : 0);
