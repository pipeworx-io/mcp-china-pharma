# @pipeworx/china-pharma

Biotech and pharmaceutical licensing deals and drug approvals involving China, read out of SEC
8-K and HKEX disclosure announcements. Keyless.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1573+ live data sources.

## Tools

- `china_licensing_deals(query?, since?, until?, limit?)` — deals where a Chinese company
  out-licensed an asset to a Western partner, or a Western company licensed rights into Greater
  China. Returns both companies, the territory clause, upfront and milestone amounts, royalty
  language, and the filing it was announced in.
- `nmpa_updates(section?, limit?)` — official NMPA announcements in English: policy, guidance,
  import rules, clinical-trial guideline updates. Sections: news, drugs, devices, cosmetics.
  **NOT the approvals register** — see below.
- `nmpa_drug_approvals(month? | since?/until?, query?, limit?)` — specific drugs approved,
  conditionally approved, or given an expanded indication by NMPA, read out of HKEX (Hong Kong
  Exchange) disclosure filings. Returns the filing headline, company, approval date, a best-effort
  category, and the filing PDF.
- `nmpa_drug_approval(id? | name?)` — one approval record by the `id` from
  `nmpa_drug_approvals`, or by drug/company name search.
- `csrc_penalties(since?, page?, limit?)` — administrative penalty decisions (行政处罚决定书)
  from the CSRC, China's securities regulator, newest first from csrc.gov.cn's own JSON feed.
  Each row carries the decision number, publication date, the first named party, a memo excerpt
  with the remaining parties, and the link to the full decision. Securities enforcement —
  disclosure fraud, insider trading, audit failures — not drug regulation.

## What `nmpa_updates` is not, and where the approvals actually come from

`nmpa_updates` is **not** the drug-approval register, and neither — contrary to what it looks
like on a first read — is `english.nmpa.gov.cn/drugs.html`. Probing it live (2026-09-07) rather
than trusting the page name: every section (`drugs`, `news`, `policies`,
`regulatoryinformation`) is a paginated feed of administrative-policy notices ("Announcement on
Strengthening Supervision of Contract Manufacturing", "Policy Interpretation of..."), the newest
item under `drugs` is dated 2026-04-14 — five months stale against a September run — and not one
entry across any section names a specific drug as approved. The Chinese-language NMPA site (all
paths, not just `/datasearch/`, confirmed domain-wide this run) and CDE both still answer HTTP
412/202 with a 瑞数/Riverdata JS-obfuscation challenge to a plain non-Cloudflare client — the
2026-08-11 finding holds. Reading either needs a headless browser, which a stateless pack cannot
be.

What actually carries approval events, keyless and current: any HKEX-listed Chinese biotech is
required to disclose an NMPA approval as a same-day regulatory filing, and HKEXnews' public
title-search JSON endpoint (`titleSearchServlet.do`) serves those without a key — the same trick
`china_licensing_deals` already uses one exchange over (SEC 8-Ks instead of HKEX filings): the
curated register isn't public, but the disclosure layer is. `nmpa_drug_approvals` and
`nmpa_drug_approval` are built on that.

### Traps

- **`titleSearchServlet.do` ignores `from`/`to` when `searchType=1` and `title` is set.** Verified
  by requesting three different multi-month windows (Jan–Sep 2026, July 2026 only, a single day)
  and getting back the identical rolling set of the ~17 most-recent NMPA-titled filings every
  time. This pack fetches that one unbounded window and does its own date filtering
  client-side — `since`/`until`/`month` outside the reachable window return `found: false` with a
  `hint` explaining why, not a silently-empty "no approvals that month".
- **Not every headline containing "approved" is a marketing approval.** IND/clinical-trial
  clearances ("APPLICATION FOR CLINICAL TRIAL ... APPROVED BY NMPA"), application acceptances, and
  breakthrough-therapy designations all use approval-adjacent language. `classifyApproval()`
  excludes them by keyword (`IND`, `clinical trial`, `accept(ed|ance)`, `designation`,
  `clearance`, `submitted`) before accepting a title as a marketing approval.
- **`name_cn` is deliberately `null`.** HKEXnews' English title search returns English-language
  headlines only; the paired Chinese-language disclosure is a different `NEWS_ID` and isn't
  reliably matchable without another lookup, and the PDFs aren't parsed. Left explicit rather than
  guessed.
- **Coverage is HKEX-listed companies only.** A China A-share-only company, or a Chinese biotech
  not separately listed in Hong Kong, will not appear even if NMPA approved its drug — stated in
  the response's `scope_note`.

## Auth

None. SEC asks for a contactable `User-Agent` and 403s a generic one; the pack sends one.

## Why SEC full-text and not a deal database

Deal databases (Citeline, Evaluate, Cortellis, DealForma) are all subscription products. But any
US-listed party to a licensing deal announces it in an 8-K, and the press-release exhibit contains
the counterparty, the territory and the money — so the announcement layer is public even though the
curated database is not.

**The scoping is the whole trick.** `"license agreement" AND "China"` returns Yum China and YUM
Brands ahead of any biotech, because fast-food franchising uses the same words. Requiring deal
vocabulary instead — `"upfront payment"` AND `"milestone"` AND `"China"` — returned 24 filings over
three months, every one of them a pharma company. The domain filter is the DEAL language, not the
word "pharma".

## Known limits, stated because they change what the answer means

- **Only deals with an SEC-filing party.** A purely China-to-Japan or China-to-EU deal between two
  companies with no US listing is never announced here and will be missing. The response says so in
  `coverage_note`.
- **Deal terms are extracted from prose, not from a structured field.** Amounts appear only when the
  release states them; a release saying "an undisclosed upfront" yields no number, and the field is
  omitted rather than guessed. A figure without a scale word (a bare `$1`) is deliberately rejected —
  no licensing deal is denominated in single dollars, and reporting one would be a wrong number.
- **Bodies are opened for the first 8 filings per call.** Beyond that the deal is listed with its
  filing URL and a note; narrow the window or use `query` to bring it into range.

## CSRC penalties: what the feed does and does not carry

`csrc_penalties` reads the searchList JSON endpoint behind
`csrc.gov.cn/csrc/c101928/common_list.shtml` (channel `28de6b87eda140cb93de4dd10d11867d`,
行政处罚). Unlike NMPA's Chinese site, this endpoint carries **no JS-challenge WAF** — a plain
request with a `Referer` header answers 200 (verified 2026-09-07). Every decision is titled with
the regulator's fixed boilerplate, so the useful fields are parsed from `memo`: the decision
number (`〔2026〕42号`) and the 当事人 (named parties) block. The linked `content.shtml` pages are
HTML prose and are deliberately **not** fetched — the tool is a dated feed with links, not a
parsed penalty database. `_rangeTimeGte` filters server-side but is loose at the day boundary
(a `since=2026-08-01` request came back with a 2026-07-31 row), so `since` is re-applied
client-side to the returned rows.

## Data sources

- `china_licensing_deals`: `https://efts.sec.gov/LATEST/search-index` (EDGAR full-text search,
  8-K forms) and the filing bodies under `https://www.sec.gov/Archives/edgar/data/`.
- `nmpa_updates`: `https://english.nmpa.gov.cn/` (news, drugs, medicaldevices, cosmetics
  sections).
- `nmpa_drug_approvals` / `nmpa_drug_approval`: `https://www1.hkexnews.hk/search/titleSearchServlet.do`
  (HKEXnews public title search) and the linked filing PDFs under `https://www1.hkexnews.hk/`.
- `csrc_penalties`: `https://www.csrc.gov.cn/searchList/28de6b87eda140cb93de4dd10d11867d`
  (the 行政处罚 channel's JSON list endpoint).

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "china-pharma": {
      "url": "https://gateway.pipeworx.io/china-pharma/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/china-pharma/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1573+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "china-pharma": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-china-pharma"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-china-pharma
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about China Pharma data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
