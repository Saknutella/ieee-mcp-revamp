# IEEE Xplore MCP Server

Search IEEE Xplore from any MCP-capable AI agent and get back structured paper
metadata — title, authors, year, venue, abstract, keywords, DOI, article number,
abstract URL and PDF link — so the agent can screen candidates for relevance.

Ships as a **single Windows x64 executable**. No Node.js, no npm, no npx, and
nothing is downloaded at startup.

> ### Scope — please read
>
> The IEEE Metadata Search API performs a free-text search over *configured
> metadata fields and the abstract text*. It is **not** a full-text search of
> article bodies, and this server does **not** download PDFs or fetch full text.
>
> Every field comes from what IEEE actually returned. Missing values are `null`
> and are listed in `missing_fields` — nothing is guessed or back-filled.
> Relevance judgement is left to the calling agent; there is no built-in LLM.

**Integrity** — the build is byte-reproducible, so this checksum lets you verify
that the source really produces this binary:

| File | Bytes | SHA-256 |
|---|---|---|
| `dist/ieee-mcp.exe` | 90,939,904 | `56b284f34448f8aaf146cdb95e79dcc61230c9e469dd70976f204bca00b851af` |

```powershell
Get-FileHash .\dist\ieee-mcp.exe -Algorithm SHA256
```

---

## Setup

### 1. Get the executable

Put `dist/ieee-mcp.exe` anywhere — **paths with spaces or non-ASCII characters
are fine**, e.g. `D:\Tools\IEEE MCP\ieee-mcp.exe`.

Sanity check it first (output goes to **stderr**; stdout stays clean):

```powershell
.\dist\ieee-mcp.exe --self-test   # prints the effective config (key shown as a hash only)
.\dist\ieee-mcp.exe --version
.\dist\ieee-mcp.exe --help
```

### 2. Set your API key

Get a free key at <https://developer.ieee.org> (choose the *Content Discovery and
Indexing* use case).

The key is read **only from the environment**, and in MCP the environment is
supplied by the client that launches the process. So **the key goes in your
client's MCP config**, under `env`:

```json
{
  "mcpServers": {
    "ieee": {
      "command": "D:/Tools/IEEE MCP/ieee-mcp.exe",
      "env": {
        "IEEE_API_KEY": "your-key-here"
      }
    }
  }
}
```

| Question | Answer |
|---|---|
| Where does the key go? | The `env` block of **each** client's MCP config |
| Variable name | `IEEE_API_KEY` |
| Adding a second agent | Add the same entry to **that** client's config |
| Don't want the key in a config file? | Use `IEEE_API_KEY_FILE` (below) |
| Why not a user-level env var? | `setx` puts the key in the registry and leaks it to every process. Don't. |

**Alternative — keep the key in one file.** Point every client at the same path,
so the key lives in one place and rotating it means editing one file:

```json
"env": { "IEEE_API_KEY_FILE": "D:/Tools/IEEE MCP/ieee-key.local" }
```

The file contains the key on the first line (`#` comments and a UTF-8 BOM are
tolerated).

The key is never logged: every log line and error response is scrubbed, and
`ieee_status` reports only a `sha256(key)` fingerprint, so you can confirm which
key is loaded.

### 3. Point your client at it

Config file locations differ per client — the **content format is the same**
everywhere:

| Client | Config file (typical; check your client's docs) |
|---|---|
| Claude Desktop | `%APPDATA%\Claude\claude_desktop_config.json` |
| Claude Code | `~/.claude.json` or project `.mcp.json` |
| Cursor | `%USERPROFILE%\.cursor\mcp.json` |
| Windsurf | `%USERPROFILE%\.codeium\windsurf\mcp_config.json` |
| VS Code (native MCP) | workspace `.vscode/mcp.json` |
| Cline / Roo and similar | usually a settings UI; same JSON shape |

```json
{
  "mcpServers": {
    "ieee": {
      "command": "D:/Tools/IEEE MCP/ieee-mcp.exe",
      "args": [],
      "env": {
        "IEEE_API_KEY": "your-key-here",
        "CROSSREF_MAILTO": "you@example.org",
        "IEEE_MCP_STATE_DIR": "D:/Tools/IEEE MCP/state",
        "IEEE_OUTPUT_DIR": "D:/Results"
      }
    }
  }
}
```

- `command` must be the **absolute path** to the exe. Use `/` or `\\` in JSON.
- Spaces and non-ASCII characters in the path need no escaping — the client
  passes argv directly, without a shell.
- Do **not** use `node` / `npm` / `npx`, and no `args` are needed.
- **Restart the client** after editing its config.
- To verify, ask the agent to call `ieee_status` — it reports whether a key was
  found (as a fingerprint) and shows your usage counters.

### 4. Behind a proxy

```json
"env": {
  "IEEE_API_KEY": "your-key-here",
  "NODE_USE_ENV_PROXY": "1",
  "HTTPS_PROXY": "http://127.0.0.1:7890",
  "NO_PROXY": "localhost,127.0.0.1"
}
```

Check reachability without a valid key — `HTTP 403 Developer Inactive` means the
network path works:

```powershell
curl.exe --proxy http://127.0.0.1:7890 "https://ieeexploreapi.ieee.org/api/v1/search/articles?querytext=radar&apikey=x"
```

Note that IEEE answers **403, not 401**, for an invalid or inactive key. This
server says so explicitly and does not retry a 403.

---

## Environment Variables

Only `IEEE_API_KEY` (or `IEEE_API_KEY_FILE`) is required. Everything else has a
sensible default.

| Variable | Default | Description |
|---|---|---|
| `IEEE_API_KEY` | — | Your key from developer.ieee.org |
| `IEEE_API_KEY_FILE` | — | Read the key from a UTF-8 file instead |
| `CROSSREF_MAILTO` | — | Contact address for Crossref's polite pool — **recommended**, it doubles your rate limit |
| `IEEE_MCP_STATE_DIR` | `%LOCALAPPDATA%\ieee-mcp` | Where the usage ledger, cache and result sets live. Falls back through `%APPDATA%`, `~/.ieee-mcp`, next to the exe, then temp |
| `IEEE_OUTPUT_DIR` | working directory | Base for relative export paths |
| `IEEE_DAILY_BUDGET` | `200` | **Local** call budget (see [Rate Limits](#rate-limits)) |
| `IEEE_MAX_RPS` | `8` | Requests/second cap, 1–10 |
| `IEEE_MAX_RETRIES` | `2` | Retries for transient failures, 0–5 |
| `IEEE_TIMEOUT_MS` | `20000` | Per-request timeout |
| `IEEE_LOG_LEVEL` | `info` | `silent` / `error` / `warn` / `info` / `debug` (all to stderr) |
| `IEEE_CACHE_TTL_SECONDS` | `86400` | Response cache TTL; `0` disables caching |
| `IEEE_MCP_CROSSREF_ENABLED` | `1` | Set to `0` to disable `get_references` |
| `CROSSREF_MAX_RPS` | `3` | Crossref rate cap (raise to `10` if you set `CROSSREF_MAILTO`) |
| `IEEE_MCP_MAX_DOIS_PER_CALL` | `20` | Max papers per `get_references` call |

Rarely needed: `IEEE_BUDGET_WINDOW`, `IEEE_CACHE_MAX_ENTRIES`,
`IEEE_CACHE_MAX_ENTRY_BYTES`, `IEEE_RESULT_TTL_SECONDS`, `CROSSREF_BATCH_SIZE`,
`IEEE_MCP_MAX_BIBTEX_PER_CALL`, `IEEE_USER_AGENT`, `IEEE_SHUTDOWN_GRACE_MS`,
`IEEE_API_BASE` and `CROSSREF_API_BASE` (offline testing only).

**Without a key the server still starts.** `initialize` and `tools/list` work, and
every search tool returns a structured `CONFIG_ERROR` — so the agent can tell you
what to fix instead of failing silently.

---

## Tools

| Tool | What it does |
|---|---|
| `search_papers` | Main search: one query or several merged, with all filters and paging |
| `search_by_author` | Search by author name |
| `search_by_publication` | Search inside one journal or conference |
| `get_paper_details` | Full metadata for one paper by DOI or article number |
| `get_paper_citations` | Citing-paper and citing-patent counts for one paper |
| `get_references` | Reference list for one or more papers (**source: Crossref, not IEEE**) |
| `export_results` | Write results to UTF-8 CSV / JSON / BibTeX with a provenance sidecar |
| `ieee_status` | Effective config, local usage counters, cache stats, source status |

### `search_papers`

```jsonc
{
  // Query (metadata + abstract text, not full text)
  "querytext": "radar AND beamforming",   // AND/OR/NOT and * (>=3 chars before a wildcard)
  "queries": ["mmwave beamforming", "millimeter wave beamforming"],  // variants, merged + deduped
  "article_title": "...", "abstract": "...", "author": "Zhang",
  "affiliation": "Tsinghua", "index_terms": "beamforming",   // author keywords + IEEE terms + MeSH
  "doi": "10.1109/...", "article_number": "10107367",        // these two override everything else

  // Filters
  "content_type": "Conferences",   // Books|Conferences|Courses|Early Access|Journals|
                                   // Journals,Magazines|Magazines|Standards  (case-sensitive)
  "open_access": true,
  "start_year": "2020", "end_year": "2025", "publication_year": "2024",
  "publication_title": "...", "publisher": "IEEE", "issn": "0018-926X",

  // Paging and limits
  "max_records": 25,        // per request; IEEE default 25, max 200
  "start_record": 1,        // absolute 1-based index, NOT a page number
  "auto_paginate": false,   // keep paging until one of the limits below is hit
  "max_total_records": 200, // unique records for this call
  "max_requests": 5,        // HTTP requests this call may spend, retries included
  "sort_field": "publication_title",  // article_number | article_title | publication_title
  "sort_order": "desc",

  "output_format": "json"   // json (default) | markdown | csv | bibtex | citation
}
```

### Responses

`output_format: "json"` (the default) puts the full payload in `content[0].text`
and also in MCP `structuredContent`:

```jsonc
{
  "search_id": "srch_m1a2b3c4d5",          // pass this to export_results / get_references
  "source": "IEEE Xplore",
  "search_scope": "metadata_and_abstract",
  "total_records": 26,
  "returned_records": 25,
  "pagination": {
    "mode": "single",                      // or "merged" for multi-query
    "start_record": 1, "max_records": 25,
    "last_returned_index": 25,
    "has_more": true,
    "next_start_record": 26,               // use this to fetch the next page
    "pages_fetched": 1,
    "stop_reason": "auto_paginate is disabled"
  },
  "usage": { /* local counters — see Rate Limits */ },
  "cache": { "hit": false, "ttl_seconds": 86400 },
  "dedup": { "duplicates_removed": 0, "matched_on": [] },
  "warnings": ["More results are available. Request the next page with start_record=26."],
  "per_query": [ /* per-variant detail when queries[] is used */ ],
  "articles": [ /* PaperRecord[] */ ]
}
```

Each record:

```jsonc
{
  "article_number": "10107367",
  "doi": "10.1109/ACCESS.2023.3261234",
  "title": "...",
  "authors": [{ "name": "Alice Zhang", "affiliation": "Tsinghua University", "order": 1 }],
  "author_names": "Alice Zhang; Bob Muller",
  "year": "2023",
  "publication_title": "IEEE Access",
  "content_type": "Journals",
  "abstract": "...",
  "keywords": { "author_terms": [], "ieee_terms": [], "mesh_terms": [] },
  "abstract_url": "https://ieeexplore.ieee.org/document/10107367",
  "html_url": "...", "pdf_url": null,        // null = IEEE did not return one
  "is_open_access": false, "access_type": "Locked",
  "pages": "1-12", "volume": "11", "issue": "4", "publisher": "IEEE",
  "citing_paper_count": 12, "citing_patent_count": 0,
  "source": "IEEE Xplore",
  "missing_fields": ["pdf_url"]
}
```

`missing_fields` covers `title`, `authors`, `year`, `publication_title`,
`abstract`, `keywords`, `doi`, `article_number`, `abstract_url`. `pdf_url` is
optional by IEEE's own definition, so its absence is not counted.

**Paging.** `start_record` is an absolute index. `has_more` is computed from the
absolute index of the last record returned, so a full page out of a slightly
larger total still advertises the next one. With `auto_paginate`, paging stops at
`max_total_records`, at `max_requests`, when IEEE runs out, or when a page adds no
new unique records — the reason is in `stop_reason`.

**Deduplication.** Records are matched on normalized DOI, then `article_number`,
then normalized title + year. Duplicates are not simply dropped: a record's `null`
fields are back-filled from its duplicate, so you get the most complete version.

### `get_references` — reference lists (Crossref)

IEEE's API has **no reference list at all**: `citing_paper_count` and
`citing_patent_count` are both *incoming* citations. This tool fills that gap from
a second source.

| | |
|---|---|
| Source | **Crossref REST API** — the response says `source: "Crossref REST API"`, `source_is_ieee: false` |
| Content | Publisher-deposited references, including the publisher's citation keys (`ref1`, `ref2`, …) |
| Caveat | Crossref cannot be cross-checked against IEEE, because IEEE has nothing to check |
| `verification_required` | Always `true`. Each response carries links to the Crossref record and to the paper's IEEE Xplore page |

Verified against IEEE Xplore on two papers, position by position, including the
entries the publisher deposited without a DOI: IEEE TCSII 2021 (art. 9422824)
**14/14**, ESSCIRC 2019 (art. 8902902) **7/7**. That is a small sample — treat the
result as a strong lead and compare it with the References section on Xplore.

```jsonc
{ "dois": ["10.1109/TCSII.2021.3077589", "10.1109/ESSCIRC.2019.8902902"] }
{ "search_id": "srch_m1a2b3c4d5" }                            // reuse an IEEE search's DOIs
{ "search_id": "srch_m1a2b3c4d5", "article_numbers": ["9422824"] }
{ "dois": ["10.1109/TCSII.2021.3077589"], "output_format": "bibtex" }
```

**Request cost.** One request returns a paper's *complete* reference array, so
cost does not scale with the number of references — and multiple DOIs are batched
into a single request:

| Operation | Requests |
|---|---|
| 1 paper's reference list | **1** |
| N papers' reference lists | **1** (batched; measured 3 papers / 42 references in one call) |
| `bibtex_mode: "crossref"` | **1 per DOI-bearing reference** — the only per-reference cost |
| Cache hit | **0** |

Entries are sorted by the publisher's citation key, restoring the numbering used
in the paper. BibTeX modes:

| `bibtex_mode` | Behaviour | Cost |
|---|---|---|
| `generated` (default) | Built from the deposited fields | 0 |
| `crossref` | Authoritative BibTeX via Crossref content negotiation | 1 per DOI-bearing reference |
| `none` | Omit BibTeX | 0 |

Prefer `crossref` for IEEE papers: in the TCSII sample, **10 of 14** references
were deposited with a DOI and *nothing else*, so `generated` can only produce a
stub (it adds an explanatory `note`). With `crossref`, all 10 came back complete —
full author lists, page ranges, ISSNs, and the Springer monograph correctly typed
as `@book`.

Papers without a DOI are skipped and listed in `warnings`, because Crossref is
keyed by DOI. These lookups **do not consume the IEEE budget** — `get_references`
works with no IEEE key configured at all.

> **Do not mix the two citation metrics.** A *reference count* is how many works a
> paper cites (outgoing). A *citation count* is how many works cite it (incoming).
> They are not comparable — and the incoming counts disagree between sources
> (same ESSCIRC paper: IEEE 15, Crossref 15, OpenAlex 18).

### Citing a paper

```jsonc
{ "doi": "10.1109/TCSII.2021.3077589", "output_format": "citation" }
```

Returns a ready-to-use bundle: an **IEEE-style plain-text citation**, a **BibTeX**
entry, and an **RIS** record (RIS imports directly into Zotero, EndNote or
Mendeley). The search tools accept `output_format: "citation"` too, for several
papers at once.

```
J. Park, Y. Shin, J. Choi, and S. Kim, "A 5.02nW 32-kHz Self-Reference Power Gating
XO With Fast Startup Time Assisted by Negative Resistance and Initial Noise Boosters",
IEEE Transactions on Circuits and Systems II: Express Briefs, vol. 68, no. 11,
pp. 3386-3390, 2021, doi: 10.1109/TCSII.2021.3077589.
```

The metadata is IEEE's. The citation string is assembled mechanically, and the
IEEE-style author initials are a heuristic (`Jee-Ho Park` → `J. Park`) — name order
varies by culture, so check author formatting before submitting. BibTeX and RIS
use full names and do not have this problem.

### Exporting

`export_results` writes `csv`, `json` or `bibtex`, plus a `<name>.meta.json`
sidecar recording the source, endpoint, retrieval time and the exact query.

- **CSV** — UTF-8 **with BOM** (opens cleanly in Excel), CRLF, RFC 4180 quoting,
  with `source` / `retrieved_at` / `query_id` / `missing_fields` provenance columns
- **BibTeX** — `%` comment header, entry type mapped from `content_type`

```jsonc
{ "search_id": "srch_m1a2b3c4d5", "format": "csv", "output_path": "results/papers.csv" }
```

Relative paths resolve against `IEEE_OUTPUT_DIR`; directories are created as
needed, and a missing extension is filled in for the chosen format.

---

## Rate Limits

The two data sources have completely different models.

### IEEE

Roughly **10 calls/second and 200 calls/day** per key. Defaults here are
`IEEE_MAX_RPS=8` and `IEEE_DAILY_BUDGET=200`.

- Every HTTP **attempt**, retries included, reserves budget *before* it is sent.
- The ledger is a JSON file guarded by an atomic lock and **shared across
  processes**, so two clients running at once cannot double-spend a slot or each
  exceed the per-second cap.

**The counter is local bookkeeping, not your official remaining quota.** IEEE does
not publish its rate-limit reset time zone, so this server assumes nothing: it
tracks three windows (UTC day, local day, rolling 24h) and reports all of them.
Measured behaviour confirms the caution — **IEEE returns no rate-limit headers at
all**, so local counts cannot be reconciled with the official quota. Where they
disagree, trust IEEE. To reset the local counter, delete `usage-ledger.json` in
the state directory or call `ieee_status({ "reset_local_usage": true })`.

### Crossref

**No daily quota.** The limits are rate and concurrency:

| Pool | Rate | Concurrency | How to join |
|---|---|---|---|
| Public | 5/s | 1 | default |
| Polite | **10/s** | **3** | send a `mailto` → set `CROSSREF_MAILTO` |
| Plus (paid) | 150/s | none | API key |

So `CROSSREF_MAILTO` is not just etiquette — it doubles your rate and triples your
concurrency. The default here is a conservative `CROSSREF_MAX_RPS=3`.

### Caching and retries

Responses are cached on disk, keyed by endpoint plus effective parameters. A cache
hit costs **no** requests or budget. Identical requests issued concurrently are
coalesced. `no_cache: true` skips the read but still writes back.

Retried: network errors, timeouts, `408`, `425`, `429` (honouring `Retry-After`)
and `5xx`. **Not** retried: `400`, `401`, `403`, `404`. Errors come back as
structured objects:

```jsonc
{ "ok": false, "code": "AUTH_ERROR", "message": "...", "http_status": 401,
  "retryable": false, "api_code": "401", "attempts": 1, "hint": "..." }
```

---

## Limitations

1. **Metadata only** — no full-text retrieval (see [Full text](#full-text)).
2. **No facet parameters** (`facet`, `d-au`, `d-publisher`, `d-pubtype`, `d-year`)
   — IEEE defines these as returning refinement links, not result sets.
3. **Deep paging depends on IEEE.** It caps results per request at 200; this server
   defaults `max_total_records` to 200 (up to 1000). Paging stops early if a page
   adds no new unique records, and says why in `stop_reason`.
4. **Local counter ≠ official quota** — see [Rate Limits](#rate-limits).
5. **Crossref reference data is only as complete as the publisher's deposit.**
   Verified on a two-paper sample; it is not exhaustive, and many IEEE references
   carry only a DOI.
6. **`publication_year` formats vary** by publication; the value is passed through
   as returned.
7. **BibTeX output is raw UTF-8** (only `{`, `}`, `\` are escaped); older BibTeX
   engines may need biblatex.
8. **The exe is not code-signed**, so Windows SmartScreen may warn on first run.
   Verify with the checksum above.
9. **~87 MiB exe** — the price of bundling the Node.js runtime.
10. **Windows x64 only.**

### Things worth knowing about the live API

- **`doi` and `article_number` must be sent alone.** Adding `max_records` makes
  IEEE return `total_records: 1` while **omitting the `articles` array entirely**
  (HTTP 200, no error). This server therefore sends only the identifier.
- **An invalid or inactive key returns 403, not 401.**
- **The IEEE API has no reference or citing-work list.** A full dump of an article
  object shows 31 fields, and only two of them are citation *counts*.

---

## Roadmap

Not built yet, roughly in order of value:

1. **Citing-work lists** (`get_citing_works`) — "who cited this". IEEE has no API
   for it and its website blocks automation, so the viable route is OpenAlex's
   `cited_by_api_url` (a real, free, keyless API). **Caveat:** OpenAlex's counts
   are unreliable (18 vs IEEE's 15 on one sampled paper), so such a tool could only
   ever be a navigation aid for the list — never a source of counts — and would
   have to carry the same source labelling and `verification_required` as
   `get_references`. Currently low priority.
2. **Full-text retrieval** — blocked on an institutional TDM entitlement, not on
   code (see [Full text](#full-text)).
3. **PDF reference extraction (GROBID)** — only adds value when Crossref has no
   deposited reference list. GROBID does not officially support Windows (Docker or
   WSL required), so this is low priority.
4. **IEEE DOI API** — a separate IEEE API that resolves up to 25 DOIs per request,
   useful for back-filling metadata for a list of DOIs you already have. Requires
   its own entitlement, separate from the Metadata Search key.
5. **RIS export** — `output_format: "citation"` already emits RIS, but
   `export_results` supports only CSV / JSON / BibTeX.

---

## Full text

**Not supported, and this is a permissions problem rather than a missing
feature.** IEEE supports exactly three API use cases
([official list](https://developer.ieee.org/Allowed_API_Uses)):

| Use case | Content |
|---|---|
| Content Discovery and Indexing | Metadata extraction and indexing ← *your personal key* |
| Open Access Articles | Open-access full text (for organizations) |
| **Text and Data Mining (TDM)** | Full text, **non-commercial research only, and requires an active institutional IEEE Xplore subscription** — contact IEEE |

The legitimate route to full text is therefore an **institutional TDM entitlement,
requested through your library** — not a personal Metadata key, and not a scripted
institutional login. Reasons:

- a personal `IEEE_API_KEY` carries no institutional entitlement;
- Xplore's `robots.txt` disallows `/rest` (the internal API) and **`/ielx*`**,
  which is the PDF download path;
- the same file disallows this agent type site-wide, along with GPTBot,
  Google-Extended, PerplexityBot, CCBot and others;
- IEEE's API Terms of Use prohibit robot/spider retrieval or indexing, and
  prohibit using the Content to train or develop AI/LLM systems — a restriction
  that still applies even with TDM access.

So: reading a few PDFs yourself in a browser is fine; bulk full-text access goes
through an institutional TDM request. Scripted bulk downloads put your
institution's entire access at risk. This server instead hands you the direct link
in `verify.ieee_xplore` whenever you need to look at the paper itself.

**If Crossref has no reference list** for a paper and you already legitimately
hold the PDF, the tool for extracting its bibliography is **GROBID** (Apache-2.0,
~0.87–0.90 F1 on reference extraction) — not Zotero, whose "Retrieve PDF Metadata"
only produces *item* metadata and is itself a Crossref consumer.

---

## License

MIT — see [`LICENSE`](LICENSE), which retains the original copyright notice.

---

## For maintainers

<details>
<summary>Building and testing from source (requires Node.js ≥ 20 on the build machine only)</summary>

```powershell
npm install
node scripts/build.mjs     # clean → typecheck → esbuild bundle → SEA → inject → checksums
node test/run-all.mjs      # 383 checks against dist/ieee-mcp.exe
```

The build is offline after `npm install` and byte-reproducible: two consecutive
builds produce identical SHA-256 hashes, because the SEA config disables the V8
code cache (measured startup is the same either way, ~73 ms). Set
`IEEE_BUILD_CODE_CACHE=1` to opt in and lose reproducibility.

The tests run entirely against built-in mock servers for IEEE and Crossref, so
they consume no real API quota. Use `IEEE_TEST_TARGET=bundle` to test the
unbundled build for faster iteration.

Deep dives, in Chinese:

- [`docs/测试报告.md`](docs/测试报告.md) — test results and measured API behaviour
- [`docs/IEEE-API-参数核对.md`](docs/IEEE-API-参数核对.md) — parameter-by-parameter
  comparison against the official IEEE documentation
- [`docs/上游源码审计.md`](docs/上游源码审计.md) — line-level audit of the existing code
- [`docs/README.zh-CN.md`](docs/README.zh-CN.md) — Chinese version of this README

</details>
