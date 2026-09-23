/**
 * File export: UTF-8 CSV / JSON / BibTeX, always accompanied by a provenance
 * sidecar that records the source database and the exact search conditions.
 */

import fs from "node:fs";
import path from "node:path";

import { InputError } from "./errors.js";
import { log } from "./logger.js";
import type { Config } from "./config.js";
import { atomicWriteFileSync, ensureDir, resolveUserPath, sha256Hex } from "./store.js";
import { toBibtex, toCsv, toJsonText } from "./format.js";
import type { PaperRecord } from "./types.js";

export type ExportFormat = "csv" | "json" | "bibtex";

const EXTENSIONS: Record<ExportFormat, string> = {
  csv: ".csv",
  json: ".json",
  bibtex: ".bib",
};

export interface ExportMeta {
  searchId: string;
  source: string;
  endpoint: string;
  retrievedAt: string;
  query: Record<string, unknown>;
  totalRecords: number | null;
  searchScope: string;
  server: string;
  warnings?: string[];
}

export interface ExportOutcome {
  format: ExportFormat;
  output_path: string;
  sidecar_path: string;
  records: number;
  bytes: number;
  sha256: string;
  encoding: string;
  generated_at: string;
}

function withExtension(target: string, format: ExportFormat): string {
  const ext = path.extname(target).toLowerCase();
  if (ext.length > 0) return target;
  return `${target}${EXTENSIONS[format]}`;
}

export function defaultExportName(format: ExportFormat, searchId: string): string {
  return `ieee-${searchId}${EXTENSIONS[format]}`;
}

export function exportRecords(
  config: Config,
  options: {
    format: ExportFormat;
    outputPath: string;
    records: PaperRecord[];
    meta: ExportMeta;
  }
): ExportOutcome {
  const { format, records, meta } = options;

  if (records.length === 0) {
    throw new InputError(
      "Nothing to export: the record set is empty.",
      "Run a search first, or pass explicit records."
    );
  }

  let target: string;
  try {
    target = withExtension(resolveUserPath(options.outputPath, config.outputDir), format);
  } catch (error) {
    throw new InputError(
      `Invalid output path: ${String(error)}`,
      "Use an absolute path, or a relative path resolved against IEEE_OUTPUT_DIR / the working directory."
    );
  }

  let body: string;
  if (format === "csv") {
    body = toCsv(records, meta.retrievedAt, meta.searchId);
  } else if (format === "bibtex") {
    body = toBibtex(records, {
      queryId: meta.searchId,
      retrievedAt: meta.retrievedAt,
      endpoint: meta.endpoint,
      query: meta.query,
    });
  } else {
    body = `${toJsonText({ meta, records })}\n`;
  }

  const sidecar = `${target}.meta.json`;
  const sidecarBody = `${toJsonText({
    ...meta,
    exported_at: new Date().toISOString(),
    exported_format: format,
    exported_records: records.length,
    output_file: path.basename(target),
  })}\n`;

  try {
    ensureDir(path.dirname(target));
    atomicWriteFileSync(target, body);
    atomicWriteFileSync(sidecar, sidecarBody);
  } catch (error) {
    throw new InputError(
      `Could not write export file: ${String(error)}`,
      "Check that the directory exists and is writable, and that no other program has the file open."
    );
  }

  const bytes = Buffer.byteLength(body, "utf8");
  log.info(`Exported ${records.length} records as ${format} to ${target} (${bytes} bytes).`);

  return {
    format,
    output_path: target,
    sidecar_path: sidecar,
    records: records.length,
    bytes,
    sha256: sha256Hex(body),
    encoding: format === "csv" ? "UTF-8 with BOM" : "UTF-8",
    generated_at: new Date().toISOString(),
  };
}

export function fileExists(target: string): boolean {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}
