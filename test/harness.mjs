/**
 * MCP stdio test harness.
 *
 * Child processes are spawned with *file descriptors* rather than pipes, which
 * keeps the harness working inside restricted sandboxes and also lets the whole
 * JSON-RPC conversation be replayed from a file: the server exits when stdin
 * reaches EOF.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const EXE_PATH = path.join(REPO_ROOT, "dist", "ieee-mcp.exe");
export const BUNDLE_PATH = path.join(REPO_ROOT, "build", "bundle.cjs");

let runCounter = 0;

export function freshDir(label) {
  const dir = path.join(
    REPO_ROOT,
    ".tmp",
    "runs",
    `${label.replace(/[^A-Za-z0-9_-]/g, "_")}-${Date.now().toString(36)}-${runCounter++}`
  );
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Run one batch conversation against a stdio MCP server.
 * `target` is either an executable path or { command, args }.
 */
export function mcpBatch(target, options) {
  const { requests, env = {}, cwd, timeoutMs = 120_000, label = "run" } = options;
  const command = typeof target === "string" ? target : target.command;
  const args = typeof target === "string" ? [] : target.args ?? [];
  const dir = freshDir(label);

  const inFile = path.join(dir, "stdin.jsonl");
  const outFile = path.join(dir, "stdout.jsonl");
  const errFile = path.join(dir, "stderr.log");
  fs.writeFileSync(inFile, `${requests.map((request) => JSON.stringify(request)).join("\n")}\n`, "utf8");
  fs.writeFileSync(outFile, "", "utf8");
  fs.writeFileSync(errFile, "", "utf8");

  const inFd = fs.openSync(inFile, "r");
  const outFd = fs.openSync(outFile, "w");
  const errFd = fs.openSync(errFile, "w");

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: cwd ?? dir,
        env: { ...process.env, ...env },
        stdio: [inFd, outFd, errFd],
        windowsHide: true,
      });
    } catch (error) {
      fs.closeSync(inFd);
      fs.closeSync(outFd);
      fs.closeSync(errFd);
      reject(error);
      return;
    }

    let settled = false;
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }, timeoutMs);

    const finish = (code, spawnError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        fs.closeSync(inFd);
        fs.closeSync(outFd);
        fs.closeSync(errFd);
      } catch {
        /* ignore */
      }
      const stdout = fs.readFileSync(outFile, "utf8");
      const stderr = fs.readFileSync(errFile, "utf8");
      const responses = [];
      const invalidLines = [];
      for (const line of stdout.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        try {
          responses.push(JSON.parse(trimmed));
        } catch {
          invalidLines.push(trimmed);
        }
      }
      resolve({ code, killed, spawnError: spawnError ?? null, stdout, stderr, responses, invalidLines, dir });
    };

    child.on("error", (error) => finish(null, error));
    child.on("exit", (code) => finish(code, null));
  });
}

export function initialize(id = 1) {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      clientInfo: { name: "ieee-mcp-e2e", version: "1.0.0" },
    },
  };
}

export const initializedNotification = { jsonrpc: "2.0", method: "notifications/initialized" };

export function toolsList(id) {
  return { jsonrpc: "2.0", id, method: "tools/list", params: {} };
}

export function toolCall(id, name, args) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args ?? {} } };
}

export function session(extra, startId = 2) {
  const requests = [initialize(1), initializedNotification];
  extra.forEach((request, index) => {
    requests.push(request.id === undefined ? { ...request, id: startId + index } : request);
  });
  return requests;
}

export function byId(responses, id) {
  return responses.find((response) => response.id === id);
}

/**
 * Which artifact the suite exercises.
 *   IEEE_TEST_TARGET=exe    (default) the packaged dist/ieee-mcp.exe
 *   IEEE_TEST_TARGET=bundle run the esbuild bundle with the local Node runtime
 */
export function defaultTarget() {
  const mode = process.env.IEEE_TEST_TARGET ?? "exe";
  if (mode === "bundle") return { command: process.execPath, args: [BUNDLE_PATH] };
  return EXE_PATH;
}

export function describeTarget() {
  const mode = process.env.IEEE_TEST_TARGET ?? "exe";
  return mode === "bundle" ? `node + ${path.relative(REPO_ROOT, BUNDLE_PATH)}` : path.relative(REPO_ROOT, EXE_PATH);
}

/** Extract the JSON payload of a tool result, or null when the call failed. */
export function toolJson(response) {
  if (!response || !response.result) return null;
  const text = response.result.content?.[0]?.text;
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function toolText(response) {
  return response?.result?.content?.[0]?.text ?? "";
}

export function isToolError(response) {
  return response?.result?.isError === true;
}

// ── Tiny assertion reporter ────────────────────────────────────────────────────

export function createReporter(title) {
  const results = [];
  let currentSection = "";

  const record = (name, passed, detail) => {
    results.push({ section: currentSection, name, passed, detail });
    const mark = passed ? "PASS" : "FAIL";
    const suffix = passed || detail === undefined ? "" : `\n      ${String(detail).split("\n").join("\n      ")}`;
    process.stdout.write(`  [${mark}] ${name}${suffix}\n`);
  };

  return {
    title,
    section(name) {
      currentSection = name;
      process.stdout.write(`\n== ${name} ==\n`);
    },
    check(name, condition, detail) {
      record(name, Boolean(condition), condition ? undefined : detail ?? "condition was falsy");
    },
    equal(name, actual, expected) {
      const same = JSON.stringify(actual) === JSON.stringify(expected);
      record(name, same, same ? undefined : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    },
    note(message) {
      process.stdout.write(`  ...  ${message}\n`);
    },
    get failures() {
      return results.filter((result) => !result.passed);
    },
    get total() {
      return results.length;
    },
    stats() {
      const failed = results.filter((result) => !result.passed);
      return {
        suite: title,
        total: results.length,
        passed: results.length - failed.length,
        failed: failed.length,
        failures: failed.map((failure) => `[${failure.section}] ${failure.name}`),
      };
    },
    summary() {
      const stats = this.stats();
      process.stdout.write(`\n${title}: ${stats.passed}/${stats.total} checks passed.\n`);
      if (stats.failed > 0) {
        process.stdout.write("Failed checks:\n");
        for (const failure of stats.failures) process.stdout.write(`  - ${failure}\n`);
      }
      return stats;
    },
  };
}
