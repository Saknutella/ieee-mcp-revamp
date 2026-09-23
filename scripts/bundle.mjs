/**
 * Step 1 of the build: bundle the TypeScript sources into one CommonJS file.
 *
 * The esbuild *CLI* is used deliberately. Its JavaScript API talks to the
 * esbuild binary over stdio pipes, which some restricted Windows sandboxes
 * block; the CLI passes its stdio through instead.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { ARTIFACT_NAME, TARGET } from "./target.mjs";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const BUILD_DIR = path.join(REPO_ROOT, "build");
export const DIST_DIR = path.join(REPO_ROOT, "dist");
export const BUNDLE_FILE = path.join(BUILD_DIR, "bundle.cjs");
export const SEA_CONFIG_FILE = path.join(BUILD_DIR, "sea-config.json");
export const SEA_BLOB_FILE = path.join(BUILD_DIR, "ieee-mcp.blob");
// Named per target: ieee-mcp.exe on Windows, ieee-mcp-linux-amd64 on Linux.
export const EXE_FILE = path.join(DIST_DIR, ARTIFACT_NAME);
export { ARTIFACT_NAME, TARGET };

export function runStep(label, command, args, options = {}) {
  process.stdout.write(`\n>>> ${label}\n    ${path.basename(command)} ${args.join(" ")}\n`);
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? REPO_ROOT,
    stdio: "inherit",
    windowsHide: true,
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status}`);
  }
}

export function typecheck() {
  runStep("typecheck (tsc --noEmit)", process.execPath, [
    path.join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc"),
    "--noEmit",
  ]);
}

/**
 * How to invoke the esbuild CLI on this machine.
 *
 * The esbuild package ships `bin/esbuild` as a Node script on Windows but as the
 * native executable on Linux and macOS, so `node bin/esbuild` only works on
 * Windows — on Linux Node tries to parse an ELF image and dies with
 * "SyntaxError: Invalid or unexpected token". The file header is inspected
 * instead of the platform being assumed.
 */
function esbuildCommand() {
  const shim = path.join(REPO_ROOT, "node_modules", "esbuild", "bin", "esbuild");
  const head = fs.readFileSync(shim).subarray(0, 4);
  const isNative =
    (head[0] === 0x4d && head[1] === 0x5a) || // MZ — a PE image
    (head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46); // \x7fELF

  if (!isNative) return { command: process.execPath, args: [shim], how: "node script" };

  // A native binary has to be executable. npm normally sets this, but the build
  // should not fail for want of a permission bit.
  try {
    fs.accessSync(shim, fs.constants.X_OK);
  } catch {
    fs.chmodSync(shim, 0o755);
  }
  return { command: shim, args: [], how: "native binary" };
}

export function bundle() {
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  const esbuild = esbuildCommand();
  runStep(`bundle (esbuild, ${esbuild.how})`, esbuild.command, [
    ...esbuild.args,
    path.join(REPO_ROOT, "src", "index.ts"),
    "--bundle",
    "--platform=node",
    "--format=cjs",
    "--target=node20",
    "--outfile=" + BUNDLE_FILE,
    "--legal-comments=none",
    "--log-level=warning",
  ]);
  const size = fs.statSync(BUNDLE_FILE).size;
  process.stdout.write(`    bundle: ${BUNDLE_FILE} (${size} bytes)\n`);
  return size;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  typecheck();
  bundle();
}
