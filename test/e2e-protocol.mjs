/**
 * Protocol-level checks: initialize, tools/list, stdout purity, stdout/stderr
 * separation, and the removal of the old full-text tool.
 */

import fs from "node:fs";
import path from "node:path";

import {
  createReporter,
  defaultTarget,
  describeTarget,
  mcpBatch,
  session,
  toolsList,
  byId,
  freshDir,
} from "./harness.mjs";
import { startMockServer } from "./mock-ieee-server.mjs";

const API_KEY = "0123456789abcdef0123456789abcdef";

export async function run() {
  const reporter = createReporter("protocol");
  const target = defaultTarget();
  reporter.note(`target: ${describeTarget()}`);

  const mock = await startMockServer();

  try {
    // ── initialize / tools/list with a key present ────────────────────────────
    reporter.section("initialize and tools/list");
    const stateDir = freshDir("protocol");
    const run = await mcpBatch(target, {
      label: "protocol",
      env: {
        IEEE_API_KEY: API_KEY,
        IEEE_API_BASE: mock.baseUrl,
        IEEE_MCP_STATE_DIR: stateDir,
        IEEE_LOG_LEVEL: "info",
      },
      requests: session([toolsList(2)]),
    });

    reporter.check("server process exits 0 on stdin EOF", run.code === 0, `exit code ${run.code}`);
    reporter.check("stdout contains only valid JSON-RPC lines", run.invalidLines.length === 0, run.invalidLines.join("\n"));

    const init = byId(run.responses, 1);
    reporter.check("initialize responded", Boolean(init?.result));
    reporter.equal("serverInfo.name", init?.result?.serverInfo?.name, "ieee-mcp");
    reporter.equal("serverInfo.version", init?.result?.serverInfo?.version, "2.0.0");
    reporter.check("advertises the tools capability", Boolean(init?.result?.capabilities?.tools));
    reporter.check(
      "negotiated a protocol version",
      typeof init?.result?.protocolVersion === "string" && init.result.protocolVersion.length > 0,
      JSON.stringify(init?.result?.protocolVersion)
    );

    const list = byId(run.responses, 2);
    const tools = list?.result?.tools ?? [];
    const names = tools.map((tool) => tool.name).sort();
    reporter.check("tools/list returned tools", tools.length > 0, JSON.stringify(names));
    reporter.check(
      "expected tool set is present",
      ["search_papers", "get_paper_details", "get_paper_citations", "export_results", "ieee_status", "search_by_author", "search_by_publication"].every(
        (name) => names.includes(name)
      ),
      JSON.stringify(names)
    );
    reporter.check(
      "get_full_text is gone",
      !names.includes("get_full_text"),
      `tools: ${JSON.stringify(names)}`
    );
    reporter.check(
      "no tool name mentions full text retrieval",
      !names.some((name) => /full_?text/i.test(name)),
      JSON.stringify(names)
    );
    reporter.check(
      "every tool has an inputSchema and description",
      tools.every((tool) => tool.inputSchema && typeof tool.description === "string" && tool.description.length > 20),
      JSON.stringify(tools.map((tool) => ({ name: tool.name, hasSchema: Boolean(tool.inputSchema) })))
    );

    const searchTool = tools.find((tool) => tool.name === "search_papers");
    const description = searchTool?.description ?? "";
    /**
     * A description may mention full-text search only to deny it. Any sentence
     * that mentions it must also disclaim it.
     */
    const fullTextClaims = description
      .split(/(?<=[.!?])\s+/)
      .filter((sentence) => /full[\s-]?text search/i.test(sentence))
      .filter((sentence) => !/\b(not|never|cannot|can't|no)\b/i.test(sentence));
    reporter.check(
      "search_papers never claims to perform full-text search",
      fullTextClaims.length === 0,
      fullTextClaims.join(" || ")
    );
    reporter.check(
      "search_papers description states the metadata/abstract scope",
      /metadata/i.test(description) && /abstract/i.test(description),
      description
    );
    reporter.check(
      "search_papers description states PDFs are unavailable",
      /cannot download PDFs|NOT a full-text/i.test(description),
      description
    );
    const fullTextToolDescriptions = tools
      .filter((tool) => /full[\s-]?text/i.test(tool.description ?? ""))
      .filter((tool) =>
        (tool.description ?? "")
          .split(/(?<=[.!?])\s+/)
          .filter((sentence) => /full[\s-]?text/i.test(sentence))
          .some((sentence) => !/\b(not|never|cannot|can't|no)\b/i.test(sentence))
      )
      .map((tool) => tool.name);
    reporter.check(
      "no tool description advertises full-text retrieval",
      fullTextToolDescriptions.length === 0,
      JSON.stringify(fullTextToolDescriptions)
    );

    reporter.section("stdout / stderr separation");    reporter.check(
      "startup and request logs landed on stderr",
      run.stderr.includes("[ieee-mcp]"),
      run.stderr.slice(0, 400)
    );
    reporter.check(
      "stdout is pure JSON-RPC (first byte is '{')",
      run.stdout.trimStart().startsWith("{"),
      run.stdout.slice(0, 120)
    );
    reporter.check(
      "no log lines on stdout",
      !run.stdout.includes("[ieee-mcp]"),
      run.stdout.slice(0, 200)
    );
    reporter.check(
      "state directory was created where requested",
      fs.existsSync(stateDir),
      stateDir
    );

    // ── missing API key must still serve initialize/tools/list ────────────────
    reporter.section("missing API key degradation");
    mock.state.requests.length = 0;
    const noKeyEnv = {
      IEEE_API_BASE: mock.baseUrl,
      IEEE_MCP_STATE_DIR: freshDir("protocol-nokey"),
      IEEE_LOG_LEVEL: "info",
    };
    delete noKeyEnv.IEEE_API_KEY;
    const noKeyRun = await mcpBatch(target, {
      label: "protocol-nokey",
      // Explicitly strip any inherited key from the ambient environment.
      env: { ...noKeyEnv, IEEE_API_KEY: "", IEEE_API_KEY_FILE: "" },
      requests: session([
        toolsList(2),
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search_papers", arguments: { querytext: "radar" } } },
        { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "ieee_status", arguments: {} } },
      ]),
    });

    reporter.check("server still starts without a key", noKeyRun.code === 0, `exit ${noKeyRun.code}`);
    reporter.check("initialize still succeeds without a key", Boolean(byId(noKeyRun.responses, 1)?.result));
    reporter.check(
      "tools/list still succeeds without a key",
      (byId(noKeyRun.responses, 2)?.result?.tools ?? []).length > 0
    );
    const noKeySearch = byId(noKeyRun.responses, 3);
    reporter.check("search tool fails without a key", noKeySearch?.result?.isError === true);
    reporter.check(
      "failure reason is CONFIG_ERROR",
      /CONFIG_ERROR/.test(noKeySearch?.result?.content?.[0]?.text ?? ""),
      noKeySearch?.result?.content?.[0]?.text
    );
    const noKeyStatus = JSON.parse(byId(noKeyRun.responses, 4)?.result?.content?.[0]?.text ?? "{}");
    reporter.equal("ieee_status reports the key as absent", noKeyStatus?.config?.api_key_present, false);
    reporter.check(
      "no API request was attempted without a key",
      mock.state.requests.length === 0,
      `${mock.state.requests.length} requests hit the mock`
    );

    // ── unknown tool / method errors stay on the protocol ─────────────────────
    reporter.section("error surfaces");
    const errRun = await mcpBatch(target, {
      label: "protocol-errors",
      env: {
        IEEE_API_KEY: API_KEY,
        IEEE_API_BASE: mock.baseUrl,
        IEEE_MCP_STATE_DIR: freshDir("protocol-errors"),
        IEEE_LOG_LEVEL: "warn",
      },
      requests: session([
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "definitely_not_a_tool", arguments: {} } },
      ]),
    });
    const unknown = byId(errRun.responses, 2);
    reporter.check(
      "unknown tool produces an error result",
      unknown?.result?.isError === true || Boolean(unknown?.error),
      JSON.stringify(unknown)
    );
    reporter.check(
      "unknown tool error names the tool",
      /definitely_not_a_tool/.test(JSON.stringify(unknown)),
      JSON.stringify(unknown)
    );

    const stateFiles = fs.existsSync(stateDir) ? fs.readdirSync(stateDir) : [];
    reporter.check(
      "the API key never appears in any state file",
      stateFiles.every((name) => {
        const full = path.join(stateDir, name);
        try {
          if (!fs.statSync(full).isFile()) return true;
          return !fs.readFileSync(full, "utf8").includes(API_KEY);
        } catch {
          return true;
        }
      }),
      `files: ${stateFiles.join(", ")}`
    );
  } finally {
    await mock.close();
  }

  return reporter.summary();
}
