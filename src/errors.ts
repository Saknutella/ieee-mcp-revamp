/**
 * Error taxonomy.
 *
 * Every error surfaced to an MCP client carries a stable machine code, and the
 * human readable text is always passed through `redact()` first so an API key
 * can never leak through an error path.
 */

import { redact } from "./logger.js";

export type IeeeErrorCode =
  | "CONFIG_ERROR"
  | "INPUT_ERROR"
  | "BUDGET_EXCEEDED"
  | "RATE_LIMITED"
  | "AUTH_ERROR"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "BAD_REQUEST"
  | "SERVER_ERROR"
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "INTERNAL_ERROR";

export interface IeeeMcpErrorInit {
  code: IeeeErrorCode;
  message: string;
  httpStatus?: number | null;
  retryable?: boolean;
  /** Machine readable code/message returned by the IEEE API, already scrubbed. */
  apiCode?: string | null;
  apiMessage?: string | null;
  attempts?: number;
  hint?: string | null;
  cause?: unknown;
}

export class IeeeMcpError extends Error {
  readonly code: IeeeErrorCode;
  readonly httpStatus: number | null;
  readonly retryable: boolean;
  readonly apiCode: string | null;
  readonly apiMessage: string | null;
  readonly attempts: number;
  readonly hint: string | null;

  constructor(init: IeeeMcpErrorInit) {
    super(redact(init.message));
    this.name = "IeeeMcpError";
    this.code = init.code;
    this.httpStatus = init.httpStatus ?? null;
    this.retryable = init.retryable ?? false;
    this.apiCode = init.apiCode ? redact(init.apiCode) : null;
    this.apiMessage = init.apiMessage ? redact(init.apiMessage) : null;
    this.attempts = init.attempts ?? 0;
    this.hint = init.hint ?? null;
    if (init.cause !== undefined) {
      (this as { cause?: unknown }).cause = init.cause;
    }
  }

  toJSON(): Record<string, unknown> {
    return {
      ok: false,
      code: this.code,
      message: this.message,
      http_status: this.httpStatus,
      retryable: this.retryable,
      api_code: this.apiCode,
      api_message: this.apiMessage,
      attempts: this.attempts,
      hint: this.hint,
    };
  }
}

export class ConfigError extends IeeeMcpError {
  constructor(message: string, hint?: string) {
    super({ code: "CONFIG_ERROR", message, hint: hint ?? null });
    this.name = "ConfigError";
  }
}

export class InputError extends IeeeMcpError {
  constructor(message: string, hint?: string) {
    super({ code: "INPUT_ERROR", message, hint: hint ?? null });
    this.name = "InputError";
  }
}

export class BudgetExceededError extends IeeeMcpError {
  constructor(message: string, hint?: string) {
    super({ code: "BUDGET_EXCEEDED", message, retryable: false, hint: hint ?? null });
    this.name = "BudgetExceededError";
  }
}

/** Normalize any thrown value into an IeeeMcpError without leaking details. */
export function toIeeeMcpError(error: unknown): IeeeMcpError {
  if (error instanceof IeeeMcpError) return error;
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : `Unexpected error: ${String(error)}`;
  return new IeeeMcpError({ code: "INTERNAL_ERROR", message, hint: null });
}
