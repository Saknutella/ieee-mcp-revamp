/**
 * Real IEEE API verification, deliberately tiny.
 *
 * Runs the packaged executable against the OFFICIAL endpoint with a hard local
 * budget, and reports exactly how many HTTP attempts were made. The API key is
 * read from IEEE_API_KEY or IEEE_API_KEY_FILE and is never printed.
 *
 *   $env:IEEE_API_KEY_FILE="D:\.ieee-key.local"
 *   $env:IEEE_SMOKE_QUERY="radar beamforming"
 *   node test/real-api-smoke.mjs
 *
 * Optional:
 *   IEEE_SMOKE_MAX_RECORDS   records per request (default 5)
 *   IEEE_SMOKE_PUBLICATION   restrict to one publication
 *   IEEE_SMOKE_START_YEAR / IEEE_SMOKE_END_YEAR
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

process.stdout.write(`ieee-mcp real API smoke test\n`);
process.stdout.write(`  target : ${describeTarget()}\n`);
process.stdout.write(`  key    : from ${source} (fingerprint not printed)\n`);
process.stdout.write(`  query  : ${QUERY}\n`);
process.stdout.write(`  budget : ${BUDGET} local calls max\n\n`);

const searchArgs = { querytext: QUERY, max_records: MAX_RECORDS, output_format: "json" };
if (process.env.IEEE_SMOKE_PUBLICATION) searchArgs.publication_title = process.env.IEEE_SMOKE_PUBLICATION;
if (process.env.IEEE_SMOKE_START_YEAR) searchArgs.start_year = process.env.IEEE_SMOKE_START_YEAR;
if (process.env.IEEE_SMOKE_END_YEAR) searchArgs.end_year = process.env.IEEE_SMOKE_END_YEAR;

// ── Phase 1: search, repeat (cache), status ──────────────────────────────────
const phase1 = await mcpBatch(target, {
  label: "real-api-phase1",
  env,
  timeoutMs: 180_000,
  requests: session([
    toolCall(2, "search_papers", searchArgs),
    toolCall(3, "search_papers", searchArgs), // must be served from cache: 0 extra calls
    toolCall(4, "ieee_status", {}),
  ]),
});

const search1 = toolJson(byId(phase1.responses, 2));
const search2 = toolJson(byId(phase1.responses, 3));
const status1 = toolJson(byId(phase1.responses, 4));

if (!search1 || search1.ok === false) {
  process.stdout.write("SEARCH FAILED\n");
  process.stdout.write(`${byId(phase1.responses, 2)?.result?.content?.[0]?.text}\n`);
  process.stdout.write(`\nstderr tail:\n${phase1.stderr.slice(-2000)}\n`);
  process.exit(1);
}

const articles = search1.articles ?? [];
const first = articles[0] ?? null;

process.stdout.write(`search #1: total_records=${search1.total_records} returned=${search1.returned_records} ` +
  `has_more=${search1.pagination?.has_more} next=${search1.pagination?.next_start_record}\n`);
process.stdout.write(`search #2 cache hit: ${search2?.cache?.hit}\n`);
process.stdout.write(`http attempts after phase 1: ${status1?.process?.http_attempts} (retries ${status1?.process?.retries})\n\n`);

if (articles.length === 0) {
  process.stdout.write("WARNING: the query returned no records; skipping the detail phase.\n");
}

// ── Phase 2: detail lookup + export ──────────────────────────────────────────
let phase2 = null;
let detail = null;
if (first) {
  const identifier = first.doi ? { doi: first.doi } : first.article_number ? { article_number: first.article_number } : null;
  const requests = session(
    [
      ...(identifier ? [toolCall(2, "get_paper_details", identifier)] : []),
      toolCall(3, "export_results", { search_id: search1.search_id, format: "csv", output_path: "real-api-export.csv" }),
      toolCall(4, "ieee_status", {}),
    ],
    2
  );
  phase2 = await mcpBatch(target, { label: "real-api-phase2", env, timeoutMs: 180_000, requests });
  detail = identifier ? toolJson(byId(phase2.responses, 2)) : null;
  process.stdout.write(
    `detail lookup (${identifier ? Object.keys(identifier)[0] : "skipped"}): ` +
      `${detail ? `${detail.returned_records} record(s)` : "n/a"}\n`
  );
  const exportOutcome = toolJson(byId(phase2.responses, 3));
  process.stdout.write(`export: ${exportOutcome?.output_path ?? "(failed)"} (${exportOutcome?.bytes ?? 0} bytes)\n`);
}

const status2 = toolJson(byId((phase2 ?? phase1).responses, phase2 ? 4 : 4));

// ── Record sample ────────────────────────────────────────────────────────────
process.stdout.write("\nfirst record:\n");
if (first) {
  const sample = {
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
  };
  process.stdout.write(`${JSON.stringify(sample, null, 2)}\n`);
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
  has_more: search1.pagination?.has_more,
  next_start_record: search1.pagination?.next_start_record,
  cache_hit_on_repeat: search2?.cache?.hit ?? null,
  http_attempts_total: status2?.process?.http_attempts ?? null,
  retries_total: status2?.process?.retries ?? null,
  cache_hits_total: status2?.process?.cache_hits ?? null,
  local_calls_utc_day: status2?.local_usage?.local_calls_utc_day ?? null,
  first_record: first
    ? {
        article_number: first.article_number,
        doi: first.doi,
        title: first.title,
        missing_fields: first.missing_fields,
      }
    : null,
};

const outFile = path.join(REPO_ROOT, "build", "real-api-run.json");
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

process.stdout.write("\n-----------------------------------------\n");
process.stdout.write(`HTTP attempts (all phases): ${summary.http_attempts_total}\n`);
process.stdout.write(`retries: ${summary.retries_total}\n`);
process.stdout.write(`cache hits: ${summary.cache_hits_total}\n`);
process.stdout.write(`local calls in UTC day: ${summary.local_calls_utc_day} / budget ${BUDGET}\n`);
process.stdout.write(`summary written to ${outFile}\n`);

const leaked = `${phase1.stdout}${phase1.stderr}${phase2?.stdout ?? ""}${phase2?.stderr ?? ""}`.includes(key);
process.stdout.write(leaked ? "REDACTION CHECK: FAILED (key found in output)\n" : "REDACTION CHECK: OK (key absent from stdout and stderr)\n");
process.exit(leaked ? 1 : 0);
