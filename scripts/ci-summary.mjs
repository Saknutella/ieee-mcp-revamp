/**
 * Render build provenance and test totals into the GitHub Actions job summary.
 *
 * Called by .github/workflows/build.yml after the build and test steps. It is
 * an ES module like the rest of the repo (`package.json` sets "type": "module"),
 * which is why this is a file rather than a `node -e` one-liner: `-e` input does
 * not reliably get the repo's module type, and getting that wrong turns a
 * cosmetic step into a red build.
 *
 * Writes to $GITHUB_STEP_SUMMARY when that is set, and to stdout otherwise, so
 * it can be run locally to check its output.
 */

import fs from "node:fs";
import process from "node:process";

const read = (file) => {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return null;
  }
};

const parse = (file) => {
  const raw = read(file);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const info = parse("dist/BUILD-INFO.json");
const results = parse("build/test-results.json");

const lines = [];
const headline = results ? `${results.passed}/${results.total} checks passed` : "tests not run";
lines.push(`### ${info?.target ?? "unknown target"} — ${headline}`, "");

if (results) {
  lines.push("| suite | passed |", "| --- | --- |");
  for (const suite of results.suites ?? []) {
    lines.push(`| ${suite.suite} | ${suite.passed}/${suite.total} |`);
  }
  if (results.failed > 0) {
    lines.push("", `**${results.failed} failing check(s):**`);
    for (const suite of results.suites ?? []) {
      for (const failure of suite.failures ?? []) lines.push(`- ${failure}`);
    }
  }
  lines.push("");
}

if (info) {
  const artifact = info.artifacts?.find((entry) => entry.path === `dist/${info.artifact}`) ?? info.artifacts?.[0];
  lines.push(
    "| | |",
    "| --- | --- |",
    `| node | ${info.node} |`,
    `| platform | ${info.platform} |`,
    `| esbuild | ${info.esbuild} |`,
    `| postject | ${info.postject} |`,
    `| modelcontextprotocol/sdk | ${info["modelcontextprotocol/sdk"]} |`,
    `| zod | ${info.zod} |`,
    artifact ? `| ${artifact.path} | ${artifact.bytes} bytes |` : "| artifact | (none) |",
    artifact ? `| sha256 | \`${artifact.sha256}\` |` : "",
    ""
  );
}

const markdown = `${lines.filter((line) => line !== undefined).join("\n")}\n`;
const summaryPath = process.env.GITHUB_STEP_SUMMARY;

if (summaryPath) {
  fs.appendFileSync(summaryPath, markdown, "utf8");
  process.stdout.write(`appended ${markdown.length} bytes to the job summary\n`);
} else {
  process.stdout.write(markdown);
}
