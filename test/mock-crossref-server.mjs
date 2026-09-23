/**
 * Deterministic Crossref REST API mock.
 *
 * Mirrors the response shape this project actually relies on:
 *   GET /works/{doi}                                  -> { status, message: { ..., reference: [...] } }
 *   GET /works/{doi}/transform/application/x-bibtex   -> BibTeX text
 *
 * The fixtures reproduce the real-world cases that drove the implementation:
 * references deposited without a DOI, a `references-count` that disagrees with
 * the array, and a paper with no references at all.
 *
 * Run standalone: node test/mock-crossref-server.mjs
 */

import http from "node:http";
import process from "node:process";

/** DOIs containing this marker answer 404, like a DOI Crossref has never seen. */
export const MISSING_MARKER = "10.9999/missing";

/** Small deterministic hash, used to emulate Crossref's non-citation-order arrays. */
function keyHash(key) {
  let hash = 7;
  for (const char of String(key)) hash = (hash * 31 + char.charCodeAt(0)) % 100003;
  return hash;
}

function referenceEntry(order, overrides = {}) {
  return {
    key: `ref${order}`,
    "doi-asserted-by": "publisher",
    DOI: `10.1109/MOCK.${2000 + order}.${order}`,
    "article-title": `Mock reference ${order}`,
    author: `author${order}`,
    year: String(2000 + order),
    "journal-title": order % 2 === 0 ? "Mock Journal of Circuits" : "Mock Proc. of Symp. on Circuits",
    "first-page": String(100 + order),
    ...overrides,
  };
}

/** Fixture list consumed by `selectReferences`. */
export const FIXTURES = {
  // Mirrors IEEE TCSII 2021: 14 references, 10 with DOI, 4 without (ref3/5/7/13).
  // `scramble` reproduces the real API behaviour of returning `reference` in
  // deposit order rather than citation order. ref2/ref6 emulate the very common
  // case of a reference deposited with a DOI and NO other field.
  "10.1109/mock.tcsii.2021": {
    title: "A mock paper with fourteen references",
    scramble: true,
    doiOnly: [2, 6],
    references: Array.from({ length: 14 }, (_, i) => {
      const order = i + 1;
      if ([2, 6].includes(order)) {
        return {
          key: `ref${order}`,
          "doi-asserted-by": "publisher",
          DOI: `10.1109/MOCK.${2000 + order}.${order}`,
        };
      }
      const withoutDoi = [3, 5, 7, 13].includes(order);
      return withoutDoi
        ? referenceEntry(order, {
            DOI: undefined,
            "doi-asserted-by": undefined,
            "article-title": `Reference ${order} deposited without a DOI`,
            author: `author${order}`,
          })
        : referenceEntry(order);
    }),
  },
  // Mirrors ESSCIRC 2019: 7 references, 6 with DOI, 1 without.
  "10.1109/mock.esscirc.2019": {
    title: "A mock paper with seven references",
    references: [
      ...Array.from({ length: 5 }, (_, i) => referenceEntry(i + 1)),
      referenceEntry(6, { DOI: undefined, "article-title": "93% power reduction by automatic self power gating", author: "iguchi" }),
      referenceEntry(7),
    ],
  },
  "10.1109/mock.norefs": {
    title: "A mock paper without any deposited references",
    references: [],
    omitReferenceArray: true,
  },
  // references-count deliberately disagrees with the array length.
  "10.1109/mock.mismatch": {
    title: "A mock paper whose count disagrees with its array",
    references: [referenceEntry(1), referenceEntry(2), referenceEntry(3)],
    referencesCountOverride: 9,
  },
};

export function createMockCrossrefState(overrides = {}) {
  return {
    failures: [],
    delayMs: 0,
    requests: [],
    /** Counts served responses so tests can assert caching. */
    served: 0,
    ...overrides,
  };
}

function syntheticDoiReferences(doi) {
  // Any other DOI gets a deterministic, small reference list so tests that start
  // from an IEEE search result (whose DOIs are arbitrary) still work.
  let hash = 0;
  for (const char of doi) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const count = 2 + (hash % 4);
  return Array.from({ length: count }, (_, i) => referenceEntry(i + 1));
}

export function buildWork(doi) {
  const fixture = FIXTURES[doi];
  if (fixture) {
    const message = {
      DOI: doi,
      title: [fixture.title],
      "container-title": ["Mock Transactions on Testing"],
      publisher: "Mock Publisher",
      type: "journal-article",
      issued: { "date-parts": [[2021, 5, 4]] },
      volume: "68",
      issue: "11",
      page: "3386-3390",
      ISSN: ["1549-7747"],
      author: [{ given: "Mock", family: "Author" }],
      "references-count": fixture.referencesCountOverride ?? fixture.references.length,
      "is-referenced-by-count": 2,
      deposited: { "date-time": "2022-05-10T00:00:00Z" },
      indexed: { "date-time": "2025-04-08T00:00:00Z" },
    };
    if (!fixture.omitReferenceArray) {
      message.reference = fixture.scramble
        ? [...fixture.references].sort((a, b) => keyHash(a.key) - keyHash(b.key))
        : fixture.references;
    }
    return message;
  }
  const references = syntheticDoiReferences(doi);
  return {
    DOI: doi,
    title: [`Mock work for ${doi}`],
    "container-title": ["Mock Journal"],
    publisher: "Mock Publisher",
    type: "journal-article",
    issued: { "date-parts": [[2020, 1, 1]] },
    "references-count": references.length,
    "is-referenced-by-count": 0,
    deposited: { "date-time": "2021-01-01T00:00:00Z" },
    indexed: { "date-time": "2022-01-01T00:00:00Z" },
    reference: references,
  };
}

export function createMockCrossrefServer(state = createMockCrossrefState()) {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    let rest = url.pathname.replace(/^\/works\//, "");
    let transform = null;
    const transformIndex = rest.indexOf("/transform/");
    if (transformIndex >= 0) {
      transform = rest.slice(transformIndex + "/transform/".length);
      rest = rest.slice(0, transformIndex);
    }
    const isBatch = url.pathname === "/works" || url.pathname === "/works/";
    const batchDois = isBatch
      ? (url.searchParams.get("filter") ?? "")
          .split(",")
          .map((pair) => pair.trim())
          .filter((pair) => pair.startsWith("doi:"))
          .map((pair) => pair.slice(4))
      : [];
    const doi = isBatch ? "" : decodeURIComponent(rest);

    state.requests.push({
      at: Date.now(),
      rawUrl: req.url ?? "",
      doi,
      batchDois,
      isBatch,
      transform,
      userAgent: req.headers["user-agent"] ?? null,
      accept: req.headers.accept ?? null,
    });

    const send = (status, body, contentType) => {
      try {
        if (res.writableEnded || res.destroyed) return;
        res.writeHead(status, {
          "content-type": contentType,
          "content-length": Buffer.byteLength(body),
        });
        res.end(body);
      } catch {
        /* client may have aborted */
      }
    };

    const answer = () => {
      const queued = state.failures[0];
      if (queued && queued.times > 0) {
        queued.times -= 1;
        if (queued.times <= 0) state.failures.shift();
        send(queued.status, JSON.stringify({ status: "error", message: queued.body ?? "mock failure" }), "application/json");
        return;
      }

      if (isBatch) {
        if (batchDois.length === 0) {
          send(400, JSON.stringify({ status: "failed", message: [{ type: "filter-not-available" }] }), "application/json");
          return;
        }
        // Crossref simply omits works it does not have, so a batch can cover
        // fewer DOIs than requested.
        const items = batchDois.filter((entry) => !/^10\.9999\//.test(entry)).map((entry) => buildWork(entry));
        send(
          200,
          JSON.stringify({ status: "ok", message: { "total-results": items.length, items } }),
          "application/json"
        );
        return;
      }

      if (doi.startsWith(MISSING_MARKER) || /^10\.9999\//.test(doi)) {
        send(404, JSON.stringify({ status: "error", message: "Resource not found." }), "application/json");
        return;
      }

      state.served += 1;
      if (transform) {
        if (transform !== "application/x-bibtex") {
          send(406, JSON.stringify({ status: "error", message: "Unsupported transform" }), "application/json");
          return;
        }
        const bibtex =
          `@article{Mock_2021,\n` +
          `\ttitle={Authoritative Crossref BibTeX for ${doi}},\n` +
          `\tDOI={${doi}},\n` +
          `\tyear={2021},\n` +
          `\tjournal={Mock Journal}\n}\n`;
        send(200, bibtex, "application/x-bibtex");
        return;
      }

      send(200, JSON.stringify({ status: "ok", message: buildWork(doi) }), "application/json");
    };

    if (state.delayMs > 0) setTimeout(answer, state.delayMs);
    else answer();
  });
}

export function startMockCrossrefServer(state = createMockCrossrefState()) {
  const server = createMockCrossrefServer(state);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        state,
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());
if (isMain) {
  const mock = await startMockCrossrefServer();
  process.stdout.write(`mock Crossref listening on ${mock.baseUrl}\n`);
  process.stdout.write("Use CROSSREF_API_BASE=<url>.\n");
}
