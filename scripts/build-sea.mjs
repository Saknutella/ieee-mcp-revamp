/**
 * Step 2 of the build: turn the bundle into a single-file executable using
 * Node's Single Executable Application (SEA) support.
 *
 *   1. emit the SEA preparation blob
 *   2. copy the running Node runtime (node.exe on Windows, node on Linux)
 *   3. on Windows, strip its Authenticode signature (required before injecting,
 *      and a signed PE whose hash no longer matches is rejected by some Windows
 *      policies)
 *   4. inject the blob with postject (pure JS, no child-process pipes)
 *   5. on Linux, mark the result executable
 *   6. smoke-test the result
 *
 * The result needs no Node.js installation on the target machine: it *is* the
 * Node runtime plus the bundled server.
 */

import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { BUILD_DIR, BUNDLE_FILE, DIST_DIR, EXE_FILE, REPO_ROOT, SEA_BLOB_FILE, SEA_CONFIG_FILE, runStep } from "./bundle.mjs";
import { ARTIFACT_NAME, TARGET } from "./target.mjs";

const require = createRequire(import.meta.url);
const SENTINEL_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

/**
 * postject flips the SEA sentinel fuse in the host binary, and the fuse string
 * has to be present for that to work. Official Node builds for every supported
 * target ship it, but a distro-patched or custom Node might not, so this is
 * checked up front to turn an opaque postject failure into a clear message.
 */
export function assertHostRuntimeHasSeaFuse(file = process.execPath) {
  const buffer = fs.readFileSync(file);
  if (!buffer.includes(SENTINEL_FUSE)) {
    throw new Error(
      `${path.basename(file)} does not contain the SEA sentinel fuse (${SENTINEL_FUSE}). ` +
        `Single-executable builds need an unpatched official Node build for ${TARGET.id}.`
    );
  }
  if (TARGET.format === "elf" && !buffer.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    throw new Error(`${path.basename(file)} is not an ELF image; it cannot host a ${TARGET.id} build.`);
  }
  return { bytes: buffer.length, format: TARGET.format };
}

/**
 * Windows refuses to load a PE whose Authenticode hash no longer matches, and
 * postject modifies the file, so the certificate table is removed first.
 * Returns what was found instead of assuming the binary was signed.
 */
export function stripAuthenticodeSignature(file) {
  const buffer = fs.readFileSync(file);
  if (buffer.length < 0x40 || buffer.readUInt16LE(0) !== 0x5a4d) {
    return { stripped: false, reason: "not a PE image (no MZ header)" };
  }
  const peOffset = buffer.readUInt32LE(0x3c);
  if (peOffset + 24 > buffer.length || buffer.readUInt32LE(peOffset) !== 0x00004550) {
    return { stripped: false, reason: "no PE\\0\\0 signature" };
  }

  const optionalHeaderOffset = peOffset + 24;
  const magic = buffer.readUInt16LE(optionalHeaderOffset);
  let numberOfRvaAndSizesOffset;
  let dataDirectoryOffset;
  if (magic === 0x10b) {
    numberOfRvaAndSizesOffset = optionalHeaderOffset + 92;
    dataDirectoryOffset = optionalHeaderOffset + 96;
  } else if (magic === 0x20b) {
    numberOfRvaAndSizesOffset = optionalHeaderOffset + 108;
    dataDirectoryOffset = optionalHeaderOffset + 112;
  } else {
    return { stripped: false, reason: `unsupported optional header magic 0x${magic.toString(16)}` };
  }
  if (optionalHeaderOffset + 120 > buffer.length) {
    return { stripped: false, reason: "optional header is truncated" };
  }

  const numberOfRvaAndSizes = buffer.readUInt32LE(numberOfRvaAndSizesOffset);
  if (numberOfRvaAndSizes < 5) {
    return { stripped: false, reason: "no IMAGE_DIRECTORY_ENTRY_SECURITY slot" };
  }

  // Data directory entry 4 is the certificate table: { file offset, size }.
  const certificateEntry = dataDirectoryOffset + 4 * 8;
  const certificateOffset = buffer.readUInt32LE(certificateEntry);
  const certificateSize = buffer.readUInt32LE(certificateEntry + 4);
  if (certificateOffset === 0 || certificateSize === 0) {
    return { stripped: false, reason: "image is not Authenticode-signed" };
  }

  buffer.writeUInt32LE(0, certificateEntry);
  buffer.writeUInt32LE(0, certificateEntry + 4);
  // The certificate table always sits at the end of the image; drop those bytes.
  const keep = Math.min(certificateOffset, buffer.length);
  fs.writeFileSync(file, buffer.subarray(0, keep));
  return { stripped: true, certificateOffset, certificateSize, truncatedTo: keep };
}

export function writeSeaConfig(useCodeCache) {
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  const config = {
    main: path.relative(REPO_ROOT, BUNDLE_FILE).split(path.sep).join("/"),
    output: path.relative(REPO_ROOT, SEA_BLOB_FILE).split(path.sep).join("/"),
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache,
  };
  fs.writeFileSync(SEA_CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return config;
}

export function buildBlob(useCodeCache) {
  writeSeaConfig(useCodeCache);
  runStep("prepare SEA blob (node --experimental-sea-config)", process.execPath, [
    `--experimental-sea-config=${SEA_CONFIG_FILE}`,
  ]);
  if (!fs.existsSync(SEA_BLOB_FILE)) {
    throw new Error(`SEA blob was not produced at ${SEA_BLOB_FILE}`);
  }
  return fs.statSync(SEA_BLOB_FILE).size;
}

export async function injectBlob() {
  const host = assertHostRuntimeHasSeaFuse();
  process.stdout.write(`    host runtime: ${process.execPath} (${host.bytes} bytes, ${host.format})\n`);

  fs.mkdirSync(DIST_DIR, { recursive: true });
  fs.copyFileSync(process.execPath, EXE_FILE);

  // Only a PE image carries an Authenticode certificate table.
  if (TARGET.format === "pe") {
    const signature = stripAuthenticodeSignature(EXE_FILE);
    process.stdout.write(
      signature.stripped
        ? `    stripped Authenticode signature (${signature.certificateSize} bytes)\n`
        : `    no signature to strip: ${signature.reason}\n`
    );
  }

  const postject = require("postject");
  await postject.inject(EXE_FILE, "NODE_SEA_BLOB", fs.readFileSync(SEA_BLOB_FILE), {
    sentinelFuse: SENTINEL_FUSE,
  });

  // postject rewrites the file; restore the executable bit afterwards.
  if (TARGET.needsExecBit) {
    fs.chmodSync(EXE_FILE, 0o755);
    process.stdout.write(`    chmod 0755 ${ARTIFACT_NAME}\n`);
  }
  return fs.statSync(EXE_FILE).size;
}

export function smokeTest() {
  // File-descriptor stdio: works even where child-process pipes are blocked.
  const outFile = path.join(BUILD_DIR, "self-test.stdout.log");
  const errFile = path.join(BUILD_DIR, "self-test.stderr.log");
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  const outFd = fs.openSync(outFile, "w");
  const errFd = fs.openSync(errFile, "w");
  let result;
  try {
    result = spawnSync(EXE_FILE, ["--self-test"], {
      stdio: ["ignore", outFd, errFd],
      windowsHide: true,
      env: process.env,
    });
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
  const stdout = fs.readFileSync(outFile, "utf8");
  const stderr = fs.readFileSync(errFile, "utf8");

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`packaged executable --self-test exited with ${result.status}:\n${stderr}`);
  }
  if (!stderr.includes("ieee-mcp") || !stderr.includes("exec_path")) {
    throw new Error(`packaged executable --self-test produced unexpected output:\n${stderr}`);
  }
  if (stdout.trim().length !== 0) {
    throw new Error(`packaged executable wrote to stdout in --self-test mode:\n${stdout}`);
  }
  return JSON.parse(stderr.slice(stderr.indexOf("{")));
}

export async function buildSea(options = {}) {
  if (!fs.existsSync(BUNDLE_FILE)) {
    throw new Error(`Missing ${BUNDLE_FILE}. Run scripts/bundle.mjs first.`);
  }
  // `useCodeCache: true` embeds a V8 code cache, which makes the blob - and
  // therefore the executable - differ between otherwise identical builds.
  // Measured startup is the same either way (~73 ms), so the code cache is off
  // by default and the executable is byte-reproducible. Set
  // IEEE_BUILD_CODE_CACHE=1 to opt into it.
  const codeCacheRequested = options.useCodeCache ?? process.env.IEEE_BUILD_CODE_CACHE === "1";
  let blobSize;
  let useCodeCache = codeCacheRequested;
  try {
    blobSize = buildBlob(useCodeCache);
  } catch (error) {
    process.stdout.write(`    SEA blob build failed (${error.message}); retrying without a code cache\n`);
    useCodeCache = false;
    blobSize = buildBlob(useCodeCache);
  }
  const exeSize = await injectBlob();
  const report = smokeTest();
  return { target: TARGET.id, blobSize, exeSize, useCodeCache, reproducible: !useCodeCache, report };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await buildSea();
  process.stdout.write(
    `\nSEA executable (${result.target}): ${EXE_FILE}\n  blob ${result.blobSize} bytes, exe ${result.exeSize} bytes, ` +
      `useCodeCache=${result.useCodeCache}, reproducible=${result.reproducible}\n`
  );
}
