# IEEE Xplore MCP Server

Search IEEE Xplore from any MCP-capable AI agent and get back structured paper
metadata — title, authors, year, venue, abstract, keywords, DOI, article number,
abstract URL and PDF link — so the agent can screen candidates for relevance.

Ships as a single Windows x64 executable: no Node.js, no npm, no npx, nothing
downloaded at startup.

> **Scope.** The IEEE Metadata Search API does a free-text search over *configured
> metadata fields and the abstract text*. It is **not** a full-text search of
> article bodies, and this server does **not** download PDFs. Missing values come
> back as `null` and are listed in `missing_fields` — nothing is guessed or
> back-filled. Relevance judgement is left to the calling agent; there is no
> built-in LLM.

---

## Install

### Option A — prebuilt executable

Grab `ieee-mcp.exe` from the release and put it anywhere. Paths with spaces or
non-ASCII characters are fine.

```powershell
.\ieee-mcp.exe --self-test   # print the effective config (key shown as a hash only)
```

### Option B — build from source

Requires Node.js ≥ 20 on the build machine only. The build is offline after
`npm install` and byte-reproducible.

```powershell
npm install
node scripts/build.mjs     # → dist/ieee-mcp.exe + dist/SHA256SUMS.txt
```

### API key

Get a free key at <https://developer.ieee.org> (use case *Content Discovery and
Indexing*) and pass it in the environment:

```json
"env": { "IEEE_API_KEY": "your-key-here" }
```

The key is never written to disk, never embedded in the exe, and never logged:
every log line and error response is scrubbed, and `ieee_status` reports only a
`sha256(key)` fingerprint so you can confirm which key is loaded.

To keep the key out of your config files, point at a file instead — the key goes
on the first line (`#` comments and a UTF-8 BOM are tolerated):

```json
"env": { "IEEE_API_KEY_FILE": "D:/Tools/ieee-key.local" }
```

### Client config

Config locations differ per client; the format is the same everywhere. One
example:

```json
{
  "mcpServers": {
    "ieee": {
      "command": "D:/Tools/ieee-mcp.exe",
      "env": {
        "IEEE_API_KEY": "your-key-here",
        "CROSSREF_MAILTO": "you@example.org"
      }
    }
  }
}
```

`command` must be the absolute path to the exe. Restart the client after editing.
To check it works, ask the agent to call `ieee_status`.

If you need a proxy, add to `env`:

```json
"NODE_USE_ENV_PROXY": "1",
"HTTPS_PROXY": "http://127.0.0.1:7890"
```

---

## Environment Variables

Only the key is required; everything else has a sensible default.

| Variable | Default | Description |
|---|---|---|
| `IEEE_API_KEY` | — | Your key, or use `IEEE_API_KEY_FILE` |
| `IEEE_API_KEY_FILE` | — | Read the key from a UTF-8 file instead |
| `CROSSREF_MAILTO` | — | Contact address for Crossref's polite pool — **recommended**, it doubles your rate limit |
| `IEEE_OUTPUT_DIR` | working directory | Base for relative export paths |
| `IEEE_MCP_STATE_DIR` | `%LOCALAPPDATA%\ieee-mcp` | Usage ledger, cache and result sets |
| `IEEE_DAILY_BUDGET` | `200` | Local call budget — see [Rate Limits](#rate-limits) |
| `IEEE_MAX_RPS` | `8` | Requests/second cap, 1–10 |
| `IEEE_LOG_LEVEL` | `info` | `silent` / `error` / `warn` / `info` / `debug` |
| `IEEE_MCP_CROSSREF_ENABLED` | `1` | Set to `0` to disable `get_references` |

Also available: `IEEE_MAX_RETRIES`, `IEEE_TIMEOUT_MS`, `IEEE_CACHE_TTL_SECONDS`,
`IEEE_CACHE_MAX_ENTRIES`, `IEEE_BUDGET_WINDOW`, `IEEE_RESULT_TTL_SECONDS`,
`CROSSREF_MAX_RPS`, `CROSSREF_BATCH_SIZE`, `IEEE_MCP_MAX_DOIS_PER_CALL`,
`IEEE_MCP_MAX_BIBTEX_PER_CALL`, `IEEE_USER_AGENT`.

**Without a key the server still starts** — `initialize` and `tools/list` work, and
search tools return a structured `CONFIG_ERROR` instead of failing silently.

---

## Tools

| Tool | What it does |
|---|---|
| `search_papers` | Main search: one query or several merged, with all filters and paging |
| `search_by_author` | Search by author name |
| `search_by_publication` | Search inside one journal or conference |
| `get_paper_details` | Full metadata for one paper, by DOI or article number |
| `get_paper_citations` | Citing-paper and citing-patent counts for one paper |
| `get_references` | Reference list for one or more papers (**source: Crossref, not IEEE**) |
| `export_results` | Write results to UTF-8 CSV / JSON / BibTeX with a provenance sidecar |
| `ieee_status` | Effective config, usage counters, cache stats, source status |

### `search_papers`

```jsonc
{
  "querytext": "radar AND beamforming",  // AND/OR/NOT and * (>=3 chars before a wildcard)
  "queries": ["mmwave beamforming", "millimeter wave beamforming"],  // variants, merged + deduped
  "article_title": "...", "abstract": "...", "author": "Zhang",
  "affiliation": "Tsinghua", "index_terms": "beamforming",
  "doi": "10.1109/...", "article_number": "10107367",   // either one overrides all other filters

  "content_type": "Conferences",   // Books|Conferences|Courses|Early Access|Journals|
                                   // Journals,Magazines|Magazines|Standards (case-sensitive)
  "open_access": true,
  "start_year": "2020", "end_year": "2025", "publication_year": "2024",
  "publication_title": "...", "publisher": "IEEE", "issn": "0018-926X",

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

`output_format: "json"` puts the payload in `content[0].text` and in MCP
`structuredContent`:

```jsonc
{
  "search_id": "srch_m1a2b3c4d5",   // pass this to export_results / get_references
  "search_scope": "metadata_and_abstract",
  "total_records": 26,
  "returned_records": 25,
  "pagination": {
    "start_record": 1, "max_records": 25,
    "last_returned_index": 25,
    "has_more": true,
    "next_start_record": 26,        // use this to fetch the next page
    "stop_reason": "auto_paginate is disabled"
  },
  "usage": { /* local counters */ },
  "dedup": { "duplicates_removed": 0, "matched_on": [] },
  "warnings": [],
  "articles": [ /* one object per paper */ ]
}
```

Each paper carries `article_number`, `doi`, `doi_url`, `title`, `authors`
(with affiliations and order), `author_names`, `year`, `publication_date`,
`publication_title`, `content_type`, `abstract`, `keywords` (`author_terms`,
`ieee_terms`, `mesh_terms`), `abstract_url`, `html_url`, `pdf_url`,
`is_open_access`, `access_type`, `pages`, `volume`, `issue`, `publisher`,
`isbn`, `issn`, `conference_location`, `conference_dates`, `citing_paper_count`,
`citing_patent_count`, `source`, `missing_fields`.

`missing_fields` lists absent values among `title`, `authors`, `year`,
`publication_title`, `abstract`, `keywords`, `doi`, `article_number`,
`abstract_url`. `pdf_url` is optional by IEEE's own definition, so its absence is
not counted.

**Paging.** `has_more` is computed from the absolute index of the last record
returned, so a full page out of a slightly larger total still advertises the next
one. With `auto_paginate`, paging stops at `max_total_records`, at `max_requests`,
when IEEE runs out, or when a page adds no new unique records — the reason is in
`stop_reason`.

**Deduplication.** Records are matched on normalized DOI, then `article_number`,
then normalized title + year. Duplicates are not simply dropped: a record's `null`
fields are back-filled from its duplicate, so you get the most complete version.

### `get_references` — reference lists (Crossref)

IEEE's API has **no reference list at all** — `citing_paper_count` and
`citing_patent_count` are both *incoming* citations. This tool fills that gap from
Crossref, which holds the publisher-deposited bibliography including the citation
keys (`ref1`, `ref2`, …) that preserve the numbering used in the paper.

The response always reports `source: "Crossref REST API"`, `source_is_ieee: false`
and `verification_required: true`, and carries links to the Crossref record and to
the paper's IEEE Xplore page. IEEE has nothing to cross-check against, so **verify
against the References section on Xplore** before relying on it. (Checked against
IEEE on two papers, position by position, including entries deposited without a
DOI: 14/14 and 7/7. That is a small sample.)

```jsonc
{ "dois": ["10.1109/TCSII.2021.3077589", "10.1109/ESSCIRC.2019.8902902"] }
{ "search_id": "srch_m1a2b3c4d5" }                            // reuse an IEEE search's DOIs
{ "dois": ["10.1109/TCSII.2021.3077589"], "output_format": "bibtex" }
```

**Cost.** One request returns a paper's *complete* reference array, and multiple
DOIs are batched into one request — so cost does not scale with the number of
references or papers. The only per-reference cost is `bibtex_mode: "crossref"`,
which fetches authoritative BibTeX one reference at a time.

| `bibtex_mode` | Behaviour |
|---|---|
| `generated` (default) | Built from the deposited fields; entry type inferred, can be wrong |
| `crossref` | Authoritative BibTeX via content negotiation — **preferred for IEEE papers**, since many references are deposited with a DOI and nothing else |
| `none` | Omit BibTeX |

Papers without a DOI are skipped and listed in `warnings`. These lookups **do not
consume the IEEE budget** — `get_references` works with no IEEE key configured.

> **Do not mix the two citation metrics.** A *reference count* is how many works a
> paper cites (outgoing); a *citation count* is how many works cite it (incoming).

### Citing a paper

```jsonc
{ "doi": "10.1109/TCSII.2021.3077589", "output_format": "citation" }
```

Returns an **IEEE-style plain-text citation**, a **BibTeX** entry and an **RIS**
record (RIS imports straight into Zotero, EndNote or Mendeley). Search tools accept
the same option for several papers at once.

The citation string is assembled mechanically from IEEE's metadata, and the
IEEE-style author initials are a heuristic (`Jee-Ho Park` → `J. Park`) — name order
varies by culture, so check author formatting before submitting. BibTeX and RIS use
full names.

### Exporting

`export_results` writes `csv`, `json` or `bibtex`, plus a `<name>.meta.json`
sidecar recording the source, endpoint, retrieval time and the exact query. CSV is
UTF-8 with BOM (opens cleanly in Excel) and includes provenance columns.

```jsonc
{ "search_id": "srch_m1a2b3c4d5", "format": "csv", "output_path": "results/papers.csv" }
```

---

## Rate Limits

**IEEE** — roughly 10 calls/second and 200 calls/day per key. Defaults here are
`IEEE_MAX_RPS=8` and `IEEE_DAILY_BUDGET=200`. Every HTTP *attempt*, retries
included, reserves budget before it is sent. The ledger is shared across
processes, so two clients running at once cannot double-spend or exceed the
per-second cap.

The counter is **local bookkeeping, not your official remaining quota**. IEEE
publishes no rate-limit reset time zone (and returns no rate-limit headers at all),
so this server assumes nothing: it tracks UTC day, local day and rolling 24h and
reports all three. Where they disagree with IEEE, trust IEEE. Reset it by deleting
`usage-ledger.json` in the state directory, or with
`ieee_status({ "reset_local_usage": true })`.

**Crossref** — no daily quota; limits are rate and concurrency. 5/s with
concurrency 1 by default, or **10/s with concurrency 3** once you set
`CROSSREF_MAILTO`. The default here is a conservative `CROSSREF_MAX_RPS=3`.

Responses are cached on disk, so a cache hit costs nothing. Retried: network
errors, timeouts, `408`, `425`, `429` (honouring `Retry-After`) and `5xx`. Not
retried: `400`, `401`, `403`, `404`.

---

## Limitations

- **Metadata only** — no full-text retrieval (see below).
- **No facet parameters** (`facet`, `d-au`, `d-publisher`, `d-pubtype`, `d-year`) —
  IEEE defines these as returning refinement links, not result sets.
- **Deep paging depends on IEEE**, which caps results per request at 200. Paging
  stops early when a page adds no new unique records, and says why.
- **The local counter ≠ the official quota** (see above).
- **Crossref references are only as complete as the publisher's deposit**, and many
  IEEE references carry only a DOI.
- **`publication_year` formats vary** by publication; the value is passed through.
- **BibTeX output is raw UTF-8** (only `{`, `}`, `\` escaped); older BibTeX engines
  may need biblatex.
- **The exe is not code-signed**, so Windows SmartScreen may warn on first run.
- **Windows x64 only.**

Two things worth knowing about the live API: `doi` and `article_number` must be
sent alone (adding `max_records` makes IEEE return `total_records: 1` while
omitting the `articles` array entirely, with no error), and an invalid or inactive
key returns **403, not 401**.

---

## Roadmap

- **Citing-work lists** — "who cited this". IEEE has no API for it and its website
  blocks automation, so the route would be OpenAlex's `cited_by_api_url` (free,
  keyless). Caveat: OpenAlex's counts are unreliable (18 vs IEEE's 15 on a sampled
  paper), so such a tool could only navigate the list, never supply counts.
- **Full-text retrieval** — blocked on an institutional TDM entitlement, not on code.
- **IEEE DOI API** — a separate IEEE API resolving up to 25 DOIs per request, for
  back-filling metadata for DOIs you already have. Needs its own entitlement.
- **RIS in `export_results`** — `output_format: "citation"` already emits RIS.

---

## Full text

**Not supported, and this is a permissions problem rather than a missing
feature.** IEEE supports exactly three API use cases
([official list](https://developer.ieee.org/Allowed_API_Uses)): Content Discovery
and Indexing (what a personal Metadata key gets you), Open Access Articles, and
**Text and Data Mining** — the latter being full text, non-commercial research
only, and requiring an active institutional IEEE Xplore subscription.

The legitimate route is therefore an **institutional TDM entitlement requested
through your library**, not a personal key and not a scripted institutional login:
Xplore's `robots.txt` disallows `/rest` and `/ielx*` (the PDF path), and disallows
this agent type site-wide; its terms also prohibit robot retrieval and any use of
the content to train AI systems. Reading a few PDFs yourself in a browser is fine —
this server hands you the direct link in `verify.ieee_xplore` whenever you need it.

If Crossref has no reference list for a paper and you already hold the PDF, the
tool for extracting its bibliography is **GROBID** — not Zotero, whose "Retrieve
PDF Metadata" only produces *item* metadata and is itself a Crossref consumer.

---

## License

MIT — see [`LICENSE`](LICENSE), which retains the original copyright notice.

---

<details>
<summary>For maintainers</summary>

```powershell
node test/run-all.mjs      # 383 checks against dist/ieee-mcp.exe
```

Tests run entirely against built-in mock servers for IEEE and Crossref, so they
consume no real API quota. `IEEE_TEST_TARGET=bundle` tests the unbundled build for
faster iteration. The build is byte-reproducible (the SEA config disables the V8
code cache); set `IEEE_BUILD_CODE_CACHE=1` to opt in and lose that.

Further reading, in Chinese:

- [`docs/测试报告.md`](docs/测试报告.md) — test results and measured API behaviour
- [`docs/IEEE-API-参数核对.md`](docs/IEEE-API-参数核对.md) — parameters compared
  against the official IEEE documentation
- [`docs/上游源码审计.md`](docs/上游源码审计.md) — line-level code audit
- [`docs/README.zh-CN.md`](docs/README.zh-CN.md) — Chinese version of this README

</details>
