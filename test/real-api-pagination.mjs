/**
 * Real-API pagination and multi-query verification.
 *
 * Exercises the behaviours that were broken or missing upstream, against the
 * official endpoint, with a hard local budget:
 *   - page 1 vs page 2 do not overlap and `has_more`/`next_start_record` are right
 *   - auto_paginate assembles several pages within max_total_records
 *   - `queries` merges variants and removes duplicates
 *
 *   $env:IEEE_API_KEY_FILE=".ieee-key.local"
 *   node test/real-api-pagination.mjs
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { byId, defaultTarget, describeTarget, freshDir, mcpBatch, REPO_ROOT, session, toolCall, toolJson } from "./harness.mjs";

const QUERY = process.env.IEEE_SMOKE_QUERY ?? "radar beamforming";
const VARIANTS = (process.env.IEEE_SMOKE_QUERIES ?? "radar beamforming,millimetre wave beamforming")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const BUDGET = Number(process.env.IEEE_SMOKE_BUDGET ?? "14");

function readKey() {
  const direct = process.env.IEEE_API_KEY?.trim();
  if (direct) return direct;
  const file = process.env.IEEE_API_KEY_FILE?.trim();
  if (!file) throw new Error("Set IEEE_API_KEY or IEEE_API_KEY_FILE first.");
  const resolved = path.isAbsolute(file) ? file : path.resolve(REPO_ROOT, file);
  const text = fs.readFileSync(resolved, "utf8").replace(/^\uFEFF/, "");
  const first = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("#"));
  if (!first) throw new Error(`No usable key in ${resolved}`);
  return first;
}

const key = readKey();
const target = defaultTarget();
const env = {
  IEEE_API_KEY: key,
  IEEE_MCP_STATE_DIR: freshDir("real-api-pagination"),
  IEEE_DAILY_BUDGET: String(BUDGET),
  IEEE_MAX_RPS: "4",
  IEEE_MAX_RETRIES: "1",
  IEEE_TIMEOUT_MS: "40000",
  IEEE_LOG_LEVEL: "warn",
  ...(process.env.HTTPS_PROXY || process.env.HTTP_PROXY ? { NODE_USE_ENV_PROXY: "1" } : {}),
};

process.stdout.write("ieee-mcp real API pagination check\n");
process.stdout.write(`  target : ${describeTarget()}\n`);
process.stdout.write(`  query  : ${QUERY}\n`);
process.stdout.write(`  budget : ${BUDGET} local calls max\n\n`);

const checks = [];
const record = (name, passed, detail) => {
  checks.push({ name, passed, detail });
  process.stdout.write(`  [${passed ? "PASS" : "FAIL"}] ${name}${passed || detail === undefined ? "" : `\n        ${detail}`}\n`);
};

// ── Phase 1: two explicit pages ──────────────────────────────────────────────
const pageRun = await mcpBatch(target, {
  label: "real-api-pages",
  env,
  timeoutMs: 240_000,
  requests: session([
    toolCall(2, "search_papers", { querytext: QUERY, max_records: 3, start_record: 1 }),
    toolCall(3, "search_papers", { querytext: QUERY, max_records: 3, start_record: 4 }),
  ]),
});

const page1 = toolJson(byId(pageRun.responses, 2));
const page2 = toolJson(byId(pageRun.responses, 3));

record("page 1 returned three records", page1?.returned_records === 3, JSON.stringify(page1?.returned_records));
record("page 1 reports the IEEE total", typeof page1?.total_records === "number" && page1.total_records > 3, String(page1?.total_records));
record("page 1 last_returned_index is 3", page1?.pagination?.last_returned_index === 3, String(page1?.pagination?.last_returned_index));
record("page 1 has_more is true", page1?.pagination?.has_more === true, JSON.stringify(page1?.pagination));
record("page 1 next_start_record is 4", page1?.pagination?.next_start_record === 4, String(page1?.pagination?.next_start_record));
record("page 1 emits a next-page hint", (page1?.warnings ?? []).some((w) => w.includes("start_record=4")), JSON.stringify(page1?.warnings));

const ids1 = (page1?.articles ?? []).map((a) => a.article_number ?? a.doi ?? a.title);
const ids2 = (page2?.articles ?? []).map((a) => a.article_number ?? a.doi ?? a.title);
record("page 2 returned three records", page2?.returned_records === 3, JSON.stringify(page2?.returned_records));
record("page 2 starts at index 4", page2?.pagination?.start_record === 4, String(page2?.pagination?.start_record));
record(
  "pages do not overlap",
  ids1.length === 3 && ids2.length === 3 && ids1.every((id) => !ids2.includes(id)),
  `page1=${JSON.stringify(ids1)} page2=${JSON.stringify(ids2)}`
);
record(
  "page 2 has_more still true (deep result set)",
  page2?.pagination?.has_more === true,
  JSON.stringify(page2?.pagination)
);

// ── Phase 2: auto pagination within a record cap ─────────────────────────────
const autoRun = await mcpBatch(target, {
  label: "real-api-auto",
  env,
  timeoutMs: 240_000,
  requests: session([
    toolCall(2, "search_papers", {
      querytext: QUERY,
      max_records: 3,
      auto_paginate: true,
      max_total_records: 7,
      max_requests: 4,
    }),
  ]),
});
const auto = toolJson(byId(autoRun.responses, 2));
record("auto_paginate returned the requested 7 records", auto?.returned_records === 7, JSON.stringify(auto?.returned_records));
record("auto_paginate fetched three pages", auto?.pagination?.pages_fetched === 3, String(auto?.pagination?.pages_fetched));
record(
  "auto_paginate is within the max_total_records cap",
  (auto?.returned_records ?? 0) <= 7,
  String(auto?.returned_records)
);
record(
  "auto_paginate results are unique",
  new Set((auto?.articles ?? []).map((a) => a.article_number ?? a.doi ?? a.title)).size === (auto?.articles ?? []).length,
  JSON.stringify((auto?.articles ?? []).map((a) => a.article_number))
);
record("auto_paginate reports has_more true (more results exist)", auto?.pagination?.has_more === true, JSON.stringify(auto?.pagination));

// ── Phase 3: multi-query merge and dedup ─────────────────────────────────────
const mergeRun = await mcpBatch(target, {
  label: "real-api-merge",
  env,
  timeoutMs: 240_000,
  requests: session([toolCall(2, "search_papers", { queries: VARIANTS, max_records: 4 })]),
});
const merged = toolJson(byId(mergeRun.responses, 2));
record("multi-query search issued one request per variant", merged?.per_query?.length === VARIANTS.length, JSON.stringify(merged?.per_query?.length));
record("multi-query reports merged pagination mode", merged?.pagination?.mode === "merged", String(merged?.pagination?.mode));
record("multi-query warns that the union total is unknown", (merged?.warnings ?? []).some((w) => w.includes("union of queries")), JSON.stringify(merged?.warnings));
record(
  "merged records are unique by DOI/article_number",
  new Set((merged?.articles ?? []).map((a) => (a.doi ?? a.article_number ?? a.title).toLowerCase())).size === (merged?.articles ?? []).length,
  JSON.stringify((merged?.articles ?? []).map((a) => a.doi))
);
record(
  "merged record count is within the union of both queries",
  (merged?.returned_records ?? 0) <= 8,
  String(merged?.returned_records)
);
process.stdout.write(
  `  ...  merged: ${merged?.returned_records} unique records, ${merged?.dedup?.duplicates_removed} duplicates removed ` +
    `(matched on: ${JSON.stringify(merged?.dedup?.matched_on)})\n`
);

// ── Accounting ───────────────────────────────────────────────────────────────
const statusRun = await mcpBatch(target, {
  label: "real-api-pagination-status",
  env,
  timeoutMs: 60_000,
  requests: session([toolCall(2, "ieee_status", {})]),
});
const status = toolJson(byId(statusRun.responses, 2));

const failed = checks.filter((check) => !check.passed);
const summary = {
  ran_at: new Date().toISOString(),
  target: describeTarget(),
  query: QUERY,
  variants: VARIANTS,
  budget: BUDGET,
  api_calls_consumed: status?.local_usage?.local_calls_utc_day ?? null,
  remaining_local_budget: status?.local_usage?.remaining_local_budget ?? null,
  page1: { total_records: page1?.total_records, returned: page1?.returned_records, pagination: page1?.pagination },
  page2: { returned: page2?.returned_records, pagination: page2?.pagination },
  auto_paginate: { returned: auto?.returned_records, pagination: auto?.pagination },
  merge: { returned: merged?.returned_records, duplicates_removed: merged?.dedup?.duplicates_removed, matched_on: merged?.dedup?.matched_on },
  checks: checks.length,
  failed: failed.length,
};

const outFile = path.join(REPO_ROOT, "build", "real-api-pagination.json");
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

process.stdout.write("\n-----------------------------------------\n");
process.stdout.write(`API calls consumed (cross-process ledger): ${summary.api_calls_consumed} / budget ${BUDGET}\n`);
process.stdout.write(`checks: ${checks.length - failed.length}/${checks.length} passed\n`);
process.stdout.write(`summary written to ${outFile}\n`);
process.exit(failed.length === 0 ? 0 : 1);
