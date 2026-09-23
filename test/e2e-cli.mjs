/**
 * CLI surface and startup behaviour: --version, --help, --self-test,
 * immediate stdin EOF, and stdout purity in every non-MCP mode.
 */

import fs from "node:fs";
import path from "node:path";

import { createReporter, defaultTarget, describeTarget, freshDir, mcpBatch, runCli } from "./harness.mjs";
import { startMockServer } from "./mock-ieee-server.mjs";

const API_KEY = "0123456789abcdef0123456789abcdef";

export async function run() {
  const reporter = createReporter("cli");
  const target = defaultTarget();
  reporter.note(`target: ${describeTarget()}`);
  const mock = await startMockServer();

  try {
    reporter.section("--version");
    const version = await runCli(target, ["--version"], { env: { IEEE_MCP_STATE_DIR: freshDir("cli-version") } });
    reporter.equal("--version exits 0", version.code, 0);
    reporter.check("--version reports the server and version", /ieee-mcp 2\.0\.0/.test(version.stderr), version.stderr);
    reporter.equal("--version keeps stdout empty", version.stdout, "");

    reporter.section("--help");
    const help = await runCli(target, ["--help"], { env: { IEEE_MCP_STATE_DIR: freshDir("cli-help") } });
    reporter.equal("--help exits 0", help.code, 0);
    for (const variable of ["IEEE_API_KEY", "IEEE_API_KEY_FILE", "IEEE_MAX_RPS", "IEEE_DAILY_BUDGET", "IEEE_LOG_LEVEL"]) {
      reporter.check(`--help documents ${variable}`, help.stderr.includes(variable), help.stderr.slice(0, 400));
    }
    reporter.equal("--help keeps stdout empty", help.stdout, "");

    reporter.section("--self-test");
    const selfTestDir = freshDir("cli-selftest");
    const selfTest = await runCli(target, ["--self-test"], {
      env: { IEEE_API_KEY: API_KEY, IEEE_MCP_STATE_DIR: selfTestDir, IEEE_API_BASE: mock.baseUrl },
    });
    reporter.equal("--self-test exits 0", selfTest.code, 0);
    reporter.equal("--self-test keeps stdout empty", selfTest.stdout, "");
    let report = null;
    try {
      report = JSON.parse(selfTest.stderr.slice(selfTest.stderr.indexOf("{")));
    } catch {
      report = null;
    }
    reporter.check("--self-test emits parsable JSON on stderr", report !== null, selfTest.stderr.slice(0, 300));
    reporter.equal("--self-test reports the platform", report?.platform, "win32-x64");
    reporter.check("--self-test resolves exec_path to the server binary", typeof report?.exec_path === "string" && report.exec_path.length > 0, report?.exec_path);
    reporter.equal("--self-test marks the key as present", report?.config?.api_key_present, true);
    reporter.check(
      "--self-test exposes only a fingerprint of the key",
      /^[0-9a-f]{12}$/.test(report?.config?.api_key_fingerprint_sha256_12 ?? ""),
      report?.config?.api_key_fingerprint_sha256_12
    );
    reporter.check("--self-test leaks no key material to stderr", !selfTest.stderr.includes(API_KEY));
    reporter.check("--self-test detects the overridden API base", report?.config?.api_base_overridden === true);

    const noKey = await runCli(target, ["--self-test"], {
      env: { IEEE_API_KEY: "", IEEE_API_KEY_FILE: "", IEEE_MCP_STATE_DIR: freshDir("cli-selftest-nokey") },
    });
    const noKeyReport = JSON.parse(noKey.stderr.slice(noKey.stderr.indexOf("{")));
    reporter.equal("--self-test with no key reports it as absent", noKeyReport?.config?.api_key_present, false);
    reporter.check(
      "--self-test with no key explains how to fix it",
      JSON.stringify(noKeyReport?.config_warnings ?? []).includes("IEEE_API_KEY"),
      JSON.stringify(noKeyReport?.config_warnings)
    );

    reporter.section("empty stdin");
    const empty = await mcpBatch(target, {
      label: "cli-empty-stdin",
      env: { IEEE_API_KEY: API_KEY, IEEE_API_BASE: mock.baseUrl, IEEE_MCP_STATE_DIR: freshDir("cli-empty") },
      requests: [],
      timeoutMs: 30_000,
    });
    reporter.equal("an immediately closed stdin exits 0", empty.code, 0);
    reporter.check("no output was produced", empty.stdout.trim() === "");
    reporter.check("no API request was made", mock.state.requests.length === 0, `${mock.state.requests.length} requests`);

    reporter.section("state directory fallback");
    // A state directory whose parent is a regular file cannot be created; the
    // server must still start and answer rather than crashing at boot.
    const parent = freshDir("cli-blocked");
    const blockingFile = path.join(parent, "not-a-directory");
    fs.writeFileSync(blockingFile, "x", "utf8");
    const mcpRun = await mcpBatch(target, {
      label: "cli-bad-state",
      env: {
        IEEE_API_KEY: API_KEY,
        IEEE_API_BASE: mock.baseUrl,
        IEEE_MCP_STATE_DIR: path.join(blockingFile, "state"),
      },
      requests: [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } },
        { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      ],
      timeoutMs: 30_000,
    });
    reporter.check(
      "an unusable state directory still allows startup",
      mcpRun.code === 0 && mcpRun.responses.some((response) => response.id === 1),
      `exit ${mcpRun.code}: ${mcpRun.stderr.slice(-400)}`
    );
    reporter.check(
      "an unusable state directory still serves tools/list",
      (mcpRun.responses.find((response) => response.id === 2)?.result?.tools ?? []).length > 0,
      mcpRun.stdout.slice(0, 300)
    );
  } finally {
    await mock.close();
  }

  return reporter.summary();
}
