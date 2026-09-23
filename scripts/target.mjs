/**
 * Build target resolution.
 *
 * A single-file executable (Node SEA) is produced by injecting the SEA blob
 * into a copy of the Node runtime, and the blob is produced by the Node that
 * runs the build. Host and target therefore have to match: this is a
 * native-only build.
 *
 * Cross-building is refused rather than attempted. An artifact that cannot be
 * executed on the machine that produced it cannot be tested either, and this
 * project does not ship binaries that have not been run. To build for the other
 * platform, use .github/workflows/build.yml, which builds each target on a real
 * runner of that platform and runs the whole suite there.
 */

import process from "node:process";

/**
 * Supported targets. An entry belongs here only once CI has proven that the
 * target builds, passes the full suite, and produces a working executable.
 */
const TARGETS = {
  "win32-x64": {
    os: "windows",
    format: "pe",
    artifact: "ieee-mcp.exe",
    runtime: "node.exe",
    // Requires no chmod: the copied runtime is already executable.
    needsExecBit: false,
  },
  "linux-x64": {
    os: "linux",
    format: "elf",
    artifact: "ieee-mcp-linux-amd64",
    runtime: "node",
    // The injected copy must be marked executable before it can be run.
    needsExecBit: true,
  },
};

export const HOST_TARGET = `${process.platform}-${process.arch}`;
export const SUPPORTED_TARGETS = Object.keys(TARGETS);

export function resolveTarget(requested = process.env.IEEE_BUILD_TARGET) {
  const trimmed = requested === undefined || requested === null ? "" : String(requested).trim();
  const id = trimmed === "" ? HOST_TARGET : trimmed;

  const spec = TARGETS[id];
  if (!spec) {
    throw new Error(
      `Unsupported build target "${id}". Supported targets: ${SUPPORTED_TARGETS.join(", ")}. ` +
        `This host is ${HOST_TARGET}.`
    );
  }
  if (id !== HOST_TARGET) {
    throw new Error(
      `Cannot cross-build ${id} on ${HOST_TARGET}. A single-file executable is built by injecting the SEA ` +
        `blob into a copy of the target platform's Node runtime, so it can only be executed — and therefore ` +
        `tested — on that platform. Build on a ${spec.os} machine, or run the ` +
        `.github/workflows/build.yml workflow, which builds each target on its own runner.`
    );
  }
  return { id, ...spec, host: HOST_TARGET };
}

/** The target this process can build and test: always the host platform. */
export const TARGET = resolveTarget();

/** File name of the delivered executable inside dist/. */
export const ARTIFACT_NAME = TARGET.artifact;
