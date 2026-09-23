/**
 * stderr-only logger with secret redaction.
 *
 * Hard rule: this module never writes to stdout. stdout is reserved for MCP
 * JSON-RPC framing; anything else on stdout corrupts the protocol stream.
 */

import process from "node:process";
import crypto from "node:crypto";

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";

const LEVEL_ORDER: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

const secrets = new Set<string>();

/** Register a literal secret value that must never appear in logs or errors. */
export function registerSecret(value: string | undefined | null): void {
  if (typeof value === "string" && value.trim().length >= 6) {
    secrets.add(value.trim());
  }
}

export function registeredSecretCount(): number {
  return secrets.size;
}

const APIKEY_QUERY_RE = /([?&]apikey=)[^&\s"'<>]*/gi;
const APIKEY_JSON_RE = /(["']?apikey["']?\s*[:=]\s*["']?)([A-Za-z0-9._~+/=-]{6,})/gi;
const APIKEY_XML_RE = /(<apikey>)[^<]*(<\/apikey>)/gi;
const BEARER_RE = /(\bBearer\s+)[A-Za-z0-9._~+/-]{6,}/gi;

function safeStringify(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    const seen = new WeakSet<object>();
    return JSON.stringify(value, (_k, v: unknown) => {
      if (typeof v === "object" && v !== null) {
        if (seen.has(v)) return "[circular]";
        seen.add(v);
      }
      return v;
    }) ?? String(value);
  } catch {
    try {
      return String(value);
    } catch {
      return "[unprintable]";
    }
  }
}

/**
 * Remove secrets from any string, URL, JSON blob or error envelope.
 * Applied to every log line and every error returned to the MCP client.
 */
export function redact(input: unknown): string {
  let text = typeof input === "string" ? input : safeStringify(input);
  for (const secret of secrets) {
    if (secret.length > 0) text = text.split(secret).join("[REDACTED]");
  }
  text = text.replace(APIKEY_QUERY_RE, "$1[REDACTED]");
  text = text.replace(APIKEY_JSON_RE, "$1[REDACTED]");
  text = text.replace(APIKEY_XML_RE, "$1[REDACTED]$2");
  text = text.replace(BEARER_RE, "$1[REDACTED]");
  return text;
}

/** Stable, non-reversible fingerprint so a key can be referenced in logs/reports. */
export function fingerprintSecret(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12);
}

let currentLevel: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

export function isLevelEnabled(level: Exclude<LogLevel, "silent">): boolean {
  return LEVEL_ORDER[currentLevel] >= LEVEL_ORDER[level];
}

function emit(level: Exclude<LogLevel, "silent">, message: string): void {
  if (!isLevelEnabled(level)) return;
  const line = `${new Date().toISOString()} [ieee-mcp] ${level.toUpperCase()} ${redact(message)}\n`;
  try {
    process.stderr.write(line);
  } catch {
    // stderr may be closed by the parent; never let logging break the server.
  }
}

export const log = {
  error: (message: string): void => emit("error", message),
  warn: (message: string): void => emit("warn", message),
  info: (message: string): void => emit("info", message),
  debug: (message: string): void => emit("debug", message),
};
