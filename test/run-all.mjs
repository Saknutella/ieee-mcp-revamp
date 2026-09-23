/**
 * Test entry point.
 *
 * Runs every suite in-process (no child test runners, no pipes) and reports a
 * single exit code. Writes a machine-readable summary to build/test-results.json.
 *
 * Usage:
 *   node test/run-all.mjs                     # against dist/ieee-mcp.exe
 *   node test/run-all.mjs search export       # only named suites
 *   IEEE_TEST_TARGET=bundle node test/run-all.mjs
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { describeTarget, REPO_ROOT } from "./harness.mjs";
import { run as protocol } from "./e2e-protocol.mjs";
import { run as search } from "./e2e-search.mjs";
import { run as resilience } from "./e2e-resilience.mjs";
import { run as exportSuite } from "./e2e-export.mjs";

const suites = [
  ["protocol", protocol],
  ["search", search],
  ["resilience", resilience],
  ["export", exportSuite],
];

const only = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
const target = describeTarget();

process.stdout.write(`ieee-mcp test suite\ntarget: ${target}\n`);

const startedAt = new Date();
const collected = [];
let failures = 0;
let ran = 0;

for (const [name, runner] of suites) {
  if (only.length > 0 && !only.includes(name)) continue;
  ran += 1;
  process.stdout.write(`\n############ ${name} ############\n`);
  try {
    const stats = await runner();
    collected.push(stats);
    failures += stats.failed;
  } catch (error) {
    failures += 1;
    collected.push({ suite: name, total: 0, passed: 0, failed: 1, failures: [String(error?.stack ?? error)] });
    process.stdout.write(`\n!! suite "${name}" threw: ${error?.stack ?? error}\n`);
  }
}

if (ran === 0) {
  process.stdout.write("No matching suites.\n");
  process.exit(2);
}

const totals = collected.reduce(
  (sum, stats) => ({ total: sum.total + stats.total, passed: sum.passed + stats.passed }),
  { total: 0, passed: 0 }
);

process.stdout.write("\n=========================================\n");
for (const stats of collected) {
  process.stdout.write(`  ${stats.suite.padEnd(12)} ${stats.passed}/${stats.total}\n`);
}
process.stdout.write(`  ${"TOTAL".padEnd(12)} ${totals.passed}/${totals.total}\n`);
process.stdout.write(failures === 0 ? "\nALL SUITES PASSED\n" : `\nFAILURES: ${failures}\n`);

const report = {
  target,
  started_at: startedAt.toISOString(),
  finished_at: new Date().toISOString(),
  passed: totals.passed,
  total: totals.total,
  failed: failures,
  suites: collected,
};
const outFile = path.join(REPO_ROOT, "build", "test-results.json");
try {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`summary written to ${outFile}\n`);
} catch (error) {
  process.stdout.write(`could not write ${outFile}: ${error}\n`);
}

process.exit(failures === 0 ? 0 : 1);
