/**
 * Checksums and build provenance for the shipped artifacts.
 *
 * Emits `dist/SHA256SUMS.txt` in the standard `sha256sum` format (LF endings)
 * plus `dist/BUILD-INFO.json` recording exactly which toolchain produced the
 * binary.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { BUNDLE_FILE, DIST_DIR, EXE_FILE, REPO_ROOT, SEA_BLOB_FILE } from "./bundle.mjs";
import { ARTIFACT_NAME, TARGET } from "./target.mjs";

export function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function packageVersion(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "node_modules", name, "package.json"), "utf8")).version;
  } catch {
    return "unknown";
  }
}

export function writeChecksums() {
  fs.mkdirSync(DIST_DIR, { recursive: true });
  const artifacts = [EXE_FILE, BUNDLE_FILE, SEA_BLOB_FILE].filter((file) => fs.existsSync(file));
  if (artifacts.length === 0) throw new Error("No artifacts to checksum; run the build first.");

  const lines = artifacts.map((file) => {
    const relative = path.relative(REPO_ROOT, file).split(path.sep).join("/");
    return `${sha256File(file)}  ${relative}`;
  });
  const sumsFile = path.join(DIST_DIR, "SHA256SUMS.txt");
  fs.writeFileSync(sumsFile, `${lines.join("\n")}\n`, { encoding: "utf8" });

  const info = {
    generated_at: new Date().toISOString(),
    target: TARGET.id,
    artifact: ARTIFACT_NAME,
    node: process.version,
    v8: process.versions.v8,
    platform: `${process.platform}-${process.arch}`,
    esbuild: packageVersion("esbuild"),
    postject: packageVersion("postject"),
    typescript: packageVersion("typescript"),
    "modelcontextprotocol/sdk": packageVersion("@modelcontextprotocol/sdk"),
    zod: packageVersion("zod"),
    artifacts: artifacts.map((file) => ({
      path: path.relative(REPO_ROOT, file).split(path.sep).join("/"),
      bytes: fs.statSync(file).size,
      sha256: sha256File(file),
    })),
  };
  fs.writeFileSync(path.join(DIST_DIR, "BUILD-INFO.json"), `${JSON.stringify(info, null, 2)}\n`, "utf8");

  return { sumsFile, info };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { sumsFile, info } = writeChecksums();
  process.stdout.write(`Wrote ${sumsFile}\n`);
  for (const artifact of info.artifacts) {
    process.stdout.write(`  ${artifact.sha256}  ${artifact.path} (${artifact.bytes} bytes)\n`);
  }
}
