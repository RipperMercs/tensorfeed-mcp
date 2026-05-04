# TensorFeed MCP Server

[![npm version](https://img.shields.io/npm/v/@tensorfeed/mcp-server.svg?style=flat-square&color=cb3837)](https://www.npmjs.com/package/@tensorfeed/mcp-server)
[![MCP Registry](https://img.shields.io/badge/MCP_Registry-ai.tensorfeed%2Fmcp--server-2563eb?style=flat-square)](https://registry.modelcontextprotocol.io/v0/servers/ai.tensorfeed/mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg?style=flat-square)](LICENSE)
[![AFTA Certified](https://img.shields.io/badge/AFTA-Certified-7c3aed?style=flat-square)](https://tensorfeed.ai/agent-fair-trade)
[![HF Dataset](https://img.shields.io/badge/HF-tensorfeed%2Fai--ecosystem--daily-yellow?style=flat-square)](https://huggingface.co/datasets/tensorfeed/ai-ecosystem-daily)

The official [Model Context Protocol](https://modelcontextprotocol.io) server for [TensorFeed.ai](https://tensorfeed.ai). Plugs into Claude Desktop, Claude Code, Cursor, and any MCP-compatible client. Gives your agent real-time AI ecosystem data plus 14 premium tools paid in USDC on Base.

```jsonc
// claude_desktop_config.json
{
  "mcpServers": {
    "tensorfeed": {
      "command": "npx",
      "args": ["-y", "@tensorfeed/mcp-server"]
    }
  }
}
```

That's it. Restart Claude Desktop and ask: *"What's happening in AI today?"* or *"Is Claude down right now?"*

## Why this exists

Most AI agents have a knowledge cutoff in the past. This MCP server gives them a window into:

- **What's broken right now** in the AI stack (Anthropic, OpenAI, Google, Mistral, others)
- **What's new in the last 24 hours** across 36+ news sources
- **Current model pricing** across every major provider
- **Live AI bot traffic** to a real production site (who's crawling, who's buying tokens)
- **Smart model routing** ("which model is best for THIS task right now")
- **Cost projection** before you commit to a workload
- **Webhook watches** that fire when a price changes or a service drops

The premium tools are paid per call in USDC on Base. No subscription, no signup, no API key emails. Buy a few credits, get a bearer token, agent uses it. The whole thing is [Agent Fair-Trade Agreement](https://tensorfeed.ai/agent-fair-trade) certified: code-enforced no-charge on errors, breaker, schema-fail, and stale data; Ed25519-signed receipts on every paid call.

## Free tools

No token required. Connect and use immediately.

| Tool | Description |
|------|-------------|
| `get_ai_news` | Latest AI news from 36+ sources, filterable by category |
| `get_ai_status` | Real-time status of Claude, OpenAI, Gemini, Mistral, and more |
| `is_service_down` | Check if a specific AI service is down |
| `get_model_pricing` | Compare pricing across all major AI model providers |
| `get_ai_today` | Summary of top AI stories from the last 24 hours |
| `get_agent_activity` | Live AI bot traffic on TensorFeed.ai with top-bot breakdown |
| `mcp_registry_snapshot` | Today's count + churn of the official MCP server registry |
| `probe_latest` | Last 24h of measured LLM endpoint latency per provider (TTFB / total p50/p95/p99). Measured, not self-reported |

## Premium tools

Set `TENSORFEED_TOKEN` to enable. Tools are 1 credit each ($0.02 at base rate, less with volume bundles). Watches are also 1 credit at registration; reads/lists/deletes are free for the owning token.

| Tool | Description |
|------|-------------|
| `premium_routing` | Top-N ranked AI model recommendations for a task with full score breakdown |
| `pricing_series` | Daily price points for one model with min/max/delta summary |
| `benchmark_series` | Score evolution for a benchmark on one model |
| `status_uptime` | Daily uptime % for one provider with incident-day list |
| `premium_agents_directory` | Enriched agents catalog with live status, news, traffic, trending score |
| `news_search` | Full-text news search with date/provider/category filters and relevance scoring |
| `cost_projection` | Project workload cost across 1-10 AI models with 4 time horizons |
| `provider_deepdive` | One provider's full profile: status, models, pricing, benchmarks, news |
| `compare_models` | Side-by-side comparison of 2-5 models with normalized benchmarks |
| `whats_new` | Agent morning brief: pricing changes, incidents, top news from last 1-7 days |
| `mcp_registry_series` | Multi-day MCP registry growth and churn series, 90-day max range |
| `probe_series` | Daily SLA series for one LLM provider, 90-day max range |
| `create_price_watch` | Register a webhook watch on a model price change |
| `create_status_watch` | Register a webhook watch on a service status transition |
| `create_digest_watch` | Register a daily/weekly pricing-digest webhook |
| `list_watches`, `delete_watch`, `get_account_balance`, `get_account_usage` | Free token-scoped utilities |

Buy credits in USDC on Base at [tensorfeed.ai/developers/agent-payments](https://tensorfeed.ai/developers/agent-payments). Volume tiers: 10% off at $5, 25% off at $30, 40% off at $200. First payment from a new wallet gets a 50-credit welcome bonus.

```jsonc
// claude_desktop_config.json — premium config
{
  "mcpServers": {
    "tensorfeed": {
      "command": "npx",
      "args": ["-y", "@tensorfeed/mcp-server"],
      "env": {
        "TENSORFEED_TOKEN": "tf_live_..."
      }
    }
  }
}
```

## Setup with other MCP clients

The same `command` + `args` + `env` block works in Claude Code, Cursor, Continue, Cline, Zed, and Goose. Anywhere that takes a stdio MCP server config, this drops in.

Run standalone for testing:

```bash
npx @tensorfeed/mcp-server
# with premium tools enabled:
TENSORFEED_TOKEN=tf_live_... npx @tensorfeed/mcp-server
```

## Example queries

Free tier:

- "What's happening in AI today?"
- "Is Claude down right now?"
- "Compare pricing between Claude Opus and GPT-4o"
- "What's the latency on Anthropic's API right now?"
- "Which AI bots are most active on the web today?"

Premium tier (with `TENSORFEED_TOKEN` set):

- "Recommend the cheapest AI model for code generation under $5 per million tokens"
- "Show the price history of Claude Opus 4.7 over the last 30 days"
- "What's Anthropic's uptime this month?"
- "Project monthly cost if we send 10M input + 2M output tokens/day to Claude Sonnet 4.6"
- "Set up a webhook to fire when GPT-5 pricing changes"
- "Give me a morning brief on what changed in AI in the last 24 hours"

## Agent Fair-Trade Agreement

This server speaks AFTA. Every paid call:

- Returns no charge on 5xx, circuit breaker trip, schema validation failure, or stale data (older than the endpoint's published SLA)
- Returns an Ed25519-signed receipt your agent can verify against the public key at [`tensorfeed.ai/.well-known/tensorfeed-receipt-key.json`](https://tensorfeed.ai/.well-known/tensorfeed-receipt-key.json)
- Logs the no-charge event to a public ledger at [`/api/payment/no-charge-stats`](https://tensorfeed.ai/api/payment/no-charge-stats)
- Honors a 100-call/min burn-rate breaker so a bug in your loop can't drain the wallet

The full standard is at [tensorfeed.ai/agent-fair-trade](https://tensorfeed.ai/agent-fair-trade). Manifest at [`/.well-known/agent-fair-trade.json`](https://tensorfeed.ai/.well-known/agent-fair-trade.json).

## Refunds, sanctions, terms

All credit purchases are final per Section 17.5 of the [Terms](https://tensorfeed.ai/terms#premium). Credits do not expire and are jointly redeemable on tensorfeed.ai and terminalfeed.io, so the safe pattern is to buy small ($1 USDC for 50 credits) and top up as call volume is calibrated. Premium access is unavailable in OFAC-sanctioned jurisdictions per Section 17.9.

## Data source

All data comes from the [TensorFeed.ai API](https://tensorfeed.ai/developers), which aggregates 42 feeds across the AI ecosystem (news, pricing, benchmarks, status, GPU pricing, MCP registry growth, latency probes, agent traffic, AFTA adopters, training datasets, embodied AI, hardware, and more). A daily JSONL snapshot of the full corpus is published to Hugging Face at [`tensorfeed/ai-ecosystem-daily`](https://huggingface.co/datasets/tensorfeed/ai-ecosystem-daily) under an inference-only license.

## Star this repo

If this server is useful to you, a star helps other agent builders find it. Thank you.

## Links

- TensorFeed.ai: https://tensorfeed.ai
- API reference: https://tensorfeed.ai/developers
- Premium / payments: https://tensorfeed.ai/developers/agent-payments
- AFTA standard: https://tensorfeed.ai/agent-fair-trade
- Hugging Face dataset: https://huggingface.co/datasets/tensorfeed/ai-ecosystem-daily
- npm package: https://www.npmjs.com/package/@tensorfeed/mcp-server
- MCP registry: https://registry.modelcontextprotocol.io/v0/servers/ai.tensorfeed/mcp-server
- Sister site (real-time data dashboard): https://terminalfeed.io
- Issues / feature requests: https://github.com/RipperMercs/tensorfeed-mcp/issues

## License

MIT. Built by [TensorFeed.ai](https://tensorfeed.ai/about).
