# Changelog

All notable changes to the [TensorFeed.ai MCP server](https://github.com/RipperMercs/tensorfeed-mcp). Free tools work without configuration; premium tools require a bearer token via the `TENSORFEED_TOKEN` env var. Buy credits at [tensorfeed.ai/developers/agent-payments](https://tensorfeed.ai/developers/agent-payments).

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
- `probe_latest` tool — last 24 hours of measured LLM endpoint latency and availability per provider (Anthropic, OpenAI, Google, Mistral, Cohere). TensorFeed pings each provider's chat completion endpoint every 15 min and records ttfb / total / status. The data is unique because it is measured, not self-reported. Free, no auth.
- `probe_series` tool — daily SLA series for one provider with ttfb/total p50/p95/p99 and incident-hour count, 90-day max range. 1 credit per call. Pairs with `premium_routing` for picking a model whose SLA you can verify.

## 1.10.0 - 2026-04-29

### Added
- `mcp_registry_snapshot` tool — today's summary of the official Model Context Protocol server registry: total servers, by-status breakdown, top namespaces, 1-day deltas (newly added, reactivated, deprecated). Free, no auth.
- `mcp_registry_series` tool — multi-day time series of MCP registry growth and churn. Range capped at 90 days, default 30 days back. 1 credit per call.

The new tools are backed by a fresh daily cron capture of registry.modelcontextprotocol.io. The registry itself is open data, but a 30/90-day trend requires daily capture started weeks before the question is asked.

## 1.7.0 - 2026-04-27

### Added
- `compare_models` tool — side-by-side comparison of 2-5 AI models with normalized benchmarks (union-of-keys with null for missing scores) and rankings (cheapest blended, most context, per-benchmark leaderboard). 1 credit per call.

## 1.6.0 - 2026-04-27

### Added
- `provider_deepdive` tool — one provider's full profile in a single call: live status with components, all models with pricing + tier + benchmark scores joined, recent news, agent traffic. 1 credit per call.

## 1.5.0 - 2026-04-27

### Added
- `create_digest_watch` tool — register a scheduled daily/weekly digest watch. Fires HMAC-signed POST to your callback URL with a curated pricing-changes summary regardless of whether anything dramatic happened. 1 credit per registration.

## 1.4.0 - 2026-04-27

### Added
- `forecast` tool — conservative linear-regression forecast for a price field or benchmark score with 95% prediction interval and confidence label. 1 credit per call.

## 1.3.0 - 2026-04-27

### Added
- `cost_projection` tool — project workload cost across 1-10 AI models with four time horizons and cheapest-monthly ranking. 1 credit per call.

## 1.2.0 - 2026-04-27

### Added
- `news_search` tool — full-text search over the AI news corpus with date/provider/category filters and relevance scoring. 1 credit per call.

## 1.1.0 - 2026-04-27

### Added
- 12 premium tools: `premium_routing`, `pricing_series`, `benchmark_series`, `status_uptime`, `history_compare`, `premium_agents_directory`, `list_watches`, `create_price_watch`, `create_status_watch`, `delete_watch`, `get_account_balance`, `get_account_usage`. All gated by the `TENSORFEED_TOKEN` env var.
- `fetchJSON()` helper extended with `{ method, body, auth }` so tools can hit POST and DELETE endpoints. Friendly error messages on 401 (token rejected) and 402 (insufficient credits).
- `mcp-server/server.json` manifest authored against the official MCP registry schema (`ai.tensorfeed/mcp-server`).
- README expanded with per-tier tool tables and `env` config examples for Claude Desktop / Code.

## 1.0.0 — 2026-04-26 (initial release)

### Added
- 5 free tools: `get_ai_news`, `get_ai_status`, `is_service_down`, `get_model_pricing`, `get_ai_today`. No auth, no install beyond `npx -y @tensorfeed/mcp-server`.
