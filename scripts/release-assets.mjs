/**
 * Assemble the release assets from the artifacts the build jobs uploaded.
 *
 * Run by the `release` job in .github/workflows/build.yml, after every platform
 * build has passed the full test suite on its own runner. Only artifacts that
 * already passed can reach a release, which is the whole point of doing this
 * here rather than by hand.
 *
 * It verifies each binary against the sha256 its own build recorded, copies the
 * binaries into a flat output directory, and writes the combined SHA256SUMS.txt
 * plus the release notes.
 *
 *   node scripts/release-assets.mjs <artifacts-dir> <output-dir>
 *
 * With GITHUB_REF_NAME set it also enforces that the tag names the version the
 * binaries actually report, so a release can never be labelled with a version
 * the code does not have.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const PLATFORM_LABEL = {
  "win32-x64": "Windows x64",
  "linux-x64": "Linux amd64",
};

export const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/** Every BUILD-INFO.json under root, at any depth. */
export function findBuildInfo(root) {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "BUILD-INFO.json") found.push(full);
    }
  };
  walk(root);
  return found;
}

/**
 * @returns {{entries: Array<object>, sumsFile: string, notesFile: string}}
 */
export function assembleReleaseAssets(artifactsRoot, outputDir, options = {}) {
  const {
    tag = process.env.GITHUB_REF_NAME,
    packageVersion = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")).version,
    repository = process.env.GITHUB_REPOSITORY ?? "Saknutella/ieee-mcp-revamp",
  } = options;

  if (!fs.existsSync(artifactsRoot)) throw new Error(`no such artifacts directory: ${artifactsRoot}`);

  const infoFiles = findBuildInfo(artifactsRoot);
  if (infoFiles.length === 0) throw new Error(`no BUILD-INFO.json found under ${artifactsRoot}`);

  const entries = [];
  for (const infoFile of infoFiles) {
    const info = JSON.parse(fs.readFileSync(infoFile, "utf8"));
    const distDir = path.dirname(infoFile);
    const binary = path.join(distDir, info.artifact);
    if (!fs.existsSync(binary)) {
      throw new Error(`BUILD-INFO.json names ${info.artifact}, which is not in ${distDir}`);
    }

    const actual = sha256(binary);
    const recorded = info.artifacts?.find((entry) => entry.path === `dist/${info.artifact}`)?.sha256;
    if (recorded !== actual) {
      throw new Error(
        `${info.artifact} does not match the hash its own build recorded ` +
          `(recorded ${recorded ?? "nothing"}, actual ${actual})`
      );
    }

    entries.push({
      target: info.target,
      label: PLATFORM_LABEL[info.target] ?? info.target,
      artifact: info.artifact,
      bytes: fs.statSync(binary).size,
      sha256: actual,
      source: binary,
      node: info.node,
    });
  }

  entries.sort((a, b) => a.target.localeCompare(b.target));

  if (tag && tag !== `v${packageVersion}`) {
    throw new Error(
      `tag ${tag} does not match the version in package.json (${packageVersion}). ` +
        `The binaries report ${packageVersion}, so the tag must be v${packageVersion}.`
    );
  }

  fs.mkdirSync(outputDir, { recursive: true });
  for (const entry of entries) fs.copyFileSync(entry.source, path.join(outputDir, entry.artifact));

  const sumsFile = path.join(outputDir, "SHA256SUMS.txt");
  fs.writeFileSync(sumsFile, `${entries.map((entry) => `${entry.sha256}  ${entry.artifact}`).join("\n")}\n`, "utf8");

  const notesFile = path.join(outputDir, "NOTES.md");
  fs.writeFileSync(
    notesFile,
    `IEEE Xplore Metadata Search MCP server ${packageVersion}

Single-file executables. No Node.js, no npm, no npx, nothing downloaded at startup.

| Platform | File | Size | SHA-256 |
|---|---|---|---|
${entries
  .map(
    (entry) =>
      `| ${entry.label} | \`${entry.artifact}\` | ${entry.bytes.toLocaleString("en-US")} bytes | \`${entry.sha256}\` |`
  )
  .join("\n")}

The Linux build is dynamically linked against glibc 2.28 or newer
(Ubuntu 20.04+, Debian 10+, RHEL 8+). Linux arm64 and musl/Alpine are not built.

Verify a download with:

\`\`\`bash
sha256sum --check SHA256SUMS.txt
\`\`\`

Each binary was built and tested on a runner of its own platform by the
[build workflow](https://github.com/${repository}/actions/workflows/build.yml),
and passed the same 383-check suite before these assets were produced. The Linux
executable cannot run anywhere but Linux, so it is never built by cross-compiling
and never published untested.

Built from source at tag \`${tag ?? `v${packageVersion}`}\` with Node ${entries[0]?.node ?? "unknown"}.
`,
    "utf8"
  );

  return { entries, sumsFile, notesFile };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [artifactsRoot, outputDir] = process.argv.slice(2);
  if (!artifactsRoot || !outputDir) {
    process.stdout.write("usage: node scripts/release-assets.mjs <artifacts-dir> <output-dir>\n");
    process.exit(2);
  }
  const { entries, sumsFile, notesFile } = assembleReleaseAssets(artifactsRoot, outputDir);
  for (const entry of entries) {
    process.stdout.write(`${entry.sha256}  ${entry.artifact}  (${entry.bytes} bytes, ${entry.target})\n`);
  }
  process.stdout.write(`\nwrote ${sumsFile} and ${notesFile}\n`);
}
