/**
 * Full reproducible build.
 *
 *   node scripts/build.mjs
 *
 * Steps: clean -> typecheck -> bundle -> SEA blob -> executable -> checksums.
 * Requires only a local Node.js (>= 20) and `npm install` in this directory.
 * The produced executable in dist/ needs no Node.js, npm or npx at run time.
 *
 * The build is native: running it on Windows produces dist/ieee-mcp.exe, running
 * it on Linux produces dist/ieee-mcp-linux-amd64. Cross-building is refused, see
 * scripts/target.mjs.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { BUILD_DIR, DIST_DIR, bundle, typecheck } from "./bundle.mjs";
import { buildSea } from "./build-sea.mjs";
import { writeChecksums } from "./checksums.mjs";
import { TARGET } from "./target.mjs";

function clean() {
  for (const dir of [BUILD_DIR, DIST_DIR]) {
    fs.rmSync(dir, { recursive: true, force: true });
    process.stdout.write(`cleaned ${path.relative(process.cwd(), dir) || dir}\n`);
  }
}

async function main() {
  const started = Date.now();
  process.stdout.write(`ieee-mcp build (target ${TARGET.id}, host ${TARGET.host})\n`);

  clean();
  typecheck();
  bundle();
  const sea = await buildSea();
  const { sumsFile, info } = writeChecksums();

  process.stdout.write("\n-----------------------------------------\n");
  process.stdout.write(`built in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
  for (const artifact of info.artifacts) {
    process.stdout.write(`  ${artifact.path}  ${artifact.bytes} bytes\n`);
    process.stdout.write(`    sha256 ${artifact.sha256}\n`);
  }
  process.stdout.write(`checksums: ${sumsFile}\n`);
  process.stdout.write(
    `target=${sea.target}, useCodeCache=${sea.useCodeCache}, byte-reproducible=${sea.reproducible}, ` +
      `sea blob ${sea.blobSize} bytes\n`
  );
  process.stdout.write(
    sea.reproducible
      ? "Byte-reproducible: re-running the build produces the same SHA-256.\n"
      : "Note: with the V8 code cache enabled the executable is NOT byte-identical across rebuilds.\n"
  );
  process.stdout.write("\nRun the verification suite with: node test/run-all.mjs\n");
}

await main();
