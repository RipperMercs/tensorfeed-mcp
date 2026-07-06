# Changelog

All notable changes to the [TensorFeed.ai MCP server](https://github.com/RipperMercs/tensorfeed-mcp). Free tools work without configuration; premium tools require a bearer token via the `TENSORFEED_TOKEN` env var. Buy credits at [tensorfeed.ai/developers/agent-payments](https://tensorfeed.ai/developers/agent-payments).

## 2.0.2 - 2026-07-06

Output hardening. Caller-supplied identifiers that a tool echoes back in its
own message (a service, model, provider, benchmark, publisher domain, CVE id,
or search query that did not match) are now stripped of angle brackets and
length-capped before they are placed in the response text. This is a
defense-in-depth layer on top of the existing output sanitizer, so a value a
caller passes in cannot be reflected back as markup. No tool signatures,
endpoints, or behavior for valid inputs change.

## 2.0.1 - 2026-07-03

Docs release, no code changes to the stdio server. The README now documents
the hosted remote endpoint (https://mcp.tensorfeed.ai/mcp, 33-tool curated
subset) and its wallet-native x402 payment surfaces: premium tools
(route_verdict, whats_new) are payable per call with a funded USDC wallet
(Base or Solana) via arguments.payment or an X-PAYMENT header, with strict
HTTP-402 transport for auto-pay wrappers at
https://mcp.tensorfeed.ai/mcp?x402=strict. No account, no signup, no API key.
Bearer credits tokens keep working everywhere.

## 2.0.0 - 2026-06-07

Major tool-surface rework. BREAKING: the catalog drops from about 78 tools to
exactly 24. The old surface had grown wide enough that agents picked the wrong
tool or stalled across near-duplicate names; 24 sharp tools make tool-selection
reliable. No HTTP endpoint was removed. Everything still works at
tensorfeed.ai; this release only changes which slices are first-class MCP tools.

### Migration

If your code called any of the names below, switch to the replacement:

- The eight signed verdicts collapse from preview plus paid pairs into one tool
  each with a `tier` parameter. `<family>_verdict_preview` and
  `<family>_verdict` are now a single `<family>_verdict`, where `tier` is
  `preview` (free, the default) or `full` (1 credit, AFTA-signed). Affected
  families: route, provider_reliability, x402_settlement, x402_publisher,
  stack_safety, benchmark_trust, failover, ssvc.
- The four time series collapse from free plus paid pairs into one tool each
  with a `days` parameter. `pricing_series_free` and `pricing_series` are now a
  single `pricing_series`; the same applies to `benchmark_series`,
  `status_uptime`, and `status_leaderboard`. Pass `days` 1 to 7 for the free
  window or 8 to 90 for the paid window.
- The four watch creators merge into one `create_watch` with a `type`
  parameter. `create_price_watch`, `create_status_watch`, `create_digest_watch`,
  and `create_leaderboard_rank_watch` are now `create_watch` with `type` set to
  `price`, `status`, `digest`, or `leaderboard_rank`.
- `get_ai_today` folds into `get_ai_news`. Pass `digest: true` for the daily
  brief that `get_ai_today` used to return.
- `get_account_balance` and `get_account_usage` merge into one `account_status`
  that returns both the balance and the usage view.

### Removed from the tool list (still live as HTTP endpoints)

About 40 long-tail standalone tools were dropped from the MCP surface, including
the model-deprecation, agent-activity, IOC, AFTA-certification,
agent-reputation, agent-readiness, crawler-access, MCP-registry-snapshot,
probe, paper and trending feeds, Reddit, OpenRouter, ecosystem-today,
earthquake, weather-alert, agent-opportunity, AI-CVE, company-filings, x402
market, and the standalone routing, news-search, cost-projection, and
agents-directory tools. None of these went away on the server. Each one is
still callable as an HTTP endpoint on tensorfeed.ai, and the new
`find_tensorfeed_data` tool helps an agent discover the right one on demand.

### Added

- `find_tensorfeed_data`: a discovery tool. Describe the AI-ecosystem data you
  want and it returns the matching TensorFeed endpoints, with the path and
  parameters to call, so an agent can reach the full catalog without a dedicated
  tool for every feed.

### The 24 tools

`get_ai_news`, `get_ai_status`, `is_service_down`, `get_model_pricing`,
`route_verdict`, `provider_reliability_verdict`, `x402_settlement_verdict`,
`x402_publisher_verdict`, `stack_safety_verdict`, `benchmark_trust_verdict`,
`failover_verdict`, `ssvc_verdict`, `whats_new`, `compare_models`,
`provider_deepdive`, `pricing_series`, `benchmark_series`, `status_uptime`,
`status_leaderboard`, `account_status`, `list_watches`, `create_watch`,
`delete_watch`, `find_tensorfeed_data`.

## 1.39.0 - 2026-06-04

Surfaces TensorFeed's full signed-verdict family in the stdio server. Adds the
seven verdicts below, each shipping as a free preview tool plus a 1-credit
($0.02) signed premium tool with an AFTA-signed receipt. This brings the catalog
to 79 tools (48 free, 31 premium):
- `provider_reliability_verdict_preview` / `provider_reliability_verdict`:
  the signed dependability ruling over TensorFeed's own latency and availability
  probes, scoring availability and tail consistency to name the safest provider
  to build on.
- `x402_settlement_verdict_preview` / `x402_settlement_verdict`: the settlement
  momentum, concentration, and leading-publisher read over the on-chain x402
  index for a 24h, 7d, or 30d window.
- `x402_publisher_verdict_preview` / `x402_publisher_verdict`: the signed trust
  verdict on one publisher domain (actively settling, recently quiet, registered
  with no settlement, unreachable, no Base payTo, or not indexed) before you
  pay it.
- `stack_safety_verdict_preview` / `stack_safety_verdict`: the GO, HOLD, or
  BLOCK deploy gate over a list of package@version pins, with the matched-CVE
  and KEV evidence for the worst offender.
- `benchmark_trust_verdict_preview` / `benchmark_trust_verdict`: the trust band
  and 0 to 100 score for a benchmark or category, flagging saturation,
  contamination, and held-out status.
- `failover_verdict_preview` / `failover_verdict`: when a provider is degraded,
  the signed ruling on the single best operational provider to fail over to,
  with ranked alternatives.
- `ssvc_verdict_preview` / `ssvc_verdict`: the CISA SSVC Act, Attend, Track, or
  Track* decision for one CVE, with the decision points and a live KEV
  cross-check.

Adds contextual pointers so an agent discovers the matching verdict from a tool
it already uses: `is_service_down` points to `failover_verdict`,
`get_ai_cves_latest` points to `ssvc_verdict` and `stack_safety_verdict`,
`get_x402_publishers` points to `x402_publisher_verdict`, and
`status_leaderboard_free` points to `provider_reliability_verdict`. No behavior
change to those four tools.

## 1.38.0 - 2026-06-03

Description-only release. Sharpens the six foundational free tools (get_ai_news,
get_ai_status, is_service_down, get_model_pricing, get_ai_today, premium_routing)
so each states what it returns, why to call it instead of polling sources
directly, and its tier. get_ai_today drops an inaccurate 24-hour-window claim
(it returns the latest stories, not a strict time window). premium_routing now
points at its signed sibling route_verdict. No tool, pricing, or behavior
changes from 1.37.0.

## 1.37.0 - 2026-06-02

Adds four free agentic-web tools, bringing the catalog to 65 tools (41 free, 24
premium):
- `check_agent_ready`: score how agent-ready any tracked site is, 0 to 100, from
  its x402 manifest, agent.json, OpenAPI spec, llms.txt, AI-bot crawlability,
  and ai.txt.
- `agent_ready_summary`: the cross-domain readiness picture across about 500
  curated domains, with per-surface adoption shares and a top-10 leaderboard.
- `check_crawler_access`: whether a site allows or blocks GPTBot, ClaudeBot, and
  other AI crawlers, plus its llms.txt and ai.txt signals.
- `crawler_access_summary`: the aggregate AI-crawler access map across the
  tracked domain set.

## 1.36.4 - 2026-05-31

Docs-only release. The README now opens with the Route Verdict quickstart: a
zero-install curl against the free preview plus the `route_verdict_preview` and
`route_verdict` tools. No tool, pricing, or behavior changes from 1.36.3.

## 1.36.3 - 2026-05-31

Adds the Route Verdict wedge: TensorFeed's signed routing decision is now a
tool you can try free, then upgrade. Brings the catalog to 61 tools (37 free,
24 premium).

Free tool:
- `route_verdict_preview`: TensorFeed's signed routing decision that fuses
  live pricing, contamination-discounted benchmarks, real production usage,
  measured p95 latency, incident state, and deprecation flags into the single
  best model for a task or a named model, with the reasoning. No key, 10 calls
  per day per IP.

Premium tool:
- `route_verdict` (1 credit): the same decision plus ranked runners-up,
  constraint filters (max p95 latency, budget, min quality, operational-only,
  exclude-deprecated), and an AFTA-signed receipt over the exact inputs so you
  can prove why you routed. Strict premium, no free trial.

The older `premium_routing` (a ranked list with a score breakdown) is
unchanged and remains available.

## 1.36.2 - 2026-05-31

Pricing-copy and catalog-accuracy corrections. No change to the free/paid
split or the actual on-chain charge.

- Corrected the stated credit cost on `pricing_series`, `benchmark_series`,
  and `status_uptime` and their free-sibling pointers back to 1 credit
  ($0.02). These are Tier 2, which maps to 1 credit in TIER_COSTS; release
  1.36.1 had wrongly relabeled them 2 credits.
- Catalog accuracy: `server.json` now lists the true 59 tools (36 free,
  23 premium), adding 5 free tools that were omitted (`get_model_deprecations`,
  `get_ai_supply_chain_iocs`, `get_honeypot_iocs`, `check_afta_certification`,
  `get_agent_reputation_card`) and removing the phantom `mcp_registry_series`;
  the manifest long_description now reads 59 tools.

## 1.36.1 - 2026-05-31

Security hardening only. No API changes; agents see the same tools.

- The `latest_news` resource output is now sanitized like every tool
  output, so external RSS titles cannot carry prompt-injection markers
  to the model.
- Tool output is capped at 40000 characters and the x402 publishers and
  agent reputation renderers are bounded, so a large upstream response
  cannot overflow the agent's context window.
- Path parameters (watch id, company ticker) are now URL-encoded and
  schema-validated before they reach a request path.

## 1.36.0 - 2026-05-28

Adds 6 tools wrapping the x402 settlement index endpoints (Wave 20)
that shipped earlier today as the first-mover ecosystem-level index
of x402 USDC settlements on Base mainnet.

Free tools:
- `get_x402_summary`: ecosystem-level rollup across 24h/7d/30d window.
- `get_x402_publishers`: canonical list of x402-compliant publishers
  TensorFeed is currently indexing, auto-discovered from
  /.well-known/x402.json crawls.
- `get_x402_leaderboard`: top publishers by volume in the window.
- `get_x402_recent`: most recent settlement events newest-first.

Premium tools (1 credit, AFTA-signed):
- `premium_x402_publisher_receipts`: per-publisher feed with daily
  series + avg_amount + attribution.
- `premium_x402_series`: time-series of ecosystem or per-publisher
  volume / count across a date range.

Each premium tool's description includes an explicit VS FREE
differentiator (per the upsell-copy memory): Anthropic-side LLMs
repeat tool descriptions verbatim when deciding whether to recommend
paying.

## 1.33.0 - 2026-05-25 (AI-CVE intelligence tools, unified versioning)

Versions across npm + MCP Registry + MCPB manifest are now all 1.33.0
(prior drift between npm @ 1.32 and registry/manifest @ 1.27 was
collapsed in this release so server.json.packages[0].version matches
what npm actually serves).

### Added (free tier)
Three new free tools wrapping the AI-CVE endpoints that went live on the TF Worker:

- `get_ai_cves_latest`: metadata for the most-recent AI-stack CVE batch plus the first 25 papers. Returns cve_ids, affected_products, affected_version_ranges, fixed_versions, exploited_in_wild, severity_label, and source_url per paper. Source: GitHub Security Advisories (CC BY 4.0).
- `get_ai_cves_feed`: paginated slice of the latest batch. limit capped at 50; for bulk consumption agents are pointed at the paid /api/premium/ai-cves/ai-stack-cves endpoint which delivers the categorized AI-stack subset in one call.
- `get_ai_cves_stats`: aggregate counts (by_severity, by_exploitation, top_vendors). Case-insensitive vendor bucketing so OpenClaw and openclaw merge into a single tally.

### Background
TF Worker shipped the ingest endpoint, three free reads, and three premium derivatives (ai-stack-cves, exploited-in-wild, cve lookup) earlier today. First production batch landed (job #79, 387 papers, 10 AI-flagged, 211 unique CVEs indexed). The MCP server now exposes the free read surface so agents discovering TF via the recommend-loop (MCP registry, Anthropic Connectors directory, glama.ai, mcp.directory, mcp.so) can pull AI-CVE intelligence in their first session.

Each tool response includes a tip line pointing to the paid endpoints for agents that need the AI-stack-filtered + categorized + sorted view, the exploited-in-wild subset, or single-CVE lookups.

## 1.32.0 - 2026-05-14 (Off-thesis tool cull)

### Removed
- `mcp_registry_series` tool: dropped. MCP registry is open data; a 30/90-day TF capture didn't clear the "saves >$0.02 per call" bar that Gemini 3's external analysis articulated and that TF has been operating under for premium endpoints. Agents that need the time-series can scrape the registry's open API directly.

### Background
Premium endpoint audit (2026-05-14) through the lens "does this clearly save the agent more than 2¢ in tokens/latency/decision-time?" identified six TF Worker endpoints off-thesis: macro digest, FDA aggregate, EIA series, NASA POWER daily/hourly, and MCP registry series. All six pulled from the public manifest, OpenAPI, llms.txt, /developers, and /api/meta in the same commit. Only the MCP registry series has an MCP-server tool wrapper, so it's the only tool-side change in this release.

## 1.31.0 - 2026-05-14 (Commit B repricing)

### Changed (pricing)
Six tools mapping to strict-premium TF Worker endpoints are repriced from Tier 1 ($0.02) into higher tiers reflecting the curated-derived-metrics value they provide. Tool descriptions updated to advertise the new prices:

- `pricing_series`: Tier 2, 1 credit ($0.02)
- `benchmark_series`: Tier 2, 1 credit ($0.02)
- `status_uptime`: Tier 2, 1 credit ($0.02)
- `status_leaderboard`: Tier 3, 5 credits ($0.10)
- `provider_deepdive`: Tier 3, 5 credits ($0.10)
- `probe_series_premium`: Tier 3, 5 credits ($0.10)

Tier 2 (1 credit, $0.02) tools are single-entity full-window historical lookups. Tier 3 (5 credits, $0.10) tools are heavy multi-source aggregations and TF-unique measurements.

Rationale: per the 70/30 premium-lock framework, strict-premium endpoints carry TF's actual moat. The Tier 1 ($0.02) baseline price made sense during the demand-discovery temp-unlock; now that these endpoints are gated as strict-premium (v1.30.0) and the gate is observable, repricing into Tier 2/3 sets prices closer to the curated-derived-metrics market (Glassnode / Kaito comparables). Per-call USD cost is now legible alongside credit count in every affected tool description.

Worker changes accompanying this release: `worker/src/index.ts` updates the `requirePayment(..., tier)` and `logPremiumUsage(..., credits)` calls on the 8 strict-premium routes. Two of those routes are not exposed as MCP tools (premium_funding_exposure, premium_packages_momentum) but receive the same tier bump server-side.

No behavior change to free-trial-eligible tools (premium_routing stays at Tier 2 as before, all single-query lookups stay where they were). No change to the strict-premium gate itself (v1.30.0). No change to the on-chain x402 facilitator or credit-purchase minimums.

## 1.30.0 - 2026-05-14

### Changed
- Every paid tool description now advertises the USD price alongside the credit cost. "Costs 1 credit." -> "Costs 1 credit ($0.02).". Lets agents budget calls without needing to look up credit-to-USD conversion separately. No behavior change; pure description metadata.

### Changed (strict-premium tier)
- Six tools now flagged as "Strict premium, no free trial" in their descriptions: `pricing_series`, `benchmark_series`, `status_uptime`, `status_leaderboard`, `provider_deepdive`, `probe_series_premium`. These map to TF Worker paths in the strict-premium set (worker/src/strict-premium-endpoints.ts) which bypasses the per-IP 100-call/day free trial. Their free 7-day-capped siblings (`pricing_series_free`, `benchmark_series_free`, `status_uptime_free`, `status_leaderboard_free`) remain the discovery option. Agents that hit these without auth get a 402 immediately with a strict-premium-specific message, not the free-trial advert.
- Rationale: per the TF 70/30 premium-lock framework, full-window historical time-series and heavy aggregations are TF's moat and warrant strict gating during the demand-discovery phase. Pricing per call is unchanged at this version; repricing into a higher tier is a separate future decision.

## 1.29.0 - 2026-05-13

### Added
- `get_honeypot_iocs` (free): wraps `/api/security/iocs.json`. First-party honeypot indicators-of-compromise observed against TensorFeed.ai trap endpoints over the last 30 days. Filter by `type` (ip / ua / path), cap with `limit` (default 50, max 500). License CC0; pure first-party observation, not a re-export. Pairs with `get_ai_supply_chain_iocs` (GHSA-derived) for a two-layer defender feed.
- `check_afta_certification` (free): wraps `/api/afta-certify/check`. Runs 6 deterministic AFTA probes (well-known endpoints, x402 manifest, pricing transparency, free trial, federation membership, signed receipts) against any domain and returns score, verdict, and per-check pass/fail. Useful for federation prospects, agent governance audits, and demand-side trust signals.
- `get_agent_reputation_card` (free): wraps `/api/agents/reputation/{wallet}` and `/api/agents/reputation/by-token/{prefix}`. Returns the Agent Reputation Bureau card for an EVM wallet or tf_live_ token prefix: reliability, activity, spend, streak, composite trust score, trust grade (S/A/B/C/D), flags, claim status, leaderboard ranks. Cards rebuild daily 04:50 UTC. Returns a helpful 404 hint when no card exists yet.

### Added (MCP primitive)
- `tensorfeed://news/latest` resource: latest 20 AI news articles as a JSON resource. First TF use of the MCP `resources` primitive, exposed alongside the existing `get_ai_news` tool. Hosts that prefer data-shaped surfaces (Claude Desktop, some agent frameworks) can attach the news feed directly without going through tool-call decision loops.

### Fixed
- `registerTool` now auto-infers `PREMIUM_READ_TOOL` annotations (`idempotentHint: false`) for any tool whose description includes "Costs N credit". Previously all read tools defaulted to `idempotentHint: true`, which meant agents that retried paid calls on transient failure could double-charge users. Affects every paid read tool (premium_routing, pricing_series, benchmark_series, status_uptime, status_leaderboard, premium_agents_directory, whats_new, compare_models, provider_deepdive, cost_projection, news_search, probe_series_premium). Write tools (create_*_watch / delete_watch) keep their explicit CREATE_TOOL / DELETE_TOOL annotations and bypass the inference.

Tool count: 46 -> 49. First MCP resource live. Annotations now spec-honest about retry semantics.

## 1.28.0 - 2026-05-13

### Added
- `get_ai_supply_chain_iocs` (free): wraps `/api/security/ai-supply-chain-iocs.json`. Daily-refreshed list of GitHub Security Advisory entries filtered by AI/ML/LLM/MCP keyword vocabulary across npm, PyPI, Go, Maven, and other package ecosystems. Each row carries the package name, ecosystem, GHSA advisory ID, severity, summary, vulnerable version range, publication date, and the canonical GHSA URL. Optional `severity` and `ecosystem` filters; `limit` caps result count (default 25, max 100). Republish posture: TensorFeed re-publishes already-public advisories; the linked GHSA record is authoritative. Useful for MCP-server reviewers, AI-tool maintainers, and supply-chain monitors that want a single AI-relevant feed rather than parsing all of GHSA.

Tool count: 45 -> 46. Lands the same security feed that caught the @mistralai npm worm on day 1, now reachable as an MCP tool for defenders running agentic supply-chain audits.

## 1.27.0 - 2026-05-09

### Added
- `get_recent_earthquakes` (free): wraps `/api/climate/earthquakes`. USGS Earthquake Hazards Program pre-built summary feeds. Magnitude bucket (significant | 4.5 | 2.5 | 1.0 | all) crossed with period (hour | day | week | month). Returns id, magnitude, place, time, depth, lat/lon, tsunami flag, USGS detail URL. License: US Government public domain (17 USC §105).
- `get_weather_alerts` (free, US-only): wraps `/api/climate/weather-alerts`. NWS Active Weather Alerts. Filter by 2-letter state, exact NWS event name, severity, urgency, status. Returns flattened alerts list with effective/expires windows and the canonical NWS web URL. License: US Government public domain.
- `get_agent_opportunities` (free): wraps `/api/agents/opportunities`. Daily 13:30 UTC scan of new repositories across the AI agent ecosystem (Anthropic / OpenAI / Microsoft / ModelContextProtocol / HuggingFace / LangChain / frontier-lab orgs plus MCP, x402, agent-skills keyword sweeps and a vertical-pattern catch). Eleven signals deduped + composite-scored with per-signal MIN/MAX caps so smaller signals are never starved. Optional `signal` filter to one source.

Tool count: 42 -> 45. Brings the stdio package up to parity with the new public-domain feeds and the daily agent-ecosystem scan that landed on the hosted HTTP transport this same day.

## 1.26.0 - 2026-05-09

### Added
- `remotes` array on `server.json` advertising the hosted Streamable HTTP MCP variant at `https://tensorfeed.ai/api/mcp`. The official MCP Registry can now route MCP-aware clients (Claude Code, Cursor, Codex, anything spec-compliant) to the hosted server directly, with no install step. The existing `packages` array (npm stdio at `@tensorfeed/mcp-server`) coexists, so clients can still pick the local-stdio path. After publish via `mcp-publisher`, the `ai.tensorfeed/mcp-server` registry entry will surface both transports for the same server.

## 1.25.1 - 2026-05-07

### Fixed
- `serverInfo.version` reported over the MCP `initialize` response was hardcoded to `1.10.0` and went stale through several releases. Version now reads from `package.json` at startup, so it can never drift again. Same constant feeds the outgoing `User-Agent` header on TensorFeed API calls. No behavior change for tools or transport.

## 1.25.0 - 2026-05-06

### Added
- Tool annotations on every registered tool (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`). All `get_*`, `*_series`, `*_search`, `compare_*`, `provider_deepdive`, `cost_projection`, `whats_new`, `*_snapshot`, `probe_*`, `list_watches`, `premium_routing`, and `premium_agents_directory` tools are flagged read-only + idempotent + open-world. The four `create_*_watch` tools are flagged write + non-idempotent. `delete_watch` is flagged destructive + idempotent. Hosts and clients can now decide whether a tool is safe to batch, retry, or call autonomously without re-prompting the user. Required by the Anthropic Connectors Directory.

## 1.24.0 - 2026-05-06

### Added
- `get_model_deprecations` tool (free). Wraps the new `/api/model-deprecations` endpoint. Returns the provider-by-provider model retirement and deprecation calendar with announced / deprecation / sunset dates, recommended replacement model id, and a source URL pointing at the provider's own announcement. Optional `provider` and `status` filters. Agents that depend on a specific model id can now ask one question and learn whether the model will keep accepting traffic and, if not, what to migrate to. Closes the most-frequent agent-operator surprise in the production lifecycle.

## 1.23.0 - 2026-05-05

### Added
- `create_leaderboard_rank_watch` tool. Premium webhook watch (1 credit) fires when a provider crosses a rank threshold on the cross-provider 7-day uptime leaderboard. Operations: `drops_below`, `rises_above`, `changes`. Use case: SRE / vendor-management teams want a notification when their primary AI provider's relative reliability shifts.
- 5 additional providers covered by every status tool: OpenRouter, ElevenLabs, Stability AI, Runway, Luma. Brings total monitored to 20.

## 1.22.0 - 2026-05-04

### Added
- Cross-provider uptime leaderboard tools: `status_leaderboard_free` (free, 7-day cap) and `status_leaderboard` (premium, 1 credit, up to 90 days). Returns providers ranked by uptime % DESC computed from minute-resolution counters (~720 samples per provider per day at the 2-min poll cadence). Premium adds `incident_count` and `mttr_minutes` (mean time to recover) per provider. Aimed at SRE/ops/procurement teams comparing AI vendor reliability for vendor selection or post-incident reviews.
- 4 new monitored providers behind every status tool: Google Gemini (via Google Cloud incidents), GitHub Copilot, Perplexity (via Instatus), and Groq. Brings total monitored to 10 major LLM providers.

## 1.21.0 - 2026-05-04

### Added
- Three free history-series tools: `pricing_series_free`, `benchmark_series_free`, `status_uptime_free`. Each returns up to 7 days of daily snapshots (price/score/uptime) for one model or provider. Max range capped at 7 days; for the full 90-day window keep using the paid `pricing_series`, `benchmark_series`, `status_uptime` tools (1 credit each). Reason for the split: agents discovering the data need a free way to see "yes, TensorFeed actually has historical pricing for this model" before deciding to spend a credit. The 7-day teaser shows the trend without giving away the long tail.

## 1.20.0 - 2026-05-04

### Changed
- `get_ai_ecosystem_today` now calls the new `/api/today` worker endpoint (single fetch) instead of fanning out 9 individual fetches client-side. Behavior is unchanged from the agent's perspective: same args, same text-rendered output. The win is that the worker's edge cache absorbs the load: a thousand agents calling `get_ai_ecosystem_today` per minute now hit the worker once for 5 minutes (cache TTL) instead of 9000 times. Net cost on the worker stays constant.

## 1.19.0 - 2026-05-04

### Added
- `get_ai_ecosystem_today` tool. One-shot composite AI morning brief that internally fans out across 9 free TensorFeed endpoints in parallel (news, 3 paper feeds, HF models/datasets/Spaces, hot GitHub issues, Reddit threads, OpenRouter catalog summary, provider status) and returns a single synthesized text response. Optional `sections` arg (any subset of news / papers / hf / community / inference / status) and `limit_per_section` arg. Graceful degradation: any one feed failing just drops its section. Designed for agents that want a fast snapshot without 8 separate tool calls. Free.

## 1.18.0 - 2026-05-04

### Added
- `get_hf_daily_papers` tool. Hugging Face Daily Papers (editor-curated AI/ML papers with community upvotes and discussion counts). Different signal from `get_arxiv_recent` and `get_ai_papers_trending`. Optional `limit` arg. Free.

## 1.17.0 - 2026-05-04

### Added
- `get_openrouter_models` tool. OpenRouter cross-provider model catalog (200+ models across 50+ inference providers) with comparable per-token pricing, context window, modality, and provider metadata. Optional `namespace` filter, `free_only` flag for free-tier models, `cheapest` sort by ascending input price, and `limit` for the rendered list. Companion to `get_model_pricing` (curated frontier-lab catalog) by surfacing the long tail of OSS models on cloud inference. Free.

## 1.16.0 - 2026-05-04

### Added
- `get_reddit_trending` tool. Currently-hot threads from 7 AI-relevant subreddits (LocalLLaMA, MachineLearning, ClaudeAI, OpenAI, singularity, artificial, AI_Agents), ranked by score, top 30. Optional `subreddit` arg to filter to one sub, optional `limit` for the rendered list. Companion to `get_hot_issues`: GitHub developer conversation vs Reddit community conversation. Titles pass through the worker's prompt-injection sanitizer at capture time. Free.

## 1.15.0 - 2026-05-04

### Changed
- `get_hf_trending` tool now covers Hugging Face Spaces in addition to models and datasets. Spaces are ranked by likes (the right signal for hosted apps where downloads is meaningless) and the rendered entry shows id, sdk, likes, runtime stage when available, and hardware tier when available. New `section` enum values: `'spaces'` (just spaces), `'all'` (all three sections, the new default). `'both'` continues to mean models+datasets for backward compat. Output also surfaces top Space SDKs (gradio / streamlit / docker / static) in the header.

## 1.14.0 - 2026-05-04

### Added
- `get_hot_issues` tool. Currently-hot GitHub issues across the AI ecosystem, ranked by comment count. Five fan-out search queries on AI topics (llm, ai-agents, large-language-models, machine-learning, transformer), filtered to is:issue is:open archived:false comments>=10 with activity in the last 7 days, deduped, top 30. Optional `limit` arg for the rendered list. Free.

Companion to `get_trending_repos`: that surfaces repos gaining stars, this surfaces repos where the active conversations are happening.

## 1.13.0 - 2026-05-04

### Added
- `get_ai_papers_trending` tool. Daily curated AI/ML research papers ranked by citation count, sourced from Semantic Scholar. Five fan-out queries (LLM, transformer, RLHF, AI agents, diffusion), deduped, top 30. Free.
- `get_arxiv_recent` tool. Most recent arXiv submissions in cs.AI / cs.LG / cs.CL / cs.CV, top 50 by submission date. Optional `limit` arg for the rendered list. Free.
- `get_hf_trending` tool. Top 30 most-downloaded models and datasets on Hugging Face. Optional `section` (models / datasets / both) and `limit` args. Free.

All three are backed by the worker endpoints shipped in the same monorepo commit and pass through the 1.12.0 output sanitizer automatically.

## 1.12.0 - 2026-05-04

### Added
- Defense-in-depth output sanitizer (`src/sanitize.ts`). Every tool's text output passes through a scrub pass before reaching the host LLM (Claude Desktop, Cursor, Cline, Roo, etc): strips ASCII control chars (preserves newline, carriage return, tab), strips bidi control + zero-width spoofing chars, and neutralizes role-confusion markers (ChatML / Llama / Mistral chat tokens, "ignore previous instructions", line-leading "system:" / "developer:" / "assistant:" preambles). Wired via a new `registerTool()` helper that wraps `server.tool()`. The TensorFeed worker already runs the same scrub on its agent-facing endpoints; this layer protects against any new endpoint that might forget it, plus drift between worker rules and what the MCP server should consider safe. No behavior change for legitimate text. No new dependencies.

## 1.11.1 - 2026-05-04

### Changed
- Repository URL updated to point at the dedicated [`RipperMercs/tensorfeed-mcp`](https://github.com/RipperMercs/tensorfeed-mcp) repo. The MCP server now has its own GitHub home for issues, stars, and discoverability. Source-of-truth for builds remains in the main `tensorfeed` monorepo's `mcp-server/` folder; the standalone repo is mirrored on release. No code changes; no behavior changes; npm install / npx unaffected.

## 1.11.0 - 2026-04-29

### Added
- `probe_latest` tool: last 24 hours of measured LLM endpoint latency and availability per provider (Anthropic, OpenAI, Google, Mistral, Cohere). TensorFeed pings each provider's chat completion endpoint every 15 min and records ttfb / total / status. The data is unique because it is measured, not self-reported. Free, no auth.
- `probe_series` tool: daily SLA series for one provider with ttfb/total p50/p95/p99 and incident-hour count, 90-day max range. 1 credit per call. Pairs with `premium_routing` for picking a model whose SLA you can verify.

## 1.10.0 - 2026-04-29

### Added
- `mcp_registry_snapshot` tool: today's summary of the official Model Context Protocol server registry: total servers, by-status breakdown, top namespaces, 1-day deltas (newly added, reactivated, deprecated). Free, no auth.
- `mcp_registry_series` tool: multi-day time series of MCP registry growth and churn. Range capped at 90 days, default 30 days back. 1 credit per call.

The new tools are backed by a fresh daily cron capture of registry.modelcontextprotocol.io. The registry itself is open data, but a 30/90-day trend requires daily capture started weeks before the question is asked.

## 1.7.0 - 2026-04-27

### Added
- `compare_models` tool: side-by-side comparison of 2-5 AI models with normalized benchmarks (union-of-keys with null for missing scores) and rankings (cheapest blended, most context, per-benchmark leaderboard). 1 credit per call.

## 1.6.0 - 2026-04-27

### Added
- `provider_deepdive` tool: one provider's full profile in a single call: live status with components, all models with pricing + tier + benchmark scores joined, recent news, agent traffic. 1 credit per call.

## 1.5.0 - 2026-04-27

### Added
- `create_digest_watch` tool: register a scheduled daily/weekly digest watch. Fires HMAC-signed POST to your callback URL with a curated pricing-changes summary regardless of whether anything dramatic happened. 1 credit per registration.

## 1.4.0 - 2026-04-27

### Added
- `forecast` tool: conservative linear-regression forecast for a price field or benchmark score with 95% prediction interval and confidence label. 1 credit per call.

## 1.3.0 - 2026-04-27

### Added
- `cost_projection` tool: project workload cost across 1-10 AI models with four time horizons and cheapest-monthly ranking. 1 credit per call.

## 1.2.0 - 2026-04-27

### Added
- `news_search` tool: full-text search over the AI news corpus with date/provider/category filters and relevance scoring. 1 credit per call.

## 1.1.0 - 2026-04-27

### Added
- 12 premium tools: `premium_routing`, `pricing_series`, `benchmark_series`, `status_uptime`, `history_compare`, `premium_agents_directory`, `list_watches`, `create_price_watch`, `create_status_watch`, `delete_watch`, `get_account_balance`, `get_account_usage`. All gated by the `TENSORFEED_TOKEN` env var.
- `fetchJSON()` helper extended with `{ method, body, auth }` so tools can hit POST and DELETE endpoints. Friendly error messages on 401 (token rejected) and 402 (insufficient credits).
- `mcp-server/server.json` manifest authored against the official MCP registry schema (`ai.tensorfeed/mcp-server`).
- README expanded with per-tier tool tables and `env` config examples for Claude Desktop / Code.

## 1.0.0 - 2026-04-26 (initial release)

### Added
- 5 free tools: `get_ai_news`, `get_ai_status`, `is_service_down`, `get_model_pricing`, `get_ai_today`. No auth, no install beyond `npx -y @tensorfeed/mcp-server`.
