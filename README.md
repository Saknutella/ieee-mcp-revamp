# ieee-mcp — IEEE Xplore 元数据检索 MCP（Windows x64 单文件 EXE）

基于 [danieltyukov/ieee-mcp](https://github.com/danieltyukov/ieee-mcp) `master`
（提交 `8dcc6b0`）完善而来的 **IEEE Xplore Metadata Search API** 检索服务，
交付一个 **Windows x64 单文件 `ieee-mcp.exe`**：目标机器无需安装 Node.js / npm，
不使用 `npx`，启动时不下载任何依赖。

目标是**按研究主题批量取回候选论文的完整元数据材料**（标题、作者、年份、刊物、
摘要、关键词、DOI、article_number、abstract_url、PDF 链接等），
再由调用 MCP 的助手根据标题/摘要/条件做语义相关性筛选。

---

## ⚠️ 检索范围声明（请先读）

IEEE Xplore Metadata Search API 的 `querytext` / `meta_data` 官方定义是
*"a free-text search of all **configured metadata fields and abstract text**"*。

因此本服务：

- ✅ 检索**元数据字段与摘要文本**，支持 `AND` / `OR` / `NOT` 与通配符；
- ❌ **不是正文全文检索**，无法在论文正文里做关键词匹配；
- ❌ **不下载 PDF、不获取全文**，也不使用校园网/机构订阅权限；
- ✅ 只返回 IEEE 元数据里真实存在的字段；缺失字段一律为 `null` 并列入 `missing_fields`，
  绝不编造或补全。

语义相关性判断由调用方（助手）完成，本服务**不内置任何 LLM**。

---

## 交付物

| 内容 | 位置 |
|---|---|
| 源码（TypeScript） | `src/` |
| 可复现构建脚本 | `scripts/`（`node scripts/build.mjs`） |
| Windows x64 单文件可执行程序 | `dist/ieee-mcp.exe` |
| 校验和 | `dist/SHA256SUMS.txt`（`sha256sum` 格式） |
| 构建环境与产物清单 | `dist/BUILD-INFO.json` |
| 自动化测试（277 项） | `test/`（`node test/run-all.mjs`） |
| 测试报告 | `docs/测试报告.md` |
| IEEE 官方参数核对 | `docs/IEEE-API-参数核对.md` |
| 上游源码审计 | `docs/上游源码审计.md` |
| 许可证 | `LICENSE`（MIT，保留原作者版权） |

校验 EXE：

```powershell
Get-FileHash .\dist\ieee-mcp.exe -Algorithm SHA256
Get-Content .\dist\SHA256SUMS.txt
```

当前产物：

| 文件 | 字节 | SHA-256 |
|---|---|---|
| `dist/ieee-mcp.exe` | 90,894,848 | `9b7f48368cc30602f4669b341fd9a436001c95f64b559b18881beeb65ce32d3d` |
| `build/bundle.cjs` | 832,503 | `1ff1b05a9fa3b3ca0d2817e4187e7214f717e73b3cb52c6d2a6ed7504aac29b4` |
| `build/ieee-mcp.blob` | 832,544 | `4ebef8e557376e73d3b574a1de841ab700f05216967e81aaa41ac0f40f52e872` |

构建是**字节级可复现**的（详见下文"可复现构建"），因此这些校验和可用于验证源码与二进制的对应关系。

> `dist/ieee-mcp.exe` 体积约 87 MiB，因为它**内含 Node.js 运行时**。它已加入
> `.gitignore`（避免把 87 MiB 二进制写进 Git 历史）；仓库中保留可复现构建脚本与校验和，
> 随时可用一条命令重建出**字节相同**的产物。

---

## 快速开始

### 1. 取得 EXE

把 `dist/ieee-mcp.exe` 放到任意目录（路径可含中文与空格），例如
`D:\工具\IEEE MCP\ieee-mcp.exe`。

诊断（不进入 MCP 模式，结果打印在 **stderr**，stdout 保持干净）：

```powershell
.\dist\ieee-mcp.exe --self-test
.\dist\ieee-mcp.exe --version
.\dist\ieee-mcp.exe --help
```

### 2. 提供 API Key

密钥只从环境变量读取，**不硬编码、不写入磁盘、不打包进 EXE**：

- 方式 A（推荐）：客户端配置的 `env` 段设置 `IEEE_API_KEY`；
- 方式 B：设置 `IEEE_API_KEY_FILE` 指向只含密钥的 UTF-8 文件（首行，`#` 开头为注释）。

> 日志与错误响应中密钥会被替换为 `[REDACTED]`；`ieee_status` 只暴露
> `sha256(key)` 前 12 位十六进制指纹，可核对"是否换了 key"，但无法反推密钥。

### 3. MCP 客户端配置

#### 通用 stdio 客户端（Claude Code / Claude Desktop / Cursor / …）

```json
{
  "mcpServers": {
    "ieee": {
      "command": "D:/工具/IEEE MCP/ieee-mcp.exe",
      "args": [],
      "env": {
        "IEEE_API_KEY": "<你的 IEEE Metadata Search API Key>",
        "IEEE_MCP_STATE_DIR": "D:/工具/IEEE MCP/state",
        "IEEE_OUTPUT_DIR": "D:/检索结果",
        "IEEE_LOG_LEVEL": "info"
      }
    }
  }
}
```

#### 用文件保存密钥（避免密钥出现在客户端配置里）

```json
{
  "mcpServers": {
    "ieee": {
      "command": "D:/工具/IEEE MCP/ieee-mcp.exe",
      "env": {
        "IEEE_API_KEY_FILE": "D:/工具/IEEE MCP/ieee-key.local",
        "IEEE_OUTPUT_DIR": "D:/检索结果"
      }
    }
  }
}
```

配置要点：

- `command` 必须是 **EXE 的绝对路径**；Windows 下 JSON 里建议用 `/`，或写成 `\\`；
- 路径含空格或中文**无需额外转义**（客户端直接传 argv，不经过 shell）；
- **不要**在 `command` 里写 `node` / `npm` / `npx`，也不需要 `args`；
- 修改客户端配置后需重启该客户端。

#### 需要代理时

IEEE 接口在国内常需代理。EXE 内置的 Node 运行时支持从环境变量读取代理，
在客户端 `env` 中追加即可（`NODE_USE_ENV_PROXY=1` 是 Node 24 开启代理支持所需的开关）：

```json
"env": {
  "IEEE_API_KEY": "<key>",
  "NODE_USE_ENV_PROXY": "1",
  "HTTPS_PROXY": "http://127.0.0.1:7890",
  "NO_PROXY": "localhost,127.0.0.1"
}
```

验证连通性（不需要真实 key，返回 `HTTP 403 Developer Inactive` 即说明网络可达）：

```powershell
.\dist\ieee-mcp.exe --self-test
curl.exe --proxy http://127.0.0.1:7890 "https://ieeexploreapi.ieee.org/api/v1/search/articles?querytext=radar&apikey=x"
```

> 注意：IEEE 对**无效/未激活**的 key 返回的是 **HTTP 403 `Developer Inactive`**（而不是 401）。
> 本服务遇到 403 会明确指出这一点，并且**不会重试**。

---

## 工具清单

| 工具 | 用途 |
|---|---|
| `search_papers` | 主检索：单查询或多查询合并，支持全部过滤与分页参数 |
| `search_by_author` | 按作者检索（`search_papers` 的便捷封装） |
| `search_by_publication` | 在指定期刊/会议内检索 |
| `get_paper_details` | 按 DOI 或 article_number 取单篇完整元数据 |
| `get_paper_citations` | 取单篇的引用论文数 / 引用专利数 |
| `export_results` | 导出 UTF-8 CSV / JSON / BibTeX |
| `ieee_status` | 生效配置、本地调用计数、缓存统计、IEEE 返回的限流响应头 |

> `get_full_text` 已被**移除**：上游请求的 `/api/v1/search/document/{articleNumber}`
> 在官方文档中并不存在，且把校园网权限误当作 API token。详见 `docs/上游源码审计.md`。

### `search_papers` 主要参数

```jsonc
{
  // —— 检索条件（元数据 + 摘要，非正文）——
  "querytext": "radar AND beamforming",     // 支持 AND/OR/NOT 与 *（通配符前至少 3 字符）
  "queries": ["mmwave beamforming", "毫米波 波束成形"],  // 多变体，逐条请求后合并去重
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
  "sort_field": "publication_title",        // article_number|article_title|publication_title
  "sort_order": "desc",
  "max_records": 25,                        // 单次请求条数，IEEE 默认 25，上限 200
  "start_record": 1,                        // 从 1 开始
  "auto_paginate": false,                   // true = 自动翻页直到触达下面的上限
  "max_total_records": 200,                 // 本次调用最多返回多少条唯一记录
  "max_requests": 5,                        // 本次调用最多花多少次 HTTP 请求（含重试）
  "no_cache": false,                        // 跳过缓存读取（新结果仍会写回缓存）

  // —— 输出 ——
  "output_format": "json"                   // json(默认) | markdown | csv | bibtex
}
```

---

## 返回值结构

默认 `output_format: "json"`，`content[0].text` 为完整 JSON，同时填入 MCP
`structuredContent`（新版客户端可直接取结构化数据）：

```jsonc
{
  "search_id": "srch_m1a2b3c4d5",          // 传给 export_results
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

单条 `PaperRecord`（缺失字段必为 `null`）：

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
`keywords`、`doi`、`article_number`、`abstract_url`。`pdf_url` 官方即为可选，缺失不计入。

---

## 分页与去重

### 已修复的分页边界错误

上游 `formatSearchResults` 用 `startRecord + articles.length < total` 判断是否还有下一页。
当 `total_records = 26`、首批返回 25 条时：`1 + 25 < 26` 为**假**，于是不提示下一页，
调用方会以为结果只有 25 条。

现在改为以**最后一条记录的绝对序号**比较：

```
last_returned_index = start_record + returned - 1
has_more            = last_returned_index < total_records
next_start_record   = last_returned_index + 1
```

`total = 26`、`start_record = 1`、返回 25 条 → `has_more = true`、`next_start_record = 26`。
同时 `warnings` 中给出 `start_record=26` 的提示；IEEE 返回不足一页时立即判定无更多结果。

### 有上限的分页

`auto_paginate: true` 时按 `max_records` 连续翻页，遇到以下任一条件即停止，
并把原因写入 `pagination.stop_reason`：

1. 达到 `max_total_records`；
2. 达到 `max_requests`（含重试在内的 HTTP 请求次数上限）；
3. IEEE 报告的 `total_records` 已取完，或返回条数不足一页；
4. 整页没有带来任何**新的唯一记录**（防止排序不稳定导致死循环）。

### 多查询合并

`queries: [...]` 中每个变体各自发起请求（受 `max_requests` 约束），随后合并去重。
`pagination.mode` 变为 `"merged"`，`total_records` 置为 `null`（并集无意义），
每个查询各自的命中数与翻页状态在 `per_query` 中给出。

### 去重与字段互补

按下列键任意命中即视为同一篇（优先级从高到低）：

1. 规范化 DOI（小写、去掉 `https://doi.org/` 前缀、去空白）；
2. `article_number`（去首部多余 0）；
3. 规范化标题 + 年份（用于前两者都缺失的记录，`NFKC` + 去标点）。

重复项**不是简单丢弃**：保留记录的 `null` 字段会从重复项回填（含 `keywords` 并集、
`authors`、引用数），从而得到尽可能完整的记录；回填后重新计算 `missing_fields`。

---

## 限速、本地计数、缓存与重试

### 限速与跨进程计数

- 每次 HTTP **尝试**（含每次重试）在发出前先**预占一个额度**；因此重试计入预算。
- 账本是 JSON 文件 + `mkdir` 原子锁，**多进程共享**：两个 MCP 客户端同时运行也不会
  重复消耗同一个额度，也不会各自突破每秒上限。
- `IEEE_MAX_RPS` 默认 **8**（官方上限 10），按窗口内最近请求时间戳做全局节流。

### 每日预算（本地）

`IEEE_DAILY_BUDGET` 默认 **200**。同时维护三个窗口，`IEEE_BUDGET_WINDOW` 决定按哪些窗口拦截：

| 值 | 含义 |
|---|---|
| `both`（默认） | UTC 日与滚动 24h **都**不超过预算 |
| `utc-day` | 按 UTC 日 |
| `local-day` | 按本机时区日 |
| `rolling-24h` | 任意滚动 24 小时窗口 |

> **本计数是本服务的本地记账，不是 IEEE 官方剩余额度。**
> IEEE 未公布其 Rate Limits 的重置时区，因此本服务**不假设**任何重置时刻，
> 而是同时记录/展示多个窗口，并把该声明写进每次返回的 `usage.note`
> 与 `ieee_status.local_usage.disclaimer`。

### 缓存

- 键为 `哈希(端点 + 全部有效参数)`，存于 `IEEE_MCP_STATE_DIR/cache/`；
- 默认 TTL `86400s`（`IEEE_CACHE_TTL_SECONDS=0` 关闭），条目上限
  `IEEE_CACHE_MAX_ENTRIES=500`，单条上限 2 MB；
- 过期条目读取时删除，写入时按 mtime 淘汰超限旧条目；
- 命中缓存**不消耗**额度与请求；`no_cache: true` 只跳过读取、仍会写回；
- 同一进程内**并发的相同请求会自动合并**（coalesce），不会重复计费。

### 超时与重试

| 情况 | 行为 |
|---|---|
| 网络错误 / 超时 | 重试（指数退避 + 抖动，上限 15s） |
| `429` | 重试，优先遵循 `Retry-After` |
| `408 / 425 / 5xx` | 重试 |
| `400` | **不重试**，返回 `BAD_REQUEST` |
| `401` | **不重试**，返回 `AUTH_ERROR`（提示检查 `IEEE_API_KEY`） |
| `403` | **不重试**，返回 `FORBIDDEN` |
| `404` | **不重试**，返回 `NOT_FOUND` |

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

## 导出

`export_results` 支持 `csv` / `json` / `bibtex`：

- **CSV**：UTF-8 **带 BOM**（Excel 打开不乱码）、CRLF、RFC 4180 引号转义；
  列含 `source` / `retrieved_at` / `query_id` / `missing_fields` 等溯源列；
- **JSON**：`{ meta: {...}, records: [...] }`；
- **BibTeX**：`%` 注释头写出来源、`search_id`、检索条件、检索时间；条目类型按
  `content_type` 映射（Conferences→`@inproceedings`，Journals→`@article`，
  Books→`@book`，其它→`@misc`）；citation key 为 `首作者姓+年份+article_number` 并自动去重；
  保留 UTF-8（中文/重音字符不转义，建议使用 UTF-8 感知的 BibTeX/biblatex）。

**每种格式都会额外写一个 `<文件名>.meta.json` 溯源文件**：

```jsonc
{
  "searchId": "srch_...", "source": "IEEE Xplore",
  "endpoint": "https://ieeexploreapi.ieee.org/api/v1/search/articles",
  "retrievedAt": "...", "query": { /* 完整检索条件 */ },
  "totalRecords": 26, "searchScope": "metadata_and_abstract",
  "server": "ieee-mcp 2.0.0", "exported_at": "...", "exported_records": 25,
  "output_file": "..."
}
```

用法：先检索拿到 `search_id`，再

```jsonc
{ "search_id": "srch_m1a2b3c4d5", "format": "csv", "output_path": "结果/论文列表.csv" }
```

相对路径以 `IEEE_OUTPUT_DIR`（默认进程工作目录）为基准；目录不存在会自动创建；
省略扩展名时按格式补 `.csv` / `.json` / `.bib`。

---

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `IEEE_API_KEY` | — | **必填**（或用 `IEEE_API_KEY_FILE`） |
| `IEEE_API_KEY_FILE` | — | 从 UTF-8 文件读取密钥（首行，`#` 注释） |
| `IEEE_MCP_STATE_DIR` | `%LOCALAPPDATA%\ieee-mcp` | 账本/缓存/结果集目录；不可写时依次回退到 `%APPDATA%`、`~/.ieee-mcp`、EXE 同级 `.ieee-mcp`、临时目录 |
| `IEEE_OUTPUT_DIR` | 进程工作目录 | 导出相对路径的基准 |
| `IEEE_MAX_RPS` | `8` | 每秒请求上限，1–10 |
| `IEEE_DAILY_BUDGET` | `200` | 本地每日预算 |
| `IEEE_BUDGET_WINDOW` | `both` | `both`/`utc-day`/`local-day`/`rolling-24h` |
| `IEEE_MAX_RETRIES` | `2` | 重试次数，0–5 |
| `IEEE_TIMEOUT_MS` | `20000` | 单次请求超时（ms），1000–120000 |
| `IEEE_CACHE_TTL_SECONDS` | `86400` | 缓存 TTL，`0` 关闭 |
| `IEEE_CACHE_MAX_ENTRIES` | `500` | 缓存条目上限 |
| `IEEE_CACHE_MAX_ENTRY_BYTES` | `2000000` | 单条缓存上限 |
| `IEEE_RESULT_TTL_SECONDS` | `21600` | 结果集（`search_id`）保留时间 |
| `IEEE_SHUTDOWN_GRACE_MS` | `120000` | stdin 关闭后等待在途请求的上限 |
| `IEEE_LOG_LEVEL` | `info` | `silent`/`error`/`warn`/`info`/`debug`（全部写 stderr） |
| `IEEE_USER_AGENT` | `ieee-mcp/2.0.0 (MCP stdio server)` | 请求 UA |
| `IEEE_API_BASE` | 官方端点 | **仅供离线测试**指向 mock 服务；覆盖时会在 stderr 告警 |

---

## 安全

1. **密钥来源单一**：只读 `IEEE_API_KEY` / `IEEE_API_KEY_FILE`，不落盘、不进 Git、不打包进 EXE。
2. **全链路脱敏**：`redact()` 覆盖
   ① 注册的密钥字面量；② `apikey=...` 查询串；③ JSON/XML 形式的 `apikey`；
   ④ `Bearer` token。日志、错误响应、工具返回全部经过该函数。
3. **指纹而非密钥**：`ieee_status` 只返回 `sha256(key)[0:12]`。
4. **stdout 纯净**：stdout 只承载 MCP JSON-RPC；日志、`--version`/`--self-test`/`--help`
   全部输出到 stderr；`console.*` 被重定向到 stderr。
5. **失败关闭**：未配置密钥时进程**照常启动**（`initialize`/`tools/list` 可用），
   检索类工具返回结构化 `CONFIG_ERROR`，不会静默发出请求。
6. 本仓库不含任何真实密钥；`.gitignore` 已排除 `.env`、`*.key`、`ieee-key.local` 等。

---

## 可复现构建

前置：Node.js ≥ 20（**仅开发机需要，运行机不需要**）。

```powershell
cd IEEE_search_MCP
npm install                     # 若 npm 缓存目录不可写：npm install --cache .\.npm-cache
node scripts/build.mjs          # 清理 → 类型检查 → esbuild 打包 → SEA → 注入 → 校验和
```

分步命令：

```powershell
node scripts/bundle.mjs         # tsc --noEmit + esbuild → build/bundle.cjs
node scripts/build-sea.mjs      # SEA blob → 复制 node.exe → 去签名 → postject 注入 → 自检
node scripts/checksums.mjs      # dist/SHA256SUMS.txt + dist/BUILD-INFO.json
```

构建流程与取舍：

1. **打包**：esbuild 把 TypeScript 与 `@modelcontextprotocol/sdk`、`zod` 打成单个 CommonJS
   文件（约 810 KB），运行期不需要 `node_modules`。
2. **单文件**：Node 24 的 SEA（`--experimental-sea-config`）生成 blob，`postject` 注入一份
   `node.exe` 副本。产物 = Node 运行时 + bundle。
3. **去签名**：注入前移除 `node.exe` 的 Authenticode 证书表（PE 目录项 4），否则被改写过的
   签名镜像在部分 Windows 策略下会被拒绝加载。该步骤是纯 JS 实现的 PE 解析，
   **不依赖 Windows SDK 的 `signtool`**。
4. **离线**：`npm install` 之后整个构建过程不需要网络。

### 可复现性

**默认构建是字节级可复现的**：连续两次 `node scripts/build.mjs` 会产生完全相同的
SHA-256（`bundle.cjs`、`ieee-mcp.blob`、`ieee-mcp.exe` 三者一致），因此
`dist/SHA256SUMS.txt` 可以被用来验证"这份源码确实能构建出这份二进制"。

字节级可复现的原因是 SEA 配置中 **关闭了 V8 code cache**（`useCodeCache: false`）。
开启它会嵌入一段非确定性的 V8 代码缓存；实测两者冷启动耗时相同（约 73 ms，5 次平均），
所以默认关闭，不牺牲性能。如需尝试：

```powershell
$env:IEEE_BUILD_CODE_CACHE="1"; node scripts/build.mjs   # 开启 code cache，构建不再字节可复现
```

> 构建脚本用 `node scripts/build.mjs` 直接运行而非 `npm run`，是为了在受限环境
> （例如禁止子进程管道的沙箱）下也能构建：esbuild 走 CLI（stdio 直通），
> postject 走进程内 JS API，自检走文件描述符重定向。

---

## 测试

```powershell
node test/run-all.mjs                       # 默认测 dist/ieee-mcp.exe（277 项）
node test/run-all.mjs search export         # 只跑指定套件
$env:IEEE_TEST_TARGET="bundle"; node test/run-all.mjs   # 测未打包 bundle，迭代更快
```

测试**默认全部使用内置 mock 服务**（`test/mock-ieee-server.mjs`，响应形状对齐官方
"Data Fields Returned"），**不消耗任何真实 API 额度**。覆盖：

| 套件 | 项数 | 覆盖内容 |
|---|---|---|
| `protocol` | 30 | `initialize`、`tools/list`、stdout 纯净性、stdout/stderr 分离、无密钥降级、`get_full_text` 已移除、未知工具错误 |
| `cli` | 26 | `--version`/`--help`/`--self-test`、stdout 保持为空、指纹格式、stdin 立即 EOF、状态目录不可用仍可启动 |
| `search` | 103 | **分页边界 26/25**、翻页不重叠、字段完整性与 `missing_fields`、缓存命中/过期/持久化/关闭、并发合并、多查询合并去重、`auto_paginate` 上限、`max_requests`、参数大小写与 `%20` 编码、`doi`/`article_number` 排他性、非法输入拒绝、便捷工具、`ieee_status` 清理与重置 |
| `resilience` | 60 | 401/403/400/404 不重试、429 `Retry-After`、5xx 重试与耗尽、超时、**重试计入预算**、本地预算拦截、**跨进程账本**、**跨进程限速**、密钥全链路脱敏 |
| `export` | 58 | CSV BOM/行数/中文/溯源列、JSON meta、BibTeX 条目与注释头、sidecar 溯源、**含中文与空格的路径**、显式 records 导出、DOI/article_number 查询、`ieee_status` |

真实 API 验证见 `docs/测试报告.md`（共 28 次调用：12 次诊断探测 + 6 次检索冒烟 + 10 次分页/合并验证）。

---

## 已知限制

1. **只有元数据检索**，没有正文/PDF 获取（本次明确不实现；官方全文端点与 API key 权限模型不同）。
2. **不支持 facet 参数**（`facet`/`d-au`/`d-publisher`/`d-pubtype`/`d-year`）：
   官方定义它们返回"细化链接"而非结果集。
3. **深层分页依赖 IEEE 行为**：官方在 `start_record` 下注有 "maximum results is 200"；
   本服务默认 `max_total_records = 200`，上限 1000。IEEE 不保证深翻页稳定性，故在
   "整页无新增唯一记录"时会主动停止并在 `stop_reason` 说明。
4. **本地计数 ≠ 官方额度**：IEEE 未公布重置时区，本地账本仅作自我保护；与 IEEE 控制台不一致时
   以 IEEE 为准。可删除 `state_dir/usage-ledger.json`，或调用
   `ieee_status({reset_local_usage:true})` 重置本地记账。
5. **IEEE 不返回限流响应头**：实测正常响应中既无 `X-RateLimit-*` 也无 `Retry-After`，
   因此本地计数**无法**与官方剩余额度对账（`ieee_status.last_ieee_rate_limit_headers`
   在 IEEE 开始返回时会自动显示）。
6. **缓存/结果集是本地副本**：受 IEEE ToU 约束，均设条目与时间上限，不做无限镜像。
7. **产物自身未做代码签名**（无代码签名证书），Windows SmartScreen 首次运行可能提示
   "未知发布者"；请用 `dist/SHA256SUMS.txt` 校验完整性。
8. **`publication_year` 格式不统一**：官方说明其格式随出版物而异，本服务原样透传字符串。
9. **BibTeX 为 UTF-8 原文**，仅转义 `{`/`}`/`\`；老式 BibTeX 引擎可能需要 biblatex 或 UTF-8 支持。
10. **EXE 体积约 87 MiB**：单文件自包含 Node 运行时的代价。
11. **仅验证 Windows x64**：构建脚本按 Windows PE / SEA 流程编写，其他平台未验证。
12. **字节级可复现依赖构建环境**：同一 Node 大版本下已验证两次构建 SHA-256 相同；
    换用不同 Node 版本时 blob 必然不同（Node 运行时本身不同），此时请以新的
    `dist/SHA256SUMS.txt` 为准。

### 真实接口行为提示（已实测）

- **`article_number` / `doi` 必须单独发送**。只要附带 `max_records`，IEEE 会返回
  `total_records: 1` 却**完全省略 `articles` 数组**（HTTP 200，无任何错误提示）。
  本服务因此对标识符查询只发送标识符本身；上游实现恰好是 `{max_records:1, doi|article_number}`，
  所以它的 `get_paper_details` / `get_paper_citations` 在真实接口上一直是静默失效的。
- **无效/未激活的 key 得到的是 HTTP 403**（`Developer Inactive`），不是 401；
  本服务在错误提示中已明确指出这一点，且不对 403 重试。
- 少数历史文献可由检索命中、但用 `article_number` 取不到记录体；此时返回空结果并给出说明，
  不会编造数据。

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

---

## 许可证与来源

- 本仓库保留原项目 **MIT License** 与原作者版权声明（见 `LICENSE`）。
- 上游：`https://github.com/danieltyukov/ieee-mcp` @ `8dcc6b0b6abbb2425b9be28392dc27b5ce17b131`。
- 本仓库第一个提交即上游 `master` 原样状态，其后提交为本次完善内容，可直接
  `git log` / `git diff` 审阅。
