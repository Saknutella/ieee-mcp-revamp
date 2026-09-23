#!/usr/bin/env node
/**
 * ieee-mcp - IEEE Xplore Metadata Search MCP server (stdio transport).
 *
 * stdout carries MCP JSON-RPC framing and nothing else. Every diagnostic goes to
 * stderr through src/logger.ts, which scrubs the API key. `console.*` is rerouted
 * to stderr as a safety net, because the MCP SDK owns stdout.
 */

import process from "node:process";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

import { getConfig, SERVER_NAME, SERVER_VERSION, describeConfig, type Config } from "./config.js";
import { setLogLevel, log, registerSecret, redact } from "./logger.js";
import { IeeeMcpError, toIeeeMcpError } from "./errors.js";
import { DiskCache } from "./cache.js";
import { IeeeClient } from "./ieeeClient.js";
import { ResultStore } from "./resultStore.js";
import { registerTools } from "./tools.js";
import { ensureDir } from "./store.js";

let shuttingDown = false;

/** Route the console to stderr so nothing but MCP framing can reach stdout. */
function routeConsoleToStderr(): void {
  const toLog = (prefix: string) => (...args: unknown[]) => {
    log.error(`${prefix}${args.map((arg) => redact(arg)).join(" ")}`);
  };
  console.log = toLog("");
  console.info = toLog("");
  console.debug = toLog("[debug] ");
  console.warn = toLog("[warn] ");
}

function flushStdout(): Promise<void> {
  return new Promise((resolve) => {
    try {
      if (process.stdout.writableLength === 0) {
        resolve();
        return;
      }
      process.stdout.write("", () => resolve());
    } catch {
      resolve();
    }
  });
}

async function shutdown(server: McpServer | null, code: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.debug(`Shutting down with exit code ${code}.`);
  try {
    await server?.close();
  } catch (error) {
    log.debug(`Error while closing the MCP server: ${redact(error)}`);
  }
  await flushStdout();
  process.exit(code);
}

/**
 * Highest request id (or count of outstanding notifications) seen but not yet answered.
 *
 * A client may close stdin right after writing its last request; without this the
 * process would exit while a tool call is still waiting on the network.
 */
class PendingRequests {
  private readonly ids = new Set<string | number>();

  /** Incoming JSON-RPC request: has both `method` and `id`. */
  track(message: unknown): void {
    const id = requestId(message);
    if (id !== null) this.ids.add(id);
  }

  /** Outgoing JSON-RPC response: has an `id` and no `method`. */
  settle(message: unknown): void {
    const id = responseId(message);
    if (id !== null) this.ids.delete(id);
  }

  get size(): number {
    return this.ids.size;
  }

  async drain(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.ids.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (this.ids.size > 0) {
      log.warn(`Timed out after ${timeoutMs}ms waiting for ${this.ids.size} in-flight request(s).`);
      return false;
    }
    return true;
  }
}

function requestId(message: unknown): string | number | null {
  if (message === null || typeof message !== "object") return null;
  const record = message as Record<string, unknown>;
  if (!("method" in record)) return null; // outgoing response, not an incoming request
  const id = record.id;
  return typeof id === "string" || typeof id === "number" ? id : null;
}

function responseId(message: unknown): string | number | null {
  if (message === null || typeof message !== "object") return null;
  const record = message as Record<string, unknown>;
  if ("method" in record) return null; // outgoing request/notification, not a response
  const id = record.id;
  return typeof id === "string" || typeof id === "number" ? id : null;
}

/** Diagnostic mode: everything on stderr so stdout stays reserved for MCP. */
function printSelfTest(config: Config): void {
  const report = {
    server: `${SERVER_NAME} ${SERVER_VERSION}`,
    exec_path: process.execPath,
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    argv: process.argv.slice(2),
    config: describeConfig(config),
    config_warnings: config.warnings,
  };
  process.stderr.write(`${JSON.stringify(report, null, 2)}\n`);
}

const HELP_TEXT = [
  `${SERVER_NAME} ${SERVER_VERSION} - IEEE Xplore Metadata Search MCP server (stdio)`,
  "",
  "This process speaks MCP JSON-RPC over stdin/stdout. It is normally started by an MCP",
  "client, not from an interactive shell.",
  "",
  "Environment:",
  "  IEEE_API_KEY            required (unless IEEE_API_KEY_FILE is used)",
  "  IEEE_API_KEY_FILE       read the key from a UTF-8 file instead",
  "  IEEE_MCP_STATE_DIR      where the usage ledger, cache and result sets live",
  "  IEEE_OUTPUT_DIR         base directory for exports",
  "  IEEE_MAX_RPS            requests/second ceiling (default 8, documented max 10)",
  "  IEEE_DAILY_BUDGET       local daily call budget (default 200)",
  "  IEEE_BUDGET_WINDOW      both | utc-day | local-day | rolling-24h (default both)",
  "  IEEE_MAX_RETRIES        retry attempts for transient failures (default 2)",
  "  IEEE_TIMEOUT_MS         per-request timeout in ms (default 20000)",
  "  IEEE_CACHE_TTL_SECONDS  response cache TTL, 0 disables (default 86400)",
  "  IEEE_CACHE_MAX_ENTRIES  cache entry cap (default 500)",
  "  IEEE_RESULT_TTL_SECONDS stored result-set TTL (default 21600)",
  "  IEEE_LOG_LEVEL          silent | error | warn | info | debug (default info)",
  "  IEEE_API_BASE           override the endpoint (testing/mock servers only)",
  "",
  "Flags:",
  "  --version    print the version on stderr and exit",
  "  --self-test  print the resolved configuration (key fingerprinted) on stderr and exit",
  "  --help       print this text on stderr and exit",
  "",
].join("\n");

async function main(): Promise<void> {
  // In a Node SEA, argv[0] is the executable and argv[1] is not guaranteed to be
  // absent, so scan everything after argv[0] for flags.
  const argv = process.argv.slice(1);

  let config: Config;
  try {
    config = getConfig();
  } catch (error) {
    const normalized = toIeeeMcpError(error);
    process.stderr.write(`${SERVER_NAME}: fatal configuration error: ${normalized.message}\n`);
    process.exit(2);
    return;
  }

  setLogLevel(config.logLevel);
  if (config.hasApiKey) registerSecret(config.apiKey);
  routeConsoleToStderr();

  if (argv.includes("--version") || argv.includes("-v")) {
    process.stderr.write(`${SERVER_NAME} ${SERVER_VERSION}\n`);
    process.exit(0);
    return;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stderr.write(HELP_TEXT);
    process.exit(0);
    return;
  }
  if (argv.includes("--self-test")) {
    printSelfTest(config);
    process.exit(0);
    return;
  }

  log.info(`Starting ${SERVER_NAME} ${SERVER_VERSION} (pid ${process.pid}).`);
  log.info(
    `Config: api_base=${config.apiBase} rps=${config.maxRps} budget=${config.dailyBudget}/${config.budgetWindow} ` +
      `retries=${config.maxRetries} timeout=${config.timeoutMs}ms cache_ttl=${config.cacheTtlSeconds}s ` +
      `state_dir=${config.stateDir} log_level=${config.logLevel}`
  );
  log.info(`API key source: ${config.apiKeySource}, fingerprint sha256[0:12]=${config.keyFingerprint}`);
  for (const warning of config.warnings) log.warn(warning);

  if (!config.apiBaseIsDefault) {
    log.warn(
      `IEEE_API_BASE is overridden to ${config.apiBase}. Intended for offline testing against a mock server; ` +
        "real queries should use the official endpoint."
    );
  }
  if (!config.hasApiKey) {
    log.error(
      "No IEEE API key configured. The server still answers initialize/tools/list, but every search tool " +
        "returns CONFIG_ERROR until IEEE_API_KEY (or IEEE_API_KEY_FILE) is set."
    );
  }

  try {
    ensureDir(config.stateDir);
  } catch (error) {
    log.warn(`State directory ${config.stateDir} is not writable: ${redact(error)}`);
  }

  const cache = new DiskCache(config);
  const client = new IeeeClient(config, cache);
  const results = new ResultStore(config);

  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerTools(server, {
    config,
    client,
    cache,
    results,
    searchContext: { config, client, results },
  });

  const transport = new StdioServerTransport();

  await server.connect(transport);

  // `connect` installs the transport callbacks, so wrap them afterwards to count
  // in-flight requests. Notifications carry no id and are already fire-and-forget.
  const pending = new PendingRequests();
  const innerOnMessage = transport.onmessage;
  transport.onmessage = (message: JSONRPCMessage): void => {
    pending.track(message);
    innerOnMessage?.(message);
  };
  const innerSend = transport.send.bind(transport);
  transport.send = async (message: JSONRPCMessage): Promise<void> => {
    await innerSend(message);
    pending.settle(message);
  };

  log.info("Server running on stdio. Close stdin (or send SIGTERM) to stop.");

  // The SDK does not react to stdin EOF. An MCP client may close stdin, and the
  // end-to-end tests feed every request at once and then close the pipe, so drain
  // outstanding requests and exit cleanly instead of hanging or truncating output.
  const graceMs = config.shutdownGraceMs;
  const onInputClosed = (): void => {
    log.debug("stdin closed; draining in-flight requests before exit.");
    void pending.drain(graceMs).then(() => shutdown(server, 0));
  };
  process.stdin.on("end", onInputClosed);
  process.stdin.on("close", onInputClosed);
}

process.on("uncaughtException", (error) => {
  const normalized = error instanceof IeeeMcpError ? error : toIeeeMcpError(error);
  process.stderr.write(`${SERVER_NAME}: uncaught exception: ${normalized.message}\n`);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  process.stderr.write(`${SERVER_NAME}: unhandled rejection: ${redact(reason)}\n`);
});

process.on("SIGINT", () => {
  void shutdown(null, 0);
});
process.on("SIGTERM", () => {
  void shutdown(null, 0);
});

void main().catch((error) => {
  process.stderr.write(`${SERVER_NAME}: fatal error: ${redact(error)}\n`);
  process.exit(1);
});
