# IEEE Xplore MCP Server

Search IEEE Xplore from any MCP-capable AI agent and get back structured paper
metadata — title, authors, year, venue, abstract, keywords, DOI, article number,
abstract URL and PDF link — so the agent can screen candidates for relevance.

Ships as a single Windows x64 executable: no Node.js, no npm, no npx, nothing
downloaded at startup.

> **Scope.** The IEEE Metadata Search API searches *configured metadata fields and
> the abstract text*, not article bodies, and this server does not download PDFs.
> Missing values come back as `null` and are listed in `missing_fields` — nothing
> is invented. Relevance judgement is left to the calling agent.

---

## Install

**Prebuilt** — grab `ieee-mcp.exe` from the release and put it anywhere. Paths with
spaces or non-ASCII characters are fine.

```powershell
.\ieee-mcp.exe --self-test   # print the effective config (key shown as a hash only)
```

**From source** — Node.js ≥ 20 on the build machine only; offline after install.

```powershell
npm install
node scripts/build.mjs     # → dist/ieee-mcp.exe + dist/SHA256SUMS.txt
```

## API key

Get a free key at <https://developer.ieee.org> (use case *Content Discovery and
Indexing*) and pass it in the environment:

```json
"env": { "IEEE_API_KEY": "your-key-here" }
```

The key is never written to disk, never embedded in the exe, and never logged: all
output is scrubbed, and `ieee_status` reports only a `sha256(key)` fingerprint so
you can confirm which key is loaded.

To keep it out of your config files, use a file instead — key on the first line
(`#` comments and a UTF-8 BOM are tolerated):

```json
"env": { "IEEE_API_KEY_FILE": "D:/Tools/ieee-key.local" }
```

## Client config

Config file locations differ per client; the format is the same everywhere.

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

`command` must be the absolute path to the exe. Restart the client after editing,
then ask the agent to call `ieee_status` to confirm it loaded. Through a proxy, add
`"NODE_USE_ENV_PROXY": "1"` and `"HTTPS_PROXY": "http://127.0.0.1:<proxy_port>"`.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `IEEE_API_KEY` / `IEEE_API_KEY_FILE` | — | Your key, supplied one way or the other |
| `CROSSREF_MAILTO` | — | Crossref contact address — **recommended**, doubles your rate limit |
| `IEEE_OUTPUT_DIR` | working directory | Base for relative export paths |
| `IEEE_MCP_STATE_DIR` | `%LOCALAPPDATA%\ieee-mcp` | Usage ledger, cache, result sets |
| `IEEE_DAILY_BUDGET` | `200` | Local call budget — see [Constraints](#constraints-of-the-non-commercial-api) |
| `IEEE_MAX_RPS` | `8` | Requests/second cap, 1–10 |
| `IEEE_LOG_LEVEL` | `info` | `silent` / `error` / `warn` / `info` / `debug` |

Also available: `IEEE_MAX_RETRIES`, `IEEE_TIMEOUT_MS`, `IEEE_CACHE_TTL_SECONDS`,
`CROSSREF_MAX_RPS`, `IEEE_MCP_CROSSREF_ENABLED`.

Without a key the server still starts — `initialize` and `tools/list` work, and
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

`output_format: "json"` returns the payload in `content[0].text` and in MCP
`structuredContent`. Top level: `search_id` (pass it to `export_results` or
`get_references`), `search_scope`, `total_records`, `returned_records`,
`pagination`, `usage`, `dedup`, `warnings`, `articles`.

`pagination` gives `has_more` and `next_start_record` — use the latter to fetch the
next page. `has_more` is computed from the absolute index of the last record
returned, so a full page out of a slightly larger total still advertises the next
one. With `auto_paginate`, paging stops at `max_total_records`, at `max_requests`,
when IEEE runs out, or when a page adds no new unique records (`stop_reason` says
which).

Each paper carries `article_number`, `doi`, `doi_url`, `title`, `authors` (with
affiliations and order), `author_names`, `year`, `publication_date`,
`publication_title`, `content_type`, `abstract`, `keywords` (`author_terms`,
`ieee_terms`, `mesh_terms`), `abstract_url`, `html_url`, `pdf_url`,
`is_open_access`, `access_type`, `pages`, `volume`, `issue`, `publisher`, `isbn`,
`issn`, `conference_location`, `conference_dates`, `citing_paper_count`,
`citing_patent_count`, `source` and `missing_fields`.

`missing_fields` lists absent values among `title`, `authors`, `year`,
`publication_title`, `abstract`, `keywords`, `doi`, `article_number` and
`abstract_url`. `pdf_url` is optional by IEEE's own definition.

Multi-query results are matched on normalized DOI, then `article_number`, then
normalized title + year. Duplicates are not simply dropped: a record's `null`
fields are back-filled from its duplicate.

### `get_references` — reference lists (Crossref)

IEEE's API has no reference list at all — `citing_paper_count` and
`citing_patent_count` are both *incoming* citations. This tool fills that gap from
Crossref, which holds the publisher-deposited bibliography, including the citation
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

One request returns a paper's *complete* reference array, and multiple DOIs are
batched into one request — so cost does not scale with references or papers. The
only per-reference cost is `bibtex_mode: "crossref"`, which fetches authoritative
BibTeX one reference at a time; prefer it for IEEE papers, since many references
are deposited with a DOI and nothing else. `generated` (the default) builds entries
from the deposited fields and infers the entry type, which can be wrong.

Papers without a DOI are skipped and listed in `warnings`.

### Citing a paper

```jsonc
{ "doi": "10.1109/TCSII.2021.3077589", "output_format": "citation" }
```

Returns an IEEE-style plain-text citation, a BibTeX entry and an RIS record (RIS
imports straight into Zotero, EndNote or Mendeley). Search tools accept the same
option for several papers at once.

The string is assembled mechanically from IEEE's metadata, and the IEEE-style
author initials are a heuristic (`Jee-Ho Park` → `J. Park`) — name order varies by
culture, so check author formatting before submitting. BibTeX and RIS use full
names.

### Exporting

`export_results` writes `csv`, `json` or `bibtex`, plus a `<name>.meta.json`
sidecar recording the source, endpoint, retrieval time and the exact query. CSV is
UTF-8 with BOM (opens cleanly in Excel) and includes provenance columns.

```jsonc
{ "search_id": "srch_m1a2b3c4d5", "format": "csv", "output_path": "results/papers.csv" }
```

---

## Constraints of the non-commercial API

**Quotas.** IEEE allows roughly 10 calls/second and 200 calls/day per key. Every
HTTP attempt, retries included, reserves budget before it is sent, and the ledger
is shared across processes. The counter is **local bookkeeping, not your official
remaining quota**: IEEE publishes no reset time zone and returns no rate-limit
headers, so UTC day, local day and rolling 24h are all tracked and reported — trust
IEEE where they disagree. Reset with `ieee_status({ "reset_local_usage": true })`.
Reference lookups go to Crossref, which has no daily quota and never touches the
IEEE budget.

**No full text.** IEEE supports three API use cases
([official list](https://developer.ieee.org/Allowed_API_Uses)): Content Discovery
and Indexing — what a personal Metadata key gets you — Open Access Articles, and
Text and Data Mining. The last is full text, for non-commercial research only, and
requires an active institutional subscription requested through your library. A
personal key carries no such entitlement, and Xplore's `robots.txt` and terms both
prohibit scripted retrieval. Reading a few PDFs yourself in a browser is fine —
this server gives you the direct link in `verify.ieee_xplore`.

---

## Roadmap

Citing-work lists ("who cited this") are not implemented. IEEE has no API for it
and its site blocks automation; the route would be OpenAlex, whose counts are
unreliable, so such a tool could only navigate a list and never supply counts.

---

## License

MIT — see [`LICENSE`](LICENSE), which retains the original copyright notice.
