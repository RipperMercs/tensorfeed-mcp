# TensorFeed MCP Server

[![npm version](https://img.shields.io/npm/v/@tensorfeed/mcp-server.svg?style=flat-square&color=cb3837)](https://www.npmjs.com/package/@tensorfeed/mcp-server)
[![MCP Registry](https://img.shields.io/badge/MCP_Registry-ai.tensorfeed%2Fmcp--server-2563eb?style=flat-square)](https://registry.modelcontextprotocol.io/v0/servers/ai.tensorfeed/mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg?style=flat-square)](LICENSE)
[![AFTA Certified](https://img.shields.io/badge/AFTA-Certified-7c3aed?style=flat-square)](https://tensorfeed.ai/agent-fair-trade)
[![HF Dataset](https://img.shields.io/badge/HF-tensorfeed%2Fai--ecosystem--daily-yellow?style=flat-square)](https://huggingface.co/datasets/tensorfeed/ai-ecosystem-daily)

The official [Model Context Protocol](https://modelcontextprotocol.io) server for [TensorFeed.ai](https://tensorfeed.ai). Plugs into Claude Desktop, Claude Code, Cursor, and any MCP-compatible client. Gives your agent real-time AI ecosystem data through 24 sharp tools: free data tools, eight signed verdict decisions with free previews, and premium tools paid per call in USDC on Base.

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

## Hosted remote endpoint (no install)

Prefer not to run a local process? The same TensorFeed data is served from a hosted Streamable HTTP MCP endpoint with a curated 33-tool subset (31 free + 2 premium), and its premium tools are payable per call with nothing but a funded USDC wallet: no account, no signup, no API key.

| Surface | URL |
| --- | --- |
| Canonical endpoint | `https://mcp.tensorfeed.ai/mcp` |
| Same endpoint, legacy path | `https://tensorfeed.ai/api/mcp` |
| Strict x402 transport (for auto-pay wrappers) | `https://mcp.tensorfeed.ai/mcp?x402=strict` |

```jsonc
// Any MCP client with an HTTP transport
{
  "mcpServers": {
    "tensorfeed": { "type": "http", "url": "https://mcp.tensorfeed.ai/mcp" }
  }
}
```

`GET` the endpoint for machine-readable discovery info. `POST` a JSON-RPC 2.0 envelope for `initialize`, `tools/list`, `tools/call`, and `ping`. The hosted catalog leans broader than this stdio package (SEC EDGAR full-text search, openFDA, EIA energy data, USGS earthquakes, NWS weather alerts, AI papers, agent-ecosystem scans).

**Paying hosted premium tools with a wallet (x402):** `route_verdict` (the signed model-routing decision) and `whats_new` (the full AFTA-signed morning brief) cost 1 credit ($0.02 in USDC, Base or Solana) per call. Call the tool unpaid to receive the canonical x402 payment requirements (the `accepts` array), sign, and retry with the base64 payload in the `payment` argument, or send it as an `X-PAYMENT` header. x402 auto-pay client wrappers should use the strict URL: unpaid premium calls there return a real HTTP 402 with a `PAYMENT-REQUIRED` header, and settled responses carry a `PAYMENT-RESPONSE` header plus the AFTA-signed receipt. Bearer credits tokens work on the hosted endpoint too. No USDC yet? Free trial credits via a wallet signature at `https://tensorfeed.ai/api/payment/trial-credits`.

## Free tools

No token required for the data tools; the three account utilities are free but scoped to your token.

| Tool | Description |
|------|-------------|
| `get_ai_news` | Latest AI news from 15+ sources (Anthropic, OpenAI, Google, TechCrunch, arXiv, more) in one feed |
| `find_tensorfeed_data` | Discovery tool: describe a data need in plain language, get the best matching TensorFeed endpoints |
| `get_ai_status` | Real time operational status of major AI services (Claude, OpenAI, Gemini, Mistral, Cohere, more) |
| `is_service_down` | Check whether one named AI service is operational, degraded, or down, with component detail |
| `get_model_pricing` | Cross provider AI model pricing: input/output price per 1M tokens, context window, release date |
| `account_status` | Your token's credit balance plus recent per endpoint usage (requires token, free) |
| `list_watches` | List the active webhook watches owned by your token (requires token, free) |
| `delete_watch` | Delete one of your webhook watches by id (requires token, free) |

The rest of TensorFeed's 100+ endpoints stay reachable through `find_tensorfeed_data`, which returns the matching endpoint URLs your agent can call over plain HTTP.

## Premium and tiered tools

Set `TENSORFEED_TOKEN` to enable paid calls. Two pricing mechanics, both visible in each tool's own description:

- The **eight verdict tools** take a `tier` parameter: `tier="preview"` (default) is free at 10 calls per IP per day, `tier="full"` costs 1 credit ($0.02) and adds the full ranking plus an AFTA-signed receipt.
- The **series tools** take a `days` parameter: days 1 to 7 are free, days 8 to 90 are paid.

| Tool | Cost | Description |
|------|------|-------------|
| `route_verdict` | Preview free, full 1 credit | Signed best fit model decision fusing pricing, benchmarks, usage, latency, and incident state |
| `provider_reliability_verdict` | Preview free, full 1 credit | Signed ruling on the most dependable and riskiest AI provider from TensorFeed's own latency probes |
| `x402_settlement_verdict` | Preview free, full 1 credit | Signed verdict on x402 USDC settlement market momentum and concentration on Base |
| `x402_publisher_verdict` | Preview free, full 1 credit | Signed trust verdict on one x402 publisher domain's settlement activity |
| `stack_safety_verdict` | Preview free, full 1 credit | Deploy gate (BLOCK/HOLD/PASS/UNKNOWN) for an AI software stack against CVEs and CISA KEV |
| `benchmark_trust_verdict` | Preview free, full 1 credit | Signed ruling on whether an AI benchmark is still trustworthy or saturated/contaminated |
| `failover_verdict` | Preview free, full 1 credit | Signed ruling on the best operational provider to fail over to when one is degraded |
| `ssvc_verdict` | Preview free, full 1 credit | Signed SSVC patch urgency decision for one CVE using the CISA SSVC decision tree |
| `pricing_series` | Days 1-7 free, 8-90 1 credit | Daily price points for one AI model over a window, with min/max/delta summary |
| `benchmark_series` | Days 1-7 free, 8-90 1 credit | Daily benchmark scores for one model and benchmark over a window |
| `status_uptime` | Days 1-7 free, 8-90 1 credit | Daily uptime rollup for one provider with operational/degraded/down day counts |
| `status_leaderboard` | Days 1-7 free, 8-90 3 credits | Cross provider uptime leaderboard ranked by uptime percent, from minute resolution counters |
| `whats_new` | 1 credit | Everything that changed in AI recently: pricing moves, new models, incidents, top news |
| `compare_models` | 1 credit | Side by side pricing, benchmarks, status, and news for 2 to 5 models with rankings |
| `provider_deepdive` | 3 credits, strict premium | Everything about one AI provider: status, every model priced and benchmarked, news, traffic |
| `create_watch` | 1 credit at registration | Register a webhook watch for a price change, status transition, digest, or rank threshold |

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
- Companion package, on-chain x402 verifier: https://www.npmjs.com/package/@tensorfeed/x402-base-mcp
- MCP registry: https://registry.modelcontextprotocol.io/v0/servers/ai.tensorfeed/mcp-server
- Sister site (real-time data dashboard): https://terminalfeed.io
- Issues / feature requests: https://github.com/RipperMercs/tensorfeed-mcp/issues

## License

MIT. Built by [TensorFeed.ai](https://tensorfeed.ai/about).
