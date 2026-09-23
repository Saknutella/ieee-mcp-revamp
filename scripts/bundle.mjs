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

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const BUILD_DIR = path.join(REPO_ROOT, "build");
export const DIST_DIR = path.join(REPO_ROOT, "dist");
export const BUNDLE_FILE = path.join(BUILD_DIR, "bundle.cjs");
export const SEA_CONFIG_FILE = path.join(BUILD_DIR, "sea-config.json");
export const SEA_BLOB_FILE = path.join(BUILD_DIR, "ieee-mcp.blob");
export const EXE_FILE = path.join(DIST_DIR, "ieee-mcp.exe");

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

export function bundle() {
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  runStep("bundle (esbuild --format=cjs)", process.execPath, [
    path.join(REPO_ROOT, "node_modules", "esbuild", "bin", "esbuild"),
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
