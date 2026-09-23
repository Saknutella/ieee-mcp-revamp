/**
 * Deterministic IEEE Metadata Search API mock.
 *
 * Used for every automated test so that no real API budget is consumed. The
 * response shape mirrors the documented "Data Fields Returned" page, including
 * `authors.authors[]`, `index_terms`, `abstract_url`, `accessType` and
 * `total_records`. Run standalone with: node test/mock-ieee-server.mjs
 */

import http from "node:http";
import process from "node:process";

export const CATALOGUE_SIZE = 30;

function makeArticle(index) {
  const articleNumber = String(1_000_000 + index);
  const hasAbstract = index % 7 !== 0;
  const hasDoi = index % 7 !== 0;
  const year = String(2018 + (index % 7));
  const isConference = index % 3 !== 0;
  const title =
    index % 5 === 0
      ? `毫米波雷达波束成形的鲁棒自适应算法 ${index}`
      : `Robust adaptive beamforming for millimetre-wave radar, study ${index}`;
  return {
    article_number: articleNumber,
    doi: hasDoi ? `10.1109/TEST.${year}.${1000 + index}` : undefined,
    title,
    abstract: hasAbstract
      ? `This paper studies adaptive beamforming for millimetre-wave radar systems, case ${index}. ` +
        `It reports a ${index}.5 dB improvement in signal-to-interference ratio over a baseline.`
      : undefined,
    abstract_url: `https://ieeexplore.ieee.org/document/${articleNumber}`,
    html_url: `https://ieeexplore.ieee.org/document/${articleNumber}`,
    pdf_url: index % 4 === 0 ? undefined : `https://ieeexplore.ieee.org/stamp/stamp.jsp?arnumber=${articleNumber}`,
    publication_title: isConference
      ? `2024 IEEE International Conference on Radar Systems (RADAR ${index})`
      : `IEEE Transactions on Antennas and Propagation`,
    publication_year: year,
    publication_date: `${year}-0${(index % 9) + 1}-15`,
    content_type: isConference ? "Conferences" : "Journals",
    start_page: String(100 + index),
    end_page: String(110 + index),
    volume: isConference ? undefined : String(70 + (index % 5)),
    issue: isConference ? undefined : String(1 + (index % 12)),
    publisher: "IEEE",
    isbn: isConference ? `978-1-6654-${1000 + index}-0` : undefined,
    issn: isConference ? undefined : "0018-926X",
    conference_location: isConference ? "Boston, MA, USA" : undefined,
    conference_dates: isConference ? "15-19 April 2024" : undefined,
    citing_paper_count: index * 3,
    citing_patent_count: index,
    is_open_access: index % 6 === 0,
    accessType: index % 6 === 0 ? "Open Access" : "Locked",
    authors: {
      authors: [
        {
          authorUrl: `https://ieeexplore.ieee.org/author/${900000 + index}`,
          id: 900000 + index,
          full_name: `Alice Zhang${index}`,
          author_order: 1,
          affiliation: "School of Electronics, Tsinghua University, Beijing, China",
        },
        {
          authorUrl: `https://ieeexplore.ieee.org/author/${800000 + index}`,
          id: 800000 + index,
          full_name: `Bob Müller${index}`,
          author_order: 2,
          affiliation: "Institute of Radar Systems, Munich, Germany",
        },
      ],
    },
    index_terms: {
      author_terms: { terms: [`beamforming ${index}`, "millimetre wave", "adaptive array"] },
      ieee_terms: { terms: ["Array signal processing", "Radar antennas", "Adaptive arrays"] },
      mesh_terms: { terms: ["Algorithms", "Computer Simulation"] },
    },
    insert_date: "20240615",
  };
}

export const CATALOGUE = Array.from({ length: CATALOGUE_SIZE }, (_, i) => makeArticle(i + 1));

/** DOI the catalogue assigns to a given article number, for use in test fixtures. */
export function doiForArticleNumber(articleNumber) {
  const article = CATALOGUE.find((entry) => entry.article_number === String(articleNumber));
  return article?.doi ?? null;
}

export function createMockState(overrides = {}) {
  return {
    /** Number reported in `total_records`. */
    totalRecords: 26,
    /** Queued failures: { status, body, headers, times }. */
    failures: [],
    delayMs: 0,
    requests: [],
    requireApiKey: true,
    /** When true, DUP* queries return an overlapping, partially-complete set. */
    duplicateMode: true,
    ...overrides,
  };
}

function send(res, status, payload, headers = {}) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  try {
    if (res.writableEnded || res.destroyed) return;
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      ...headers,
    });
    res.end(body);
  } catch {
    // The client may have aborted (timeout tests); the mock must stay alive.
  }
}

function selectArticles(state, params) {
  const querytext = params.get("querytext") ?? "";
  const startRecord = Number(params.get("start_record") ?? "1") || 1;
  const maxRecords = Number(params.get("max_records") ?? "25") || 25;

  // Documented identifier lookup: article_number wins, then doi.
  // IEEE documents both as usable *only by themselves*. Verified against the
  // live API: adding `max_records` makes IEEE answer `total_records: 1` while
  // omitting the `articles` array entirely. The mock reproduces that exactly so
  // a regression that re-adds paging parameters fails the suite.
  const articleNumber = params.get("article_number");
  const doi = params.get("doi");
  if (articleNumber || doi) {
    const found = articleNumber
      ? CATALOGUE.filter((article) => article.article_number === articleNumber)
      : CATALOGUE.filter((article) => article.doi === doi);
    const extras = [...params.keys()].filter(
      (key) => !["article_number", "doi", "apikey"].includes(key)
    );
    if (extras.length > 0) {
      return { total: found.length, articles: [], identifierQuirk: extras };
    }
    return { total: found.length, articles: found.slice(0, maxRecords) };
  }

  // Duplicate scenario: two different queries return overlapping records where
  // each copy is missing a different field, exercising merge-on-dedup.
  if (state.duplicateMode && /^DUP/i.test(querytext)) {
    const variant = /A$/i.test(querytext) ? "A" : "B";
    const base = CATALOGUE.slice(0, 5).map((article, i) => {
      const copy = JSON.parse(JSON.stringify(article));
      if (variant === "A") {
        // Variant A carries no abstract, no keywords and no abstract_url.
        copy.abstract = undefined;
        copy.abstract_url = undefined;
        copy.index_terms = undefined;
      } else {
        // Variant B carries no DOI, so only a merge can produce a complete record.
        copy.doi = undefined;
      }
      copy.__variant = variant;
      copy.__slot = i;
      return copy;
    });
    return { total: base.length, articles: base };
  }

  if (/^EMPTY/i.test(querytext)) {
    return { total: 0, articles: [] };
  }

  const total = state.totalRecords;
  // Respect the reported total exactly, the way the real API does.
  const end = Math.min(startRecord - 1 + maxRecords, total);
  const slice = CATALOGUE.slice(startRecord - 1, end);
  return { total, articles: slice };
}

export function createMockServer(state = createMockState()) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const params = url.searchParams;
    const apikey = params.get("apikey");

    state.requests.push({
      at: Date.now(),
      path: url.pathname,
      rawUrl: req.url ?? "",
      params: Object.fromEntries(params.entries()),
      apikey,
      userAgent: req.headers["user-agent"] ?? null,
    });

    const answer = () => {
      if (state.requireApiKey && !apikey) {
        send(res, 401, { message: "Invalid or missing API key." });
        return;
      }

      const queued = state.failures[0];
      if (queued && queued.times > 0) {
        queued.times -= 1;
        if (queued.times <= 0) state.failures.shift();
        send(res, queued.status, queued.body ?? { message: `mock failure ${queued.status}` }, queued.headers ?? {});
        return;
      }

      if (url.pathname !== "/api/v1/search/articles") {
        send(res, 404, { message: "No such endpoint in the mock." });
        return;
      }

      const { total, articles } = selectArticles(state, params);
      send(res, 200, {
        total_records: total,
        total_searched: 5_000_000,
        articles,
      });
    };

    if (state.delayMs > 0) setTimeout(answer, state.delayMs);
    else answer();
  });

  return server;
}

export function startMockServer(state = createMockState()) {
  const server = createMockServer(state);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        state,
        port,
        baseUrl: `http://127.0.0.1:${port}/api/v1/search/articles`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());
if (isMain) {
  const mock = await startMockServer();
  process.stdout.write(`mock IEEE API listening on ${mock.baseUrl}\n`);
  process.stdout.write("Use IEEE_API_BASE=<url> and any non-empty IEEE_API_KEY.\n");
}
