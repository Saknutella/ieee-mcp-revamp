/**
 * Resilience: HTTP error classification, retry policy, retries consuming budget,
 * local daily budget enforcement, cross-process rate limiting and key redaction.
 */

import {
  byId,
  createReporter,
  defaultTarget,
  describeTarget,
  freshDir,
  mcpBatch,
  session,
  toolCall,
  toolJson,
} from "./harness.mjs";
import { startMockServer, createMockState } from "./mock-ieee-server.mjs";

const API_KEY = "0123456789abcdef0123456789abcdef";

function baseEnv(mock, stateDir, extra = {}) {
  return {
    IEEE_API_KEY: API_KEY,
    IEEE_API_BASE: mock.baseUrl,
    IEEE_MCP_STATE_DIR: stateDir,
    IEEE_LOG_LEVEL: "warn",
    IEEE_DAILY_BUDGET: "200",
    IEEE_MAX_RETRIES: "2",
    ...extra,
  };
}

function errorPayload(response) {
  const text = response?.result?.content?.[0]?.text ?? "";
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export async function run() {
  const reporter = createReporter("resilience");
  const target = defaultTarget();
  reporter.note(`target: ${describeTarget()}`);
  const mock = await startMockServer();

  try {
    // ── non-retryable statuses ───────────────────────────────────────────────
    reporter.section("non-retryable HTTP errors");

    const cases = [
      { status: 401, expected: "AUTH_ERROR", label: "401" },
      { status: 403, expected: "FORBIDDEN", label: "403" },
      { status: 400, expected: "BAD_REQUEST", label: "400" },
      { status: 404, expected: "NOT_FOUND", label: "404" },
    ];

    for (const testCase of cases) {
      mock.state.failures = [{ status: testCase.status, body: { message: `mock ${testCase.status}` }, times: 1 }];
      mock.state.requests.length = 0;
      const run = await mcpBatch(target, {
        label: `resilience-${testCase.label}`,
        env: baseEnv(mock, freshDir(`resilience-${testCase.label}`)),
        requests: session([toolCall(2, "search_papers", { querytext: `err${testCase.status}` })]),
      });
      const response = byId(run.responses, 2);
      const payload = errorPayload(response);
      reporter.check(`HTTP ${testCase.label} is reported as a tool error`, response?.result?.isError === true);
      reporter.equal(`HTTP ${testCase.label} maps to ${testCase.expected}`, payload.code, testCase.expected);
      reporter.equal(`HTTP ${testCase.label} is not retried`, mock.state.requests.length, 1);
      reporter.equal(`HTTP ${testCase.label} reports attempts`, payload.attempts, 1);
      reporter.equal(`HTTP ${testCase.label} keeps the API status`, payload.http_status, testCase.status);
      reporter.check(
        `HTTP ${testCase.label} keeps a scrubbed API code`,
        payload.api_code !== undefined && payload.api_code !== null,
        JSON.stringify(payload)
      );
      reporter.check(`HTTP ${testCase.label} is marked non-retryable`, payload.retryable === false);
    }

    // ── retry behaviour ──────────────────────────────────────────────────────
    reporter.section("retry policy");

    mock.state.failures = [{ status: 500, body: { message: "transient" }, times: 1 }];
    mock.state.requests.length = 0;
    const retryRun = await mcpBatch(target, {
      label: "resilience-retry-500",
      env: baseEnv(mock, freshDir("resilience-retry-500")),
      requests: session([toolCall(2, "search_papers", { querytext: "retry500" })]),
    });
    const retried = toolJson(byId(retryRun.responses, 2));
    reporter.check("a transient 500 is retried and then succeeds", retried !== null && retried.returned_records > 0, JSON.stringify(retried)?.slice(0, 200));
    reporter.equal("one retry consumed two HTTP requests", mock.state.requests.length, 2);
    reporter.check("the payload reports the attempt count", retried?.per_query?.[0]?.requests === 1, JSON.stringify(retried?.per_query));

    mock.state.failures = [
      { status: 429, body: { message: "slow down" }, headers: { "retry-after": "0" }, times: 1 },
    ];
    mock.state.requests.length = 0;
    const rateRetryRun = await mcpBatch(target, {
      label: "resilience-retry-429",
      env: baseEnv(mock, freshDir("resilience-retry-429"), { IEEE_MAX_RETRIES: "1" }),
      requests: session([toolCall(2, "search_papers", { querytext: "retry429" })]),
    });
    reporter.check("429 with Retry-After is retried once then succeeds", toolJson(byId(rateRetryRun.responses, 2)) !== null, byId(rateRetryRun.responses, 2)?.result?.content?.[0]?.text?.slice(0, 200));
    reporter.equal("429 retry used exactly two requests", mock.state.requests.length, 2);

    mock.state.failures = [{ status: 503, body: { message: "down" }, times: 10 }];
    mock.state.requests.length = 0;
    const exhaustRun = await mcpBatch(target, {
      label: "resilience-exhaust",
      env: baseEnv(mock, freshDir("resilience-exhaust"), { IEEE_MAX_RETRIES: "1" }),
      requests: session([toolCall(2, "search_papers", { querytext: "exhaust" })]),
    });
    const exhausted = errorPayload(byId(exhaustRun.responses, 2));
    reporter.equal("exhausted retries surface SERVER_ERROR", exhausted.code, "SERVER_ERROR");
    reporter.equal("exhausted retries report both attempts", exhausted.attempts, 2);
    reporter.equal("exhausted retries stopped after max_retries+1", mock.state.requests.length, 2);
    reporter.check("server errors are marked retryable", exhausted.retryable === true);

    // ── timeout ──────────────────────────────────────────────────────────────
    reporter.section("request timeout");
    mock.state.failures = [];
    mock.state.delayMs = 4000;
    mock.state.requests.length = 0;
    const timeoutRun = await mcpBatch(target, {
      label: "resilience-timeout",
      env: baseEnv(mock, freshDir("resilience-timeout"), { IEEE_TIMEOUT_MS: "1000", IEEE_MAX_RETRIES: "0" }),
      requests: session([toolCall(2, "search_papers", { querytext: "timeout" })]),
    });
    const timedOut = errorPayload(byId(timeoutRun.responses, 2));
    reporter.equal("timeout maps to TIMEOUT", timedOut.code, "TIMEOUT");
    reporter.check("timeout message mentions the configured budget", /1000 ms/.test(timedOut.message ?? ""), timedOut.message);
    reporter.equal("timeout was not retried (max_retries=0)", mock.state.requests.length, 1);
    mock.state.delayMs = 0;

    // ── retries consume budget ───────────────────────────────────────────────
    reporter.section("retries count against the local budget");
    mock.state.failures = [{ status: 500, body: { message: "transient" }, times: 5 }];
    mock.state.requests.length = 0;
    const budgetRetryRun = await mcpBatch(target, {
      label: "resilience-budget-retry",
      env: baseEnv(mock, freshDir("resilience-budget-retry"), { IEEE_DAILY_BUDGET: "2", IEEE_MAX_RETRIES: "2" }),
      requests: session([
        toolCall(2, "search_papers", { querytext: "budgetretry" }),
        toolCall(3, "search_papers", { querytext: "budgetretry2" }),
      ]),
    });
    reporter.equal("all budget was consumed by the retrying call", mock.state.requests.length, 2);
    const blocked = errorPayload(byId(budgetRetryRun.responses, 3));
    reporter.equal("the follow-up call is blocked by the budget guard", blocked.code, "BUDGET_EXCEEDED");
    reporter.check(
      "budget message states it is local, not the official quota",
      /NOT the official IEEE remaining quota/i.test(blocked.message ?? ""),
      blocked.message
    );

    // ── daily budget ─────────────────────────────────────────────────────────
    reporter.section("local daily budget");
    mock.state.failures = [];
    mock.state.requests.length = 0;
    const budgetRun = await mcpBatch(target, {
      label: "resilience-budget",
      env: baseEnv(mock, freshDir("resilience-budget"), { IEEE_DAILY_BUDGET: "1" }),
      requests: session([
        toolCall(2, "search_papers", { querytext: "budgeta" }),
        toolCall(3, "search_papers", { querytext: "budgetb" }),
        toolCall(4, "search_papers", { querytext: "budgetc" }),
      ]),
    });
    reporter.check("the first call within budget succeeds", toolJson(byId(budgetRun.responses, 2)) !== null);
    reporter.equal("subsequent calls within the same process are blocked", errorPayload(byId(budgetRun.responses, 3)).code, "BUDGET_EXCEEDED");
    reporter.equal("the blocked call sent no HTTP request", mock.state.requests.length, 1);
    const budgetStatus = toolJson(byId(budgetRun.responses, 2));
    reporter.equal("usage reports the configured budget", budgetStatus?.usage?.daily_budget, 1);
    reporter.equal("usage counts the local call", budgetStatus?.usage?.local_calls_utc_day, 1);
    reporter.check(
      "usage note disclaims the official quota",
      /NOT the official IEEE remaining quota/i.test(budgetStatus?.usage?.note ?? ""),
      budgetStatus?.usage?.note
    );

    // ── budget state is shared across processes ──────────────────────────────
    reporter.section("cross-process budget ledger");
    const sharedDir = freshDir("resilience-shared");
    mock.state.requests.length = 0;
    await mcpBatch(target, {
      label: "resilience-shared-1",
      env: baseEnv(mock, sharedDir, { IEEE_DAILY_BUDGET: "2" }),
      requests: session([toolCall(2, "search_papers", { querytext: "shared1" })]),
    });
    const secondProcess = await mcpBatch(target, {
      label: "resilience-shared-2",
      env: baseEnv(mock, sharedDir, { IEEE_DAILY_BUDGET: "2" }),
      requests: session([
        toolCall(2, "search_papers", { querytext: "shared2" }),
        toolCall(3, "search_papers", { querytext: "shared3" }),
      ]),
    });
    reporter.check("a second process sees the first process's usage", toolJson(byId(secondProcess.responses, 2)) !== null);
    reporter.equal(
      "the shared ledger blocks the third call across processes",
      errorPayload(byId(secondProcess.responses, 3)).code,
      "BUDGET_EXCEEDED"
    );
    reporter.equal("exactly two HTTP requests were made in total", mock.state.requests.length, 2);

    // ── cross-process rate limiting ──────────────────────────────────────────
    reporter.section("rate limiting");
    mock.state.requests.length = 0;
    const rateRun = await mcpBatch(target, {
      label: "resilience-rate",
      env: baseEnv(mock, freshDir("resilience-rate"), { IEEE_MAX_RPS: "2", IEEE_DAILY_BUDGET: "50" }),
      requests: session([
        toolCall(2, "search_papers", { querytext: "rate1" }),
        toolCall(3, "search_papers", { querytext: "rate2" }),
        toolCall(4, "search_papers", { querytext: "rate3" }),
        toolCall(5, "search_papers", { querytext: "rate4" }),
      ]),
    });
    reporter.equal("all four calls reached the API", mock.state.requests.length, 4);
    const timestamps = mock.state.requests.map((request) => request.at);
    const span = Math.max(...timestamps) - Math.min(...timestamps);
    reporter.check(
      `4 requests at 2 rps span at least ~1s (measured ${span}ms)`,
      span >= 900,
      `span ${span}ms over ${timestamps.length} requests`
    );
    reporter.check("every rate-limited call succeeded", [2, 3, 4, 5].every((id) => toolJson(byId(rateRun.responses, id)) !== null));

    // ── key redaction ────────────────────────────────────────────────────────
    reporter.section("secret redaction");
    mock.state.requests.length = 0;
    mock.state.failures = [
      {
        status: 401,
        body: { message: `Invalid API key supplied: ${API_KEY}`, apikey: API_KEY, echo: `apikey=${API_KEY}` },
        times: 1,
      },
    ];
    const redactRun = await mcpBatch(target, {
      label: "resilience-redact",
      env: baseEnv(mock, freshDir("resilience-redact")),
      requests: session([toolCall(2, "search_papers", { querytext: "redact" })]),
    });
    reporter.check(
      "the API key never reaches stdout",
      !redactRun.stdout.includes(API_KEY),
      redactRun.stdout.slice(0, 400)
    );
    reporter.check(
      "the API key never reaches stderr",
      !redactRun.stderr.includes(API_KEY),
      redactRun.stderr.slice(0, 600)
    );
    const redactedError = errorPayload(byId(redactRun.responses, 2));
    reporter.check(
      "the error payload is scrubbed",
      !JSON.stringify(redactedError).includes(API_KEY),
      JSON.stringify(redactedError)
    );
    reporter.check(
      "the redaction marker is present",
      JSON.stringify(redactedError).includes("[REDACTED]") || JSON.stringify(redactedError).includes("***"),
      JSON.stringify(redactedError)
    );
    reporter.check(
      "the URL logged to stderr is also scrubbed",
      !/apikey=[0-9a-f]{32}/i.test(redactRun.stderr),
      redactRun.stderr.slice(0, 500)
    );
    mock.state.failures = [];
  } finally {
    await mock.close();
  }

  return reporter.summary();
}
