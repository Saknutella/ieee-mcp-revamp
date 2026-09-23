# IEEE Xplore MCP Server

包装 [IEEE Xplore API](https://developer.ieee.org/) 的 MCP 服务器，让 AI 助手（agent）
按研究主题检索并**批量取回候选论文的结构化元数据材料**（标题、作者、年份、刊物、摘要、
关键词、DOI、article_number、abstract_url、PDF 链接等），再由助手做语义相关性筛选。

交付形态是一个 **Windows x64 单文件 `ieee-mcp.exe`**：目标机器**无需安装 Node.js / npm**，
不使用 `npx`，启动时不下载任何依赖。

本项目基于 [danieltyukov/ieee-mcp](https://github.com/danieltyukov/ieee-mcp) `master`
（提交 `8dcc6b0`）完善而来，并修正了上游若干与官方文档不符之处
（见 [`docs/上游源码审计.md`](docs/上游源码审计.md)）。

| 交付物 | 位置 |
|---|---|
| Windows x64 单文件可执行程序 | `dist/ieee-mcp.exe` |
| 校验和 | `dist/SHA256SUMS.txt`（`sha256sum` 格式） |
| 构建环境与产物清单 | `dist/BUILD-INFO.json` |
| 源码（TypeScript） | `src/` |
| 可复现构建脚本 | `scripts/` |
| 自动化测试（383 项） | `test/` |
| 测试报告 | [`docs/测试报告.md`](docs/测试报告.md) |
| IEEE 官方参数核对 | [`docs/IEEE-API-参数核对.md`](docs/IEEE-API-参数核对.md) |
| 上游源码审计 | [`docs/上游源码审计.md`](docs/上游源码审计.md) |
| 许可证 | `LICENSE`（MIT，保留原作者版权） |

当前产物（构建**字节级可复现**，所以这些校验和可用于验证"源码 ↔ 二进制"的对应关系）：

| 文件 | 字节 | SHA-256 |
|---|---|---|
| `dist/ieee-mcp.exe` | 90,939,904 | `56b284f34448f8aaf146cdb95e79dcc61230c9e469dd70976f204bca00b851af` |
| `build/bundle.cjs` | 877,652 | `873e18f313f5a4a043c608ab185ed4f2ce752d96e5127a84a057d221da33beb3` |
| `build/ieee-mcp.blob` | 877,693 | `590c1a7a33deb452941e4491a235310d7745e30dd780736de72e5e89af0d6e27` |

> `dist/ieee-mcp.exe` 约 87 MiB，因为它**内含 Node.js 运行时**。它已加入 `.gitignore`
> （避免把大二进制写进 Git 历史）；仓库保留可复现构建脚本与校验和，一条命令即可重建出
> **字节相同**的产物。

---

## ⚠️ 检索范围声明（请先读）

IEEE Xplore Metadata Search API 对 `querytext` / `meta_data` 的官方定义是
*"a free-text search of all **configured metadata fields and abstract text**"*。

所以本服务：

- ✅ 检索**元数据字段与摘要文本**，支持 `AND` / `OR` / `NOT` 与通配符；
- ❌ **不是正文全文检索**，无法在论文正文里做关键词匹配；
- ❌ **不下载 PDF、不获取全文**，也不使用校园网/机构订阅权限（原因见[正文获取](#正文获取全文)）；
- ✅ 只返回 IEEE 元数据里真实存在的字段；缺失字段一律为 `null` 并列入 `missing_fields`，
  **绝不编造或补全**。

语义相关性判断由调用方（agent）完成，本服务**不内置任何 LLM**。

---

## Setup

上游的 README 里 Setup 是「装 Node → 构建 → 写 `~/.claude.json`」三步。
本项目的运行端**不需要 Node**，所以只有两步：**拿到 EXE**、**把 key 写进客户端配置**。

### 1. 取得 EXE

把 `dist/ieee-mcp.exe` 放到任意目录（**路径可含中文与空格**），例如
`D:\工具\IEEE MCP\ieee-mcp.exe`。

先做一次自检（不进入 MCP 模式，输出全在 **stderr**，stdout 保持干净）：

```powershell
.\dist\ieee-mcp.exe --self-test    # 打印生效配置（key 只显示 sha256 指纹）
.\dist\ieee-mcp.exe --version
.\dist\ieee-mcp.exe --help
```

校验完整性：

```powershell
Get-FileHash .\dist\ieee-mcp.exe -Algorithm SHA256
Get-Content .\dist\SHA256SUMS.txt
```

### 2. 提供 API Key —— 写在哪里

**免费 key 在 <https://developer.ieee.org> 申请**（选 *Content Discovery and Indexing* 用途）。

密钥**只从环境变量读取**，不硬编码、不写入磁盘、不打包进 EXE。而在 MCP 的架构里，
**环境变量是由启动这个 EXE 的客户端提供的**，所以要写在**客户端的配置里**：

```json
{
  "mcpServers": {
    "ieee": {
      "command": "D:/工具/IEEE MCP/ieee-mcp.exe",
      "args": [],
      "env": {
        "IEEE_API_KEY": "<你的 IEEE Metadata Search API Key>"
      }
    }
  }
}
```

关键点，**这就是「接入别的 agent 时 key 写哪里」的答案**：

| 问题 | 答案 |
|---|---|
| 写在哪 | 写在该 agent **自己的 MCP 配置**的 `env` 段里 |
| 字段名 | `IEEE_API_KEY` |
| 为什么不是全局环境变量 | 每个 MCP 客户端都**自己启动**这个 EXE 并把自己的 `env` 传下去，所以配置在哪就生效在哪，互不干扰 |
| 接第二个 agent 怎么办 | 在那个 agent 的配置里**再加一遍同样的条目**（key 必须再写一次） |
| 不想把 key 写在配置里 | 用 `IEEE_API_KEY_FILE` 指向一个只含密钥的 UTF-8 文件（见下） |

**方式 B：用文件保存密钥**（避免密钥出现在多个客户端配置里）

```json
{
  "mcpServers": {
    "ieee": {
      "command": "D:/工具/IEEE MCP/ieee-mcp.exe",
      "env": {
        "IEEE_API_KEY_FILE": "D:/工具/IEEE MCP/ieee-key.local"
      }
    }
  }
}
```

文件内容就是**一行密钥**（首行；`#` 开头的行会被忽略，BOM 会被自动去掉）：

```
<你的 key>
```

这样多个 agent 的配置里只出现文件路径，密钥本体集中在一处，轮换时只改一个文件。

> **不要**用 `setx IEEE_API_KEY ...` 设成用户级环境变量。那样密钥会进注册表、
> 并泄漏给**所有**进程（包括无关程序），比写进客户端配置更糟。

**安全保证**：日志与错误响应中密钥一律被替换为 `[REDACTED]`；`ieee_status` 只暴露
`sha256(key)` 的前 12 位十六进制指纹（可核对"是否换了 key"，无法反推）；`.gitignore`
已排除 `.env`、`*.key`、`ieee-key.local`。

### 3. 客户端配置

不同 agent 的配置文件位置不同，但**内容格式是一样的**（都是
`mcpServers` → `command` / `args` / `env`）。常见位置：

| 客户端 | 配置文件（常见位置，请以客户端文档为准） |
|---|---|
| Claude Desktop | `%APPDATA%\Claude\claude_desktop_config.json` |
| Claude Code | `~/.claude.json`（或项目级 `.mcp.json`） |
| Cursor | `%USERPROFILE%\.cursor\mcp.json` |
| Windsurf | `%USERPROFILE%\.codeium\windsurf\mcp_config.json` |
| VS Code（原生 MCP） | 工作区 `.vscode/mcp.json` |
| Cline / Roo 等扩展 | 通常在其设置界面里填，格式同上 |

完整示例：

```json
{
  "mcpServers": {
    "ieee": {
      "command": "D:/工具/IEEE MCP/ieee-mcp.exe",
      "args": [],
      "env": {
        "IEEE_API_KEY": "<你的 IEEE Metadata Search API Key>",
        "CROSSREF_MAILTO": "<你的邮箱，可选但建议>",
        "IEEE_MCP_STATE_DIR": "D:/工具/IEEE MCP/state",
        "IEEE_OUTPUT_DIR": "D:/检索结果",
        "IEEE_LOG_LEVEL": "info"
      }
    }
  }
}
```

配置要点：

- `command` 必须是 **EXE 的绝对路径**；Windows 下 JSON 里建议用 `/`，或写成 `\\`；
- 路径含空格或中文**无需额外转义**（客户端直接传 argv，不经过 shell）；
- **不要**在 `command` 里写 `node` / `npm` / `npx`，也不需要 `args`；
- 改完配置**必须重启该客户端**；
- 验证：让 agent 调用一次 `ieee_status`，能返回配置与用量即接入成功。

### 4. 需要代理时

IEEE 接口在国内常需代理。EXE 内置的 Node 运行时支持从环境变量读代理，
在同一个 `env` 段里追加即可：

```json
"env": {
  "IEEE_API_KEY": "<key>",
  "NODE_USE_ENV_PROXY": "1",
  "HTTPS_PROXY": "http://127.0.0.1:7890",
  "NO_PROXY": "localhost,127.0.0.1"
}
```

（`NODE_USE_ENV_PROXY=1` 是 Node 24 启用代理支持所需的开关，不能省。）

验证连通性——**不需要真实 key**，返回 `HTTP 403 Developer Inactive` 就说明网络可达：

```powershell
curl.exe --proxy http://127.0.0.1:7890 "https://ieeexploreapi.ieee.org/api/v1/search/articles?querytext=radar&apikey=x"
```

---

## Environment Variables

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `IEEE_API_KEY` | **是**\* | — | developer.ieee.org 申请的 Metadata Search API key |
| `IEEE_API_KEY_FILE` | **是**\* | — | 改为从 UTF-8 文件读取密钥（首行，`#` 注释） |
| `CROSSREF_MAILTO` | 否 | — | 联系邮箱，加入 Crossref polite pool（**强烈建议**，速率翻倍） |
| `IEEE_MCP_STATE_DIR` | 否 | `%LOCALAPPDATA%\ieee-mcp` | 账本/缓存/结果集目录；不可写时依次回退到 `%APPDATA%`、`~/.ieee-mcp`、EXE 同级 `.ieee-mcp`、临时目录 |
| `IEEE_OUTPUT_DIR` | 否 | 进程工作目录 | 导出相对路径的基准 |
| `IEEE_MAX_RPS` | 否 | `8` | IEEE 每秒请求上限，1–10 |
| `IEEE_DAILY_BUDGET` | 否 | `200` | **本地**每日预算（非官方额度，见 [Rate Limits](#rate-limits)） |
| `IEEE_BUDGET_WINDOW` | 否 | `both` | `both` / `utc-day` / `local-day` / `rolling-24h` |
| `IEEE_MAX_RETRIES` | 否 | `2` | 重试次数，0–5 |
| `IEEE_TIMEOUT_MS` | 否 | `20000` | 单次请求超时（ms），1000–120000 |
| `IEEE_CACHE_TTL_SECONDS` | 否 | `86400` | 缓存 TTL，`0` 关闭 |
| `IEEE_CACHE_MAX_ENTRIES` | 否 | `500` | 缓存条目上限 |
| `IEEE_CACHE_MAX_ENTRY_BYTES` | 否 | `2000000` | 单条缓存上限 |
| `IEEE_RESULT_TTL_SECONDS` | 否 | `21600` | 结果集（`search_id`）保留时间 |
| `IEEE_SHUTDOWN_GRACE_MS` | 否 | `120000` | stdin 关闭后等待在途请求的上限 |
| `IEEE_LOG_LEVEL` | 否 | `info` | `silent` / `error` / `warn` / `info` / `debug`（全部写 stderr） |
| `IEEE_USER_AGENT` | 否 | `ieee-mcp/2.0.0 …` | 请求 UA |
| `IEEE_MCP_CROSSREF_ENABLED` | 否 | `1` | 设为 `0` 关闭 `get_references`（Crossref 数据源） |
| `CROSSREF_MAX_RPS` | 否 | `3` | Crossref 请求频率上限（礼貌限速，可提到 10） |
| `CROSSREF_BATCH_SIZE` | 否 | `20` | 一次批量请求合并多少个 DOI |
| `IEEE_MCP_MAX_DOIS_PER_CALL` | 否 | `20` | 单次 `get_references` 最多查几篇 |
| `IEEE_MCP_MAX_BIBTEX_PER_CALL` | 否 | `25` | 单次最多取多少条权威 BibTeX |
| `IEEE_API_BASE` | 否 | 官方端点 | **仅供离线测试**指向 mock；覆盖时 stderr 会告警 |
| `CROSSREF_API_BASE` | 否 | `https://api.crossref.org` | **仅供离线测试** |

\* `IEEE_API_KEY` 与 `IEEE_API_KEY_FILE` 二者至少提供一个。
**未配置时进程仍会正常启动**（`initialize` / `tools/list` 可用），检索类工具返回结构化
`CONFIG_ERROR` 而不是静默失败——所以你能直接在对话里看到"该配 key 了"。

---

## Tools

| 工具 | 说明 |
|---|---|
| `search_papers` | 主检索：单查询或多查询合并，支持全部过滤与分页参数 |
| `search_by_author` | 按作者检索（`search_papers` 的便捷封装） |
| `search_by_publication` | 在指定期刊/会议内检索 |
| `get_paper_details` | 按 DOI 或 article_number 取单篇完整元数据；`output_format: "citation"` 直接给出引用 |
| `get_paper_citations` | 取单篇的引用论文数 / 引用专利数 |
| `get_references` | **取参考文献列表（数据源是 Crossref，不是 IEEE）**，支持 BibTeX |
| `export_results` | 导出 UTF-8 CSV / JSON / BibTeX，附溯源 sidecar |
| `ieee_status` | 生效配置、本地调用计数、缓存统计、IEEE 与 Crossref 状态 |

> 上游的 `get_full_text` 已被**移除**：它请求的 `/api/v1/search/document/{articleNumber}`
> 在官方文档中并不存在（实测 HTTP 596），且把校园网登录误当成 API token。
> 详见 [`docs/上游源码审计.md`](docs/上游源码审计.md)。上游的 `IEEE_AUTH_TOKEN` 环境变量
> 同样已移除。

### `search_papers` 主要参数

```jsonc
{
  // —— 检索条件（元数据 + 摘要，非正文）——
  "querytext": "radar AND beamforming",     // 支持 AND/OR/NOT 与 *（通配符前至少 3 字符）
  "queries": ["mmwave beamforming", "毫米波 波束成形"],  // 多变体，合并去重
  "meta_data": "Document Title:radar AND Author Terms:beamforming",
  "article_title": "...", "abstract": "...",
  "author": "Zhang", "affiliation": "Tsinghua",
  "index_terms": "beamforming",             // Author Keywords + IEEE Terms + MeSH
  "thesaurus_terms": "Array signal processing",
  "doi": "10.1109/...",                     // 提供后其它检索条件被 IEEE 忽略
  "article_number": "10107367",             // 同上，优先级更高

  // —— 过滤 ——
  "content_type": "Conferences",            // Books|Conferences|Courses|Early Access|Journals|
                                            // Journals,Magazines|Magazines|Standards（大小写敏感）
  "open_access": true,
  "start_year": "2020", "end_year": "2025",
  "publication_year": "2024",
  "publication_title": "IEEE Transactions on Antennas and Propagation",
  "publication_number": "...", "publisher": "IEEE",
  "isbn": "...", "issn": "0018-926X", "is_number": "3",
  "start_date": "20240101", "end_date": "20241231",

  // —— 排序 / 分页 / 预算 ——
  "sort_field": "publication_title",   // article_number | article_title | publication_title
  "sort_order": "desc",
  "max_records": 25,                   // 单次请求条数，IEEE 默认 25，上限 200
  "start_record": 1,                   // 绝对序号，从 1 开始（不是页码）
  "auto_paginate": false,              // true = 自动翻页直到触达下面的上限
  "max_total_records": 200,            // 本次调用最多返回多少条唯一记录
  "max_requests": 5,                   // 本次调用最多花多少次 HTTP 请求（含重试）
  "no_cache": false,                   // 跳过缓存读取（新结果仍会写回缓存）

  // —— 输出 ——
  "output_format": "json"              // json(默认) | markdown | csv | bibtex | citation
}
```

### 返回值结构

默认 `output_format: "json"`，`content[0].text` 为完整 JSON，同时填入 MCP
`structuredContent`（新版客户端可直接取结构化数据）：

```jsonc
{
  "search_id": "srch_m1a2b3c4d5",          // 传给 export_results / get_references
  "source": "IEEE Xplore",
  "search_scope": "metadata_and_abstract", // 明确不是全文检索
  "retrieved_at": "2026-01-01T00:00:00.000Z",
  "query": { "executed_queries": ["..."], "api_params": [{ }] },
  "total_records": 26,                     // IEEE 报告的总命中数（多查询合并时为 null）
  "returned_records": 25,
  "pagination": {
    "mode": "single",                      // single | merged
    "start_record": 1, "max_records": 25,
    "last_returned_index": 25,
    "has_more": true,
    "next_start_record": 26,
    "pages_fetched": 1,
    "truncated_by_limit": false,
    "stop_reason": "auto_paginate is disabled"
  },
  "usage": {                               // 均为"本地记账"，非 IEEE 官方剩余额度
    "local_calls_utc_day": 1,
    "local_calls_local_day": 1,
    "local_calls_rolling_24h": 1,
    "daily_budget": 200,
    "remaining_local_budget": 199,
    "note": "Local bookkeeping ... NOT the official IEEE remaining quota ..."
  },
  "cache": { "hit": false, "ttl_seconds": 86400, "cache_enabled": true },
  "dedup": { "duplicates_removed": 0, "matched_on": [], "keys": ["doi","article_number","title_year"] },
  "warnings": [],
  "per_query": [ { "query": "...", "total_records": 26, "returned": 25, "requests": 1, "has_more": true } ],
  "articles": [ /* PaperRecord[] */ ]
}
```

单条 `PaperRecord`（**缺失字段必为 `null`，不编造**）：

```jsonc
{
  "article_number": "10107367",
  "doi": "10.1109/ACCESS.2023.3261234",
  "doi_url": "https://doi.org/10.1109/ACCESS.2023.3261234",
  "title": "...",
  "authors": [ { "name": "Alice Zhang", "affiliation": "Tsinghua University", "order": 1 } ],
  "author_names": "Alice Zhang; Bob Müller",
  "year": "2023",
  "publication_date": "2023-04-15",
  "publication_title": "IEEE Access",
  "content_type": "Journals",
  "abstract": "...",
  "keywords": { "author_terms": ["..."], "ieee_terms": ["..."], "mesh_terms": ["..."], "other": {} },
  "abstract_url": "https://ieeexplore.ieee.org/document/10107367",
  "html_url": "https://ieeexplore.ieee.org/document/10107367",
  "pdf_url": null,                          // IEEE 未返回时为 null，属正常
  "is_open_access": false,
  "access_type": "Locked",
  "pages": "1-12", "volume": "11", "issue": "4",
  "publisher": "IEEE", "issn": "2169-3536",
  "citing_paper_count": 12, "citing_patent_count": 0,
  "source": "IEEE Xplore",
  "retrieved_via": "search_papers",
  "missing_fields": ["pdf_url"]
}
```

`missing_fields` 检查的字段：`title`、`authors`、`year`、`publication_title`、`abstract`、
`keywords`、`doi`、`article_number`、`abstract_url`。
`pdf_url` 官方即为可选，缺失不计入。

### 分页与去重

**分页边界（上游缺陷，已修）**。上游用 `startRecord + articles.length < total` 判断是否还有
下一页；`total_records = 26`、首批 25 条时 `1 + 25 < 26` 为**假**，于是不提示下一页，
调用方会以为只有 25 条结果。现在改为按**最后一条记录的绝对序号**比较：

```
last_returned_index = start_record + returned - 1
has_more            = last_returned_index < total_records
next_start_record   = last_returned_index + 1
```

`auto_paginate: true` 时连续翻页，遇到以下任一条件停止，并把原因写入
`pagination.stop_reason`：① 达到 `max_total_records`；② 达到 `max_requests`；
③ IEEE 报告的 `total_records` 已取完或返回不足一页；④ 整页没有带来任何**新的唯一记录**
（防止排序不稳定导致死循环）。

`queries: [...]` 多查询合并时 `pagination.mode` 变为 `"merged"`，`total_records` 置为
`null`（并集无意义），每个查询各自的状态在 `per_query` 里。

**去重与字段互补**：按 ① 规范化 DOI → ② `article_number` → ③ 规范化标题+年份
任意命中即视为同一篇。重复项**不是简单丢弃**——保留记录的 `null` 字段会从重复项回填
（含 `keywords` 并集、`authors`、引用数），从而得到尽可能完整的记录。

### `get_references`：参考文献查询（第二个数据源）

**为什么需要它**：IEEE Metadata Search API **完全没有参考文献字段**——
`citing_paper_count` 和 `citing_patent_count` 都是"**被**引用"的次数，两个都是**进来的**。
想知道"这篇引了谁"，IEEE 侧无解，只能换数据源。

**来源必须说清楚**：

| | |
|---|---|
| 数据源 | **Crossref REST API**（`source: "Crossref REST API"`，`source_is_ieee: false`） |
| 内容 | 出版商存缴的参考文献条目，含出版商的引用键 `ref1` / `ref2` … |
| 不是 | **不是 IEEE 元数据**。IEEE 侧无法交叉验证或推翻这份列表 |
| 必须 | **自行核验**（`verification_required: true`，并附 IEEE Xplore 页面直链） |

核验依据（**小样本，请勿过度外推**）：2026-09 用 2 篇 IEEE 论文逐位核对，Crossref 与
IEEE Xplore 页面**完全一致**——IEEE TCSII 2021（art. 9422824）14/14，
ESSCIRC 2019（art. 8902902）7/7，**连出版商没给 DOI 的那几条都对得上**。但 2 篇是 2 篇。

```jsonc
// 单个或多个 DOI（多个会自动合并成一次请求）
{ "dois": ["10.1109/TCSII.2021.3077589", "10.1109/ESSCIRC.2019.8902902"] }

// 或直接接着一次 IEEE 检索的结果（会自动附上 IEEE 页面核验链接）
{ "search_id": "srch_m1a2b3c4d5" }
{ "search_id": "srch_m1a2b3c4d5", "article_numbers": ["9422824"] }

{ "dois": ["10.1109/TCSII.2021.3077589"], "output_format": "bibtex" }
```

**请求次数怎么算**（一次请求返回一篇的**完整**引用数组，所以成本不随引用条数增长）：

| 操作 | 请求数 |
|---|---|
| 查 1 篇的引用列表 | **1 次**（实测 14 条引用一次返回） |
| 查 N 篇的引用列表 | **1 次**（批量，实测 3 篇 / 42 条引用一次返回） |
| `bibtex_mode: "crossref"` | **每个带 DOI 的条目 1 次** ← 唯一按条数计的 |
| 命中缓存 | **0 次** |

多 DOI 走 Crossref 批量接口 `filter=doi:A,doi:B,...`（字段名必须重复；写成 `doi:A,B`
会被 Crossref 以 400 拒绝）。**批量没覆盖到的 DOI 会自动降级为单篇请求**——只有单篇才能
给出精确的 `NOT_FOUND`，所以部分失败时仍然每篇独立报错；批量整体失败时也会降级。

每篇返回：`references_returned`、`references_count_from_crossref`、`counts_agree`
（不一致会告警）、`with_doi` / `without_doi`、`crossref_url`，以及核验链接
`verify.crossref` / `verify.doi` / `verify.ieee_xplore`。
**条目按出版商的引用键排序**（Crossref 接口本身返回的是存缴顺序，不是引用顺序）。

BibTeX 三种模式：

| `bibtex_mode` | 行为 | 代价 |
|---|---|---|
| `generated`（默认） | 用 Crossref 存缴的字段本地生成 | 0 |
| `crossref` | 对每个带 DOI 的条目走内容协商取权威 BibTeX | 每条 1 次（免费） |
| `none` | 不生成 | 0 |

**强烈建议对 IEEE 论文用 `crossref`**：实测 TCSII 的 14 条里有 **10 条 Crossref 只存了 DOI、
没有标题/作者/年份**，`generated` 只能产出空壳条目（会附一句说明性 `note`）；
`crossref` 模式下这 10 条全部变成完整条目（完整作者列表、页码范围、ISSN，
那本 Springer 专著还正确识别成了 `@book`）。`generated` 的条目类型是**从容器标题猜的**，
可能猜错。两种模式都会在输出头部写明来源与核验要求。

边界：**Crossref 请求不消耗 IEEE 额度**，也不写入 IEEE 账本——实测**不配置 `IEEE_API_KEY`
也能正常使用 `get_references`**。记录没有 DOI 会被跳过并列入 `warnings`（Crossref 只能用
DOI 查）。无 DOI 的参考文献条目无法自动解析，Crossref 仍保留其 title/author/year，需人工匹配。
用 `IEEE_MCP_CROSSREF_ENABLED=0` 可整体关闭这个数据源。

> ⚠️ **别把两个"引用数"混用**：参考文献数是这篇**引用了**多少篇（outgoing），
> 被引次数是这篇**被**多少篇引用（incoming）。两个方向不可比。而且实测三个源的被引次数
> **并不总是一致**（同一篇 ESSCIRC 2019：IEEE 15 / Crossref 15 / OpenAlex 18）。

### 引用一篇论文

`get_paper_details`（以及检索类工具）加 `output_format: "citation"` 会返回**可直接使用的
引用包**：

```jsonc
{ "doi": "10.1109/TCSII.2021.3077589", "output_format": "citation" }
```

内含三种形式：**纯文本引用（IEEE 风格）**、**BibTeX**、**RIS**。
RIS 就是 Zotero / EndNote / Mendeley 的导入格式。实测输出：

```
J. Park, Y. Shin, J. Choi, and S. Kim, "A 5.02nW 32-kHz Self-Reference Power Gating XO
With Fast Startup Time Assisted by Negative Resistance and Initial Noise Boosters",
IEEE Transactions on Circuits and Systems II: Express Briefs, vol. 68, no. 11,
pp. 3386-3390, 2021, doi: 10.1109/TCSII.2021.3077589.
```

两点必须知道：

1. **元数据来源是 IEEE**（这个功能不走 Crossref），引用串是**机械拼装**的——信息全部来自
   IEEE 返回的字段，缺失字段会显式标注并列入 `missing_fields`；
2. **IEEE 风格的作者缩写是启发式转换**（`Jee-Ho Park` → `J. Park`），姓名顺序本身随文化
   而异，**投稿前请自行核对作者格式**。BibTeX 和 RIS 用完整姓名，没有这个问题。

### 导出

`export_results` 支持 `csv` / `json` / `bibtex`：

- **CSV**：UTF-8 **带 BOM**（Excel 打开不乱码）、CRLF、RFC 4180 引号转义；
  含 `source` / `retrieved_at` / `query_id` / `missing_fields` 等溯源列；
- **JSON**：`{ meta: {...}, records: [...] }`；
- **BibTeX**：`%` 注释头写出来源、`search_id`、检索条件、检索时间；条目类型按
  `content_type` 映射（Conferences→`@inproceedings`，Journals→`@article`，
  Books→`@book`，其它→`@misc`）；citation key 为 `首作者姓+年份+article_number` 并自动去重。

**每种格式都会额外写一个 `<文件名>.meta.json` 溯源文件**，记录 `source` / `endpoint` /
`retrievedAt` / 完整检索条件 / `searchScope` 等，用于日后核对"这批结果是怎么来的"。

```jsonc
{ "search_id": "srch_m1a2b3c4d5", "format": "csv", "output_path": "结果/论文列表.csv" }
```

相对路径以 `IEEE_OUTPUT_DIR`（默认进程工作目录）为基准；目录不存在会自动创建；
省略扩展名时按格式补 `.csv` / `.json` / `.bib`。

---

## Rate Limits

上游 README 只有一句"The free IEEE API tier allows ~200 calls/day"。这里分开说清楚，
因为现在有**两个数据源，限制模型完全不同**。

### IEEE

- 官方额度：约 **10 calls/second、200 calls/day**（每 key）。
- 本服务默认 `IEEE_MAX_RPS=8`（留了安全余量）、`IEEE_DAILY_BUDGET=200`。
- 每次 HTTP **尝试**（含每次重试）在发出前先**预占一个额度**，所以重试计入预算。
- 账本是 JSON 文件 + `mkdir` 原子锁，**多进程共享**：两个客户端同时跑也不会重复消耗同一
  个额度，也不会各自突破每秒上限。

**关于"每日"的时区**：IEEE 未公布其 Rate Limits 的重置时区，因此本服务**不假设**任何重置
时刻，而是同时记录并展示三个窗口（UTC 日 / 本地日 / 滚动 24h），由 `IEEE_BUDGET_WINDOW`
决定按哪些窗口拦截（默认 `both`，即最严格）。

> **本计数是本服务的本地记账，不是 IEEE 官方剩余额度。** 该声明写进了每次返回的
> `usage.note` 与 `ieee_status.local_usage.disclaimer`。
> 实测 IEEE **不返回任何限流响应头**（无 `X-RateLimit-*`、无 `Retry-After`），
> 所以本地计数**无法**与官方额度对账——与官方控制台不一致时以 IEEE 为准。
> 需要重置本地记账：删除 `state_dir/usage-ledger.json`，或调用
> `ieee_status({reset_local_usage:true})`。

### Crossref

**没有每日配额**，限制是速率与并发（官方 Access and authentication 页）：

| Pool | 速率 | 并发 | 进入方式 |
|---|---|---|---|
| Public | 5/s | 1 | 默认 |
| Polite | **10/s** | **3** | 请求带 `mailto` ← **设 `CROSSREF_MAILTO` 即可** |
| Plus（付费） | 150/s | 无 | API key |

实测响应头会直接回显 `x-api-pool` / `x-rate-limit-limit` / `x-concurrency-limit`，
所以 `CROSSREF_MAILTO` 不只是礼貌——它把速率翻倍、并发翻三倍。本服务默认
`CROSSREF_MAX_RPS=3`（更保守），要跑快些设 `CROSSREF_MAX_RPS=10`。

### 缓存

- 键为 `哈希(端点 + 全部有效参数)`，存于 `IEEE_MCP_STATE_DIR/cache/`；
- 默认 TTL `86400s`（`IEEE_CACHE_TTL_SECONDS=0` 关闭），条目上限 500，单条上限 2 MB；
- 过期条目读取时删除，写入时按 mtime 淘汰超限旧条目；
- 命中缓存**不消耗**额度与请求；`no_cache: true` 只跳过读取、仍会写回；
- 同一进程内**并发的相同请求会自动合并**（coalesce），不会重复计费。

### 超时与重试

| 情况 | 行为 |
|---|---|
| 网络错误 / 超时 | 重试（指数退避 + 抖动，上限 15s） |
| `429` | 重试，优先遵循 `Retry-After` |
| `408` / `425` / `5xx` | 重试 |
| `400` | **不重试** → `BAD_REQUEST` |
| `401` | **不重试** → `AUTH_ERROR` |
| `403` | **不重试** → `FORBIDDEN` |
| `404` | **不重试** → `NOT_FOUND` |

`IEEE_MAX_RETRIES` 默认 2（总尝试 3 次）。错误响应统一为：

```jsonc
{
  "ok": false,
  "code": "AUTH_ERROR",          // 机器可读
  "message": "...",              // 已脱敏
  "http_status": 401,
  "retryable": false,
  "api_code": "401",             // IEEE 返回的错误码（已脱敏）
  "api_message": "...",          // IEEE 返回的错误消息（已脱敏）
  "attempts": 1,
  "hint": "..."
}
```

---

## 正文获取（全文）

**当前不支持，且不是实现问题。** IEEE 官方
[Currently Supported API Use Cases](https://developer.ieee.org/Allowed_API_Uses) 只支持三种用途：

| 用途 | 内容 |
|---|---|
| Content Discovery and Indexing | 元数据抽取与索引 ← **个人 Metadata key 对应这个** |
| Open Access Articles | 开放获取全文（面向 organizations） |
| **Text and Data Mining (TDM)** | 全文，**仅限非商业研究，且要求机构有有效的 IEEE Xplore 订阅**，需联系 IEEE 申请 |

**要合法拿到正文，路径是"通过所在机构的图书馆申请 TDM 权限"**，而不是用个人 Metadata key，
也不是脚本化机构登录。理由：

- 个人 `IEEE_API_KEY` **不携带机构订阅权限**；
- IEEE Xplore 的 `robots.txt` 明确写着 `Disallow: /rest`（内部接口）与
  **`Disallow: /ielx*`**——后者正是 PDF 下载路径的形态；
- 同一份 `robots.txt` 里 **`ClaudeBot` / `Claude-User` 被整站 `Disallow: /`**，
  `GPTBot`、`Google-Extended`、`PerplexityBot`、`CCBot` 等一长串 AI agent 同样被整站禁止；
- IEEE API ToU 禁止 robot/spider 检索或索引 Content，并**禁止将 Content 用于训练或开发任何
  AI/LLM 系统**——这一条即使拿到 TDM 权限也仍然适用。

所以：**少量 PDF 你自己在浏览器里点开读没问题**（网站本来就是给读者的）；
**批量拿正文只走机构 TDM 申请**。用脚本登录机构账号批量下载，风险落在**你所在机构的整站
访问权**上，不是小事。工具已经给出人工核验直链（`verify.ieee_xplore`），需要看正文时点开即可。

### 参考文献的另一条路：从 PDF 提取

如果某篇论文 Crossref 没有存缴引用列表，那就只能从 PDF 里解析。做这件事的**不是 Zotero**，
而是 **GROBID**：

| | Zotero | GROBID |
|---|---|---|
| 「Retrieve PDF Metadata」做什么 | 把 PDF **前几页文本**发给 Zotero 服务，结合 Crossref 与 DOI/ISBN 查询，生成**文献条目元数据**（标题/作者等） | 不适用 |
| 提取 PDF 里的**参考文献列表** | **不做** | **专门做这个**：References extraction and parsing，F1 ≈ 0.87–0.90 |
| 许可 | AGPL | Apache-2.0 |
| 平台 | 跨平台 | **官方只支持 Linux/macOS**（Windows 需 Docker/WSL）；Java，提取引用约需 3 GB 内存 |

Zotero 的 PDF 识别功能其实是 **Crossref 的下游消费者**——和本服务用的是同一个数据源。

**决策顺序**：① 先查 Crossref（`get_references`），有就用，**完全不需要 PDF**；
② Crossref 没有且你**已合法持有该 PDF**，才考虑 GROBID；
③ 为了批量拿引用而去批量抓 PDF，回到上面的访问权限问题，不建议。

---

## 已知限制

1. **只有元数据检索**，没有正文/PDF 获取（见[正文获取](#正文获取全文)，是权限模型问题）。
2. **不支持 facet 参数**（`facet` / `d-au` / `d-publisher` / `d-pubtype` / `d-year`）：
   官方定义它们返回"细化链接"而非结果集。
3. **深层分页依赖 IEEE 行为**：官方在 `start_record` 下注有 "maximum results is 200"；
   本服务默认 `max_total_records = 200`，上限 1000。IEEE 不保证深翻页稳定性，故在
   "整页无新增唯一记录"时主动停止并在 `stop_reason` 说明。
4. **本地计数 ≠ 官方额度**：见 [Rate Limits](#rate-limits)。
5. **IEEE 不返回限流响应头**，本地计数无法与官方额度对账。
6. **缓存/结果集是本地副本**：受 IEEE ToU 约束，均设条目与时间上限，不做无限镜像。
7. **产物自身未做代码签名**（无代码签名证书），Windows SmartScreen 首次运行可能提示
   "未知发布者"；请用 `dist/SHA256SUMS.txt` 校验完整性。
8. **`publication_year` 格式不统一**：官方说明其格式随出版物而异，本服务原样透传字符串。
9. **BibTeX 为 UTF-8 原文**，仅转义 `{` / `}` / `\`；老式 BibTeX 引擎可能需要 biblatex。
10. **EXE 体积约 87 MiB**：单文件自包含 Node 运行时的代价。
11. **仅验证 Windows x64**：构建脚本按 Windows PE / SEA 流程编写，其他平台未验证。
12. **字节级可复现依赖构建环境**：同一 Node 大版本下已验证两次构建 SHA-256 相同；
    换用不同 Node 版本时 blob 必然不同，此时以新的 `dist/SHA256SUMS.txt` 为准。

### 真实接口行为提示（已实测）

- **`article_number` / `doi` 必须单独发送**。只要附带 `max_records`，IEEE 会返回
  `total_records: 1` 却**完全省略 `articles` 数组**（HTTP 200，无任何错误提示）。
  本服务因此对标识符查询只发送标识符本身。上游实现恰好是
  `{max_records:1, doi|article_number}`，所以它的 `get_paper_details` /
  `get_paper_citations` 在真实接口上**一直是静默失效的**（总是回答 "No paper found"）。
- **无效/未激活的 key 返回的是 HTTP 403**（`Developer Inactive`），不是 401；
  本服务在错误提示里明确指出这一点，且不对 403 重试。
- **IEEE 官方 API 无参考文献、无被引清单**：实测把 article 对象的全部 31 个字段打出来，
  只有 `citing_paper_count` / `citing_patent_count` 两个计数，没有任何列表。
- 少数历史文献可由检索命中、但用 `article_number` 取不到记录体；此时返回空结果并给出说明。
- **Crossref 引用数的可信度只在小样本上验证过**（2 篇、21 条，逐位全中）。它是出版商存缴
  数据的镜像，但不是全覆盖：出版商没存缴的就没有，很多条目只有 DOI 没有题录。

---

## Roadmap / 未实现

按"是否值得做"排序，都还没做：

1. **被引清单（`get_citing_works`）** —— "谁引用了这篇"。IEEE 侧完全没有（没有 API，
   网站又禁止自动化访问），可行方案是接 **OpenAlex** 的 `cited_by_api_url`：有正规 API、
   免费、无需 key。
   ⚠️ 但实测 OpenAlex 的**计数不可信**（同一篇 ESSCIRC 2019：IEEE 15 / Crossref 15 /
   **OpenAlex 18**），所以这个工具只能**用来取列表做导航，绝不能用来数数**，
   并且必须像 `get_references` 一样标注来源与 `verification_required`。
   目前重要性不高，暂缓。
2. **正文获取** —— 依赖机构 TDM 授权，是权限问题不是代码问题（见[正文获取](#正文获取全文)）。
3. **PDF 参考文献提取（GROBID）** —— 只在 Crossref 未存缴引用列表时才有增量价值，
   且 GROBID 官方不支持 Windows（需 Docker/WSL）。优先级低。
4. **DOI API（IEEE）** —— IEEE 另有一个 DOI API，一次最多按 25 个 DOI 批量取元数据，
   适合"手里已有一批 DOI 想补摘要"的场景。需要**单独申请**该 API 的授权
   （当前 key 是 Metadata Search 用途），且未获得 key 前无法真实验证。
5. **RIS 导出** —— `citation` 输出已含 RIS，但 `export_results` 目前只有
   `csv` / `json` / `bibtex`；如需要可加 `ris` 便于整批导入 Zotero。

---

## 合规

IEEE Xplore API Terms of Use（<https://developer.ieee.org/API_Terms_of_Use2>）要点，
使用前请自行阅读原文：

- 许可限于**非商业教育/科研用途**，且限于当前 IEEE 客户；
- **不得批量呈现**：*"you may only present the Content in response to an individual query;
  you may not present the Content in bulk format"*；
- 不得使用机器人/爬虫批量抓取或索引；
- **禁止**将 Content 用于训练/增强/开发任何 AI、机器学习或大模型系统。

因此请把本工具用于**交互式检索与筛选**，不要用于批量收割或构建训练集。
（Crossref 侧的数据来自出版商存缴，同样建议遵守对应出版商的条款。）

---

## 开发者：构建与测试

### 可复现构建

前置：Node.js ≥ 20（**仅开发机需要，运行机不需要**）。

```powershell
cd IEEE_search_MCP
npm install                     # 若 npm 缓存目录不可写：npm install --cache .\.npm-cache
node scripts/build.mjs          # 清理 → 类型检查 → esbuild 打包 → SEA → 注入 → 校验和
```

分步：`node scripts/bundle.mjs` → `node scripts/build-sea.mjs` → `node scripts/checksums.mjs`

1. **打包**：esbuild 把 TypeScript 与 `@modelcontextprotocol/sdk`、`zod` 打成单个 CommonJS
   文件（约 860 KB），运行期不需要 `node_modules`。
2. **单文件**：Node 24 的 SEA（`--experimental-sea-config`）生成 blob，`postject` 注入一份
   `node.exe` 副本。产物 = Node 运行时 + bundle。
3. **去签名**：注入前移除 `node.exe` 的 Authenticode 证书表（PE 目录项 4），否则被改写过的
   签名镜像在部分 Windows 策略下会被拒绝加载。纯 JS 实现的 PE 解析，
   **不依赖 Windows SDK 的 `signtool`**。
4. **离线**：`npm install` 之后整个构建过程不需要网络。

**字节级可复现**：连续两次 `node scripts/build.mjs` 会产生完全相同的 SHA-256
（`bundle.cjs`、`ieee-mcp.blob`、`ieee-mcp.exe` 三者一致），所以 `dist/SHA256SUMS.txt`
可以用来验证"这份源码确实能构建出这份二进制"。原因是 SEA 配置中**关闭了 V8 code cache**
（开启会嵌入非确定性的代码缓存；实测两者冷启动都约 73 ms，所以默认关闭不牺牲性能）。
需要尝试：`$env:IEEE_BUILD_CODE_CACHE="1"; node scripts/build.mjs`（构建不再字节可复现）。

> 构建脚本用 `node scripts/build.mjs` 直接运行而非 `npm run`，是为了在受限环境
> （例如禁止子进程管道的沙箱）下也能构建：esbuild 走 CLI（stdio 直通），
> postject 走进程内 JS API，自检走文件描述符重定向。

### 测试

```powershell
node test/run-all.mjs                       # 默认测 dist/ieee-mcp.exe（383 项）
node test/run-all.mjs search export         # 只跑指定套件
node test/run-all.mjs crossref              # 只跑 Crossref 参考文献套件
$env:IEEE_TEST_TARGET="bundle"; node test/run-all.mjs   # 测未打包 bundle，迭代更快
```

测试**默认全部使用内置 mock 服务**（`test/mock-ieee-server.mjs`、
`test/mock-crossref-server.mjs`，响应形状分别对齐 IEEE "Data Fields Returned" 与
Crossref `/works` 与批量接口），**不消耗任何真实 API 额度**。

| 套件 | 项数 | 覆盖内容 |
|---|---|---|
| `protocol` | 30 | `initialize`、`tools/list`、stdout 纯净性、stdout/stderr 分离、无密钥降级、`get_full_text` 已移除、未知工具错误、状态文件不含密钥 |
| `cli` | 26 | `--version` / `--help` / `--self-test`、stdout 保持为空、指纹格式、stdin 立即 EOF、状态目录不可用仍可启动 |
| `search` | 103 | **分页边界 26/25**、翻页不重叠、字段完整性与 `missing_fields`、缓存命中/过期/持久化/关闭、并发合并、多查询合并去重与字段互补、`auto_paginate` / `max_requests` 上限、参数大小写与 `%20` 编码、`doi`/`article_number` 排他性、非法输入拒绝、便捷工具、`ieee_status` 清理与重置 |
| `crossref` | 105 | **来源标注为 Crossref 而非 IEEE**、`verification_required`、**IEEE 额度零消耗与账本隔离**、**批量查询与批量内降级**、引用键排序还原论文编号、带/不带/仅 DOI 三类条目、计数不一致告警、部分失败、404、`search_id` 接入与核验链接、三种 BibTeX 模式、**citation 输出**、politeness UA、缓存、重试、禁用与上限 |
| `resilience` | 61 | 400/401/403/404 不重试、429 `Retry-After`、5xx 重试与耗尽、超时、**重试计入预算**、本地预算拦截、**跨进程账本**、**跨进程限速**、密钥全链路脱敏 |
| `export` | 58 | CSV BOM/行数/中文/溯源列、JSON meta、BibTeX 条目与注释头、sidecar 溯源、**含中文与空格的路径**、显式 records 导出、标识符查询、`ieee_status` |
| **合计** | **383** | |

真实 API 验证（IEEE 30 次调用 + Crossref 免费调用）见
[`docs/测试报告.md`](docs/测试报告.md)。

---

## 许可证与来源

- 本仓库保留原项目 **MIT License** 与原作者版权声明（见 `LICENSE`）。
- 上游：`https://github.com/danieltyukov/ieee-mcp` @ `8dcc6b0b6abbb2425b9be28392dc27b5ce17b131`。
- 本仓库**第一个提交即上游 `master` 原样状态**，其后提交为本次完善内容，
  可直接 `git log` / `git diff` 审阅。
