#!/usr/bin/env node

import { McpServer, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z, ZodRawShape } from 'zod';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sanitizeToolResponse, sanitizeForLLM, sanitizeReflectedValue, sanitizeErrorText } from './sanitize.js';

const API_BASE = 'https://tensorfeed.ai/api';

// Per-request upstream timeout. fetchJSON is the single HTTP helper behind every
// MCP tool and the latest_news resource, so a missing timeout would let one
// stalled upstream hang an agent's tool call. 20s is generous for the slowest
// premium endpoint while still failing fast on a genuine stall.
const REQUEST_TIMEOUT_MS = 20000;

const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
const SDK_VERSION = (JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string }).version;

// Upsell footer appended to the free routing-precursor tools (get_ai_status,
// get_model_pricing). Each is a signal an agent gathers before choosing a
// model, so each points at the one premium tool that fuses them into a signed
// decision. Mirrors the hosted /api/mcp `next` field. Honest, zero em dashes.
const ROUTE_VERDICT_FOOTER =
  '\n\nNext: route_verdict with tier="full" (1 credit, $0.02) fuses live pricing, contamination-discounted ' +
  'benchmarks, real production usage, measured p95 latency, incident state, and deprecation ' +
  'flags into a signed best-fit model decision with ranked runners-up and an AFTA-signed ' +
  'receipt. No USDC yet? Sign a wallet message at tensorfeed.ai/api/payment/trial-credits ' +
  'for 25 free credits.';

// ── API helpers ─────────────────────────────────────────────────────

interface FetchOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
  /** When true, attach the TENSORFEED_TOKEN env var as a Bearer token. */
  auth?: boolean;
}

async function fetchJSON(path: string, opts: FetchOptions = {}): Promise<unknown> {
  const headers: Record<string, string> = {
    'User-Agent': `TensorFeed-MCP/${SDK_VERSION}`,
  };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.auth) {
    const token = process.env.TENSORFEED_TOKEN;
    if (!token) {
      throw new Error(
        'TENSORFEED_TOKEN env var is not set. Premium MCP tools require a bearer token. ' +
          'Buy credits at https://tensorfeed.ai/developers/agent-payments and pass the returned tf_live_... token via the TENSORFEED_TOKEN env var in your MCP client config.',
      );
    }
    headers['Authorization'] = `Bearer ${token}`;
  }
  // Bound every request with a timeout so a stalled upstream (TLS or connect
  // hang, slow Worker, KV or origin stall) cannot hang the agent's tool call
  // indefinitely. An aborted fetch surfaces as a clean Error below instead of
  // an open-ended await.
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: opts.method ?? 'GET',
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
  } catch (err) {
    // AbortSignal.timeout fires a TimeoutError (DOMException name 'TimeoutError');
    // a manual abort surfaces as 'AbortError'. Either way, rethrow a clean Error
    // so it reaches the agent as a normal MCP tool error rather than a raw abort.
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new Error(`TensorFeed upstream request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  }
  if (!res.ok) {
    let errPayload: unknown;
    try {
      errPayload = await res.json();
    } catch {
      errPayload = await res.text().catch(() => '');
    }
    // The upstream error body is untrusted input. Cap it here so a hostile
    // or malfunctioning upstream (or a middlebox returning an HTML error
    // page) cannot inflate the error message. The registerTool wrapper
    // additionally runs the full error scrub before anything reaches the
    // host LLM; this cap just bounds what gets embedded at the source.
    const detail = errDetail(errPayload);
    if (res.status === 402) {
      throw new Error(
        `Payment required (402). Your token may be out of credits. Top up at https://tensorfeed.ai/developers/agent-payments. Detail: ${detail}`,
      );
    }
    if (res.status === 401) {
      throw new Error(
        `Token rejected (401). Check that TENSORFEED_TOKEN is set to a valid tf_live_... token. Detail: ${detail}`,
      );
    }
    throw new Error(`API error ${res.status}: ${detail}`);
  }
  return res.json();
}

// Stringify an upstream error payload for embedding in an Error message,
// bounded so an oversized body cannot balloon the error text.
const MAX_ERR_DETAIL_CHARS = 1500;
function errDetail(payload: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(payload) ?? String(payload);
  } catch {
    s = String(payload);
  }
  return s.length > MAX_ERR_DETAIL_CHARS ? s.slice(0, MAX_ERR_DETAIL_CHARS) + '...' : s;
}

// ── Server setup ────────────────────────────────────────────────────

const server = new McpServer({
  name: 'tensorfeed',
  version: SDK_VERSION,
});

// ── Defense-in-depth tool wrapper ───────────────────────────────────
// Every tool's text output passes through sanitizeToolResponse before
// reaching the host LLM. Strips control chars, bidi/zero-width spoofing,
// and neutralizes role-confusion tokens (ChatML / Llama / Mistral chat
// markers, "ignore previous instructions", etc). The TensorFeed worker
// already runs the same scrub on its agent-facing endpoints; this layer
// covers any new endpoint that might forget it, plus protects against
// drift between worker rules and what the MCP server should consider
// safe. See ./sanitize.ts.

// MCP tool annotation presets. These are HINTS for hosts/clients and agents
// so they can decide whether a tool is safe to call autonomously, batch, or
// retry. Required by the Anthropic Connectors Directory and used by client
// tool-pickers. See https://modelcontextprotocol.io/specification#tool-annotations
//
//   readOnlyHint:    true if the tool only reads, no side effects on the world
//   destructiveHint: true if the tool may delete/destroy data
//   idempotentHint:  true if calling twice has the same effect as once
//   openWorldHint:   true if the tool interacts with external systems (HTTP/APIs)
//
// All TensorFeed tools hit the tensorfeed.ai HTTP API, so openWorldHint is
// always true here.
const READ_TOOL: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};
// Paid read tools: same as READ_TOOL but idempotentHint: false because each
// call burns a credit. Agents that retry on transient failure under
// READ_TOOL semantics would double-charge users on flaky networks. Applied
// automatically below when a tool's description includes "Costs N credit".
const PREMIUM_READ_TOOL: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};
const CREATE_TOOL: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};
const DELETE_TOOL: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
};

const PAID_TOOL_RE = /Costs \d+ credit/i;

function registerTool<Args extends ZodRawShape>(
  name: string,
  description: string,
  paramsSchema: Args,
  cb: ToolCallback<Args>,
  annotations?: ToolAnnotations,
) {
  // When no explicit annotation is passed, infer from the description.
  // Free reads: READ_TOOL (idempotent). Paid reads (description mentions
  // "Costs N credit"): PREMIUM_READ_TOOL (NOT idempotent, because each
  // call burns a credit and naive retry would double-charge). Tools that
  // mutate (create_*_watch / delete_watch) pass CREATE_TOOL / DELETE_TOOL
  // explicitly and bypass this inference.
  const finalAnnotations: ToolAnnotations =
    annotations ?? (PAID_TOOL_RE.test(description) ? PREMIUM_READ_TOOL : READ_TOOL);
  const wrapped = (async (args: unknown, extra: unknown) => {
    try {
      const result = await (cb as (a: unknown, e: unknown) => unknown)(args, extra);
      return sanitizeToolResponse(result as Parameters<typeof sanitizeToolResponse>[0]);
    } catch (err) {
      // The error path used to bypass the sanitizer entirely: a thrown
      // Error's message (which can embed an upstream response body via
      // fetchJSON) went to the SDK raw. Convert every throw into a
      // sanitized MCP tool error instead: secrets redacted (the live
      // bearer token, plus anything token-shaped), the standard
      // control-char and role-token scrub applied, and the text capped,
      // so the error channel offers no unsanitized path into the host
      // LLM's context.
      const raw = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: sanitizeErrorText(raw, [process.env.TENSORFEED_TOKEN]) }],
        isError: true,
      };
    }
  }) as ToolCallback<Args>;
  // Direct dispatch to the SDK's underlying registration. Do not call
  // registerTool() here or it will recurse forever.
  return server.tool(name, description, paramsSchema, finalAnnotations, wrapped);
}

// ── Resource: tensorfeed://news (latest 20 AI articles) ─────────────
// MCP's `resources` primitive is a parallel surface to tools. Hosts can
// list resources, subscribe to them, and fetch them by URI without going
// through the tool-call decision loop. We expose the latest news as a
// resource AS WELL AS the get_ai_news tool, so clients that prefer
// data-shaped surfaces (Claude Desktop, some agent frameworks) can attach
// the news feed directly. Same upstream endpoint; different MCP primitive.

server.registerResource(
  'latest_news',
  'tensorfeed://news/latest',
  {
    description:
      'Latest 20 AI news articles aggregated by TensorFeed.ai. Refreshed every ~10 minutes from 15+ sources (Anthropic, OpenAI, Google, TechCrunch, The Verge, arXiv, and more). Each row carries title, source, URL, snippet, categories, and publication timestamp. JSON payload. Refresh on `resources/read`; no subscription required.',
    mimeType: 'application/json',
  },
  async (uri) => {
    const data = (await fetchJSON('/news?limit=20')) as {
      articles: {
        title: string;
        url: string;
        source: string;
        snippet: string;
        categories: string[];
        publishedAt: string;
      }[];
    };
    // This resource is registered directly on the SDK, NOT through the
    // registerTool wrapper, so its payload does not pass through
    // sanitizeToolResponse. Scrub the external RSS title/snippet/source
    // fields here so untrusted article text gets the same role-confusion
    // and control-char scrub every tool output gets.
    const articles = data.articles.map((a) => ({
      ...a,
      title: sanitizeForLLM(a.title),
      snippet: sanitizeForLLM(a.snippet),
      source: sanitizeForLLM(a.source),
    }));
    return {
      contents: [
        {
          uri: uri.toString(),
          mimeType: 'application/json',
          text: JSON.stringify(
            {
              source: 'TensorFeed.ai',
              fetched_at: new Date().toISOString(),
              count: articles.length,
              articles,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// ── Tool: get_ai_news ───────────────────────────────────────────────

registerTool(
  'get_ai_news',
  'Get the latest AI news from TensorFeed.ai as a ranked list with title, source, URL, snippet, and publish time, filterable by category (e.g. "anthropic", "openai", "research", "tools"). Aggregates 15+ sources (Anthropic, OpenAI, Google, TechCrunch, The Verge, arXiv, and more) into one normalized feed, so an agent reads one schema instead of polling each outlet. Free, no auth.',
  {
    category: z.string().max(100).optional().describe('Filter by category (e.g. "anthropic", "openai", "research", "tools")'),
    limit: z.number().min(1).max(50).optional().describe('Number of articles to return (default 10, max 50)'),
    digest: z.boolean().optional().describe('When true, return a headline-only digest (title, source, URL per story) instead of the full article set.'),
  },
  async ({ category, limit, digest }) => {
    // digest mode is a headline-only companion view of the same feed. It honors
    // the same inputs as the full view: the category filter and the schema limit
    // (default 5, max 50). Earlier this branch dropped category and capped at 20,
    // silently ignoring declared params.
    if (digest) {
      const dParams = new URLSearchParams();
      if (category) dParams.set('category', category);
      dParams.set('limit', String(limit || 5));
      const data = await fetchJSON(`/news?${dParams}`) as {
        articles: { title: string; url: string; source: string; publishedAt: string }[];
      };

      const text = data.articles
        .map((a, i) => `${i + 1}. ${a.title} (${a.source})\n   ${a.url}`)
        .join('\n\n');

      return { content: [{ type: 'text' as const, text: `Today in AI:\n\n${text}` }] };
    }

    const params = new URLSearchParams();
    if (category) params.set('category', category);
    params.set('limit', String(limit || 10));

    const data = await fetchJSON(`/news?${params}`) as {
      articles: { title: string; url: string; source: string; snippet: string; categories: string[]; publishedAt: string }[];
    };

    const text = data.articles
      .map((a, i) => `${i + 1}. ${a.title}\n   Source: ${a.source}\n   URL: ${a.url}\n   ${a.snippet ? a.snippet + '\n   ' : ''}Published: ${a.publishedAt}`)
      .join('\n\n');

    return { content: [{ type: 'text' as const, text: text || 'No articles found.' }] };
  }
);

// ── Tool: find_tensorfeed_data (discovery, long-tail surface) ───────

registerTool(
  'find_tensorfeed_data',
  'Discover which TensorFeed endpoint answers a data need. Describe what you want in plain language (e.g. "trending AI papers", "is OpenAI down", "model price history") and this returns the 2 to 3 best-matching TensorFeed endpoints, each with its HTTP path, what it returns, and whether it is free or paid. TensorFeed exposes 100+ AI-ecosystem data and signed-verdict endpoints; the core ones are also dedicated tools, but the full catalog is reachable here and callable over HTTP (paid ones via x402 or a credits token). Free, no auth. Use this first when no dedicated tool obviously fits.',
  {
    query: z.string().max(500).describe('Plain-language description of the data or decision you need.'),
    limit: z.number().int().min(1).max(5).optional().describe('Max endpoints to return (default 3).'),
  },
  async ({ query, limit }) => {
    const { flattenCatalog, scoreEndpoints } = await import('./discovery.js');
    let meta: unknown;
    try {
      meta = await fetchJSON('/meta');
    } catch {
      const { readFileSync } = await import('node:fs');
      const p = join(dirname(fileURLToPath(import.meta.url)), 'meta-snapshot.json');
      meta = JSON.parse(readFileSync(p, 'utf-8'));
    }
    const rows = flattenCatalog(meta);
    const top = scoreEndpoints(rows, query, limit ?? 3);
    if (top.length === 0) {
      return { content: [{ type: 'text' as const, text: `No TensorFeed endpoint matched "${sanitizeReflectedValue(query)}". Browse the full catalog at https://tensorfeed.ai/api/meta or https://tensorfeed.ai/developers.` }] };
    }
    const lines = top.map((r) => `- ${r.path}\n  ${r.description}`).join('\n');
    return { content: [{ type: 'text' as const, text: `Top TensorFeed endpoints for "${sanitizeReflectedValue(query)}":\n${lines}\n\nCall free endpoints directly over HTTP. Paid endpoints (marked with a credit cost) accept x402 payment or a TENSORFEED_TOKEN bearer; see https://tensorfeed.ai/developers/agent-payments.` }] };
  },
);

// ── Tool: get_ai_status ─────────────────────────────────────────────

registerTool(
  'get_ai_status',
  'Get the real-time operational status of major AI services (Claude, OpenAI, Gemini, Mistral, Cohere, Replicate, Hugging Face), including per-component breakdowns and an operational/degraded/down rollup per provider. One cross-provider status call instead of checking each vendor\'s status page, useful before an agent routes a request to a model that may be impaired. Free, no auth.',
  {},
  async () => {
    const data = await fetchJSON('/status') as {
      services: { name: string; provider: string; status: string; components: { name: string; status: string }[] }[];
    };

    const text = data.services
      .map(s => {
        const components = s.components.length > 0
          ? '\n' + s.components.map(c => `     ${c.name}: ${c.status}`).join('\n')
          : '';
        return `  ${s.status === 'operational' ? 'OK' : s.status.toUpperCase()} ${s.name} (${s.provider})${components}`;
      })
      .join('\n');

    return { content: [{ type: 'text' as const, text: `AI Service Status:\n${text}${ROUTE_VERDICT_FOOTER}` }] };
  }
);

// ── Tool: is_service_down ───────────────────────────────────────────

registerTool(
  'is_service_down',
  'Check whether one named AI service (e.g. "claude", "openai", "gemini", "mistral", "cohere", "hugging face", "replicate") is currently operational, degraded, or down, with its component-level breakdown. Matches on service or provider name and lists available services if there is no match, so an agent can gate a call on live status before sending traffic. Free, no auth.',
  {
    service: z.string().max(200).describe('Service name to check (e.g. "claude", "openai", "gemini", "mistral", "cohere", "hugging face", "replicate")'),
  },
  async ({ service }) => {
    const data = await fetchJSON('/status') as {
      services: { name: string; provider: string; status: string; components: { name: string; status: string }[] }[];
    };

    const match = data.services.find(s =>
      s.name.toLowerCase().includes(service.toLowerCase()) ||
      s.provider.toLowerCase().includes(service.toLowerCase())
    );

    if (!match) {
      return { content: [{ type: 'text' as const, text: `Service "${sanitizeReflectedValue(service)}" not found. Available services: ${data.services.map(s => s.name).join(', ')}` }] };
    }

    const statusEmoji = match.status === 'operational' ? 'OK' : match.status === 'degraded' ? 'DEGRADED' : 'DOWN';
    const components = match.components.length > 0
      ? '\nComponents:\n' + match.components.map(c => `  ${c.name}: ${c.status}`).join('\n')
      : '';

    return {
      content: [{
        type: 'text' as const,
        text: `${statusEmoji} ${match.name} (${match.provider}) is ${match.status}${components}\n\nIf it is degraded, failover_verdict ranks the best operational alternative to fail over to right now.`
      }]
    };
  }
);

// ── Tool: get_model_pricing ─────────────────────────────────────────

registerTool(
  'get_model_pricing',
  'Get AI model pricing across major providers (Anthropic, OpenAI, Google, Meta, Mistral, Cohere) in one normalized table: input and output price per 1M tokens, context window, and release date per model. One cross-provider comparison instead of scraping six pricing pages, so an agent can pick the cheapest model that fits its context and budget. Free, no auth.',
  {},
  async () => {
    const data = await fetchJSON('/models') as {
      providers: {
        name: string;
        models: { name: string; inputPrice: number; outputPrice: number; contextWindow: number; released: string; capabilities: string[] }[];
      }[];
    };

    const text = data.providers
      .map(p => {
        const models = p.models
          .map(m => {
            const input = m.inputPrice === 0 ? 'Free' : `$${m.inputPrice.toFixed(2)}`;
            const output = m.outputPrice === 0 ? 'Free' : `$${m.outputPrice.toFixed(2)}`;
            const ctx = m.contextWindow >= 1000000
              ? `${(m.contextWindow / 1000000).toFixed(0)}M`
              : `${(m.contextWindow / 1000).toFixed(0)}K`;
            return `    ${m.name}: Input ${input}, Output ${output}, Context ${ctx}, Released ${m.released}`;
          })
          .join('\n');
        return `  ${p.name}:\n${models}`;
      })
      .join('\n\n');

    return { content: [{ type: 'text' as const, text: `AI Model Pricing (per 1M tokens):\n\n${text}${ROUTE_VERDICT_FOOTER}` }] };
  }
);

// ════════════════════════════════════════════════════════════════════
// PREMIUM TOOLS (require TENSORFEED_TOKEN env var, paid in USDC on Base)
// ════════════════════════════════════════════════════════════════════

// ── Tool: account_status ────────────────────────────────────────────
// Merges the former get_account_balance and get_account_usage tools into
// one read. Both fetch calls and both output bodies are reused verbatim
// and concatenated into a single text response.

registerTool(
  'account_status',
  'Check the configured TensorFeed token: current credit balance plus recent per-endpoint usage (last 100 calls aggregated). Free, but requires TENSORFEED_TOKEN.',
  {},
  async () => {
    // Balance and usage are independent reads; fetch them in parallel so the
    // merged tool costs one round-trip of wall-clock time, not two.
    const [balance, usage] = (await Promise.all([
      fetchJSON('/payment/balance', { auth: true }),
      fetchJSON('/payment/usage', { auth: true }),
    ])) as [
      { balance: number; created: string; last_used: string; total_purchased: number },
      { total_calls: number; total_credits_spent: number; by_endpoint: Record<string, { calls: number; credits: number; last_seen: string }> },
    ];
    const balanceText = `Balance: ${balance.balance} credits\nTotal purchased: ${balance.total_purchased}\nCreated: ${balance.created}\nLast used: ${balance.last_used}`;
    let usageText: string;
    if (usage.total_calls === 0) {
      usageText = 'No premium API calls on this token yet.';
    } else {
      const rows = Object.entries(usage.by_endpoint)
        .sort(([, a], [, b]) => b.calls - a.calls)
        .map(([ep, info]) => `  ${ep}: ${info.calls} calls, ${info.credits} credits, last ${info.last_seen}`)
        .join('\n');
      usageText = `Total: ${usage.total_calls} calls, ${usage.total_credits_spent} credits\n\n${rows}`;
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: `${balanceText}\n\nUsage:\n${usageText}`,
        },
      ],
    };
  },
);

// ── Tool: route_verdict (tier: preview free / full 1 credit) ────────
// One tool, two tiers. tier='preview' (default) is the free taste of
// the signed routing decision: the single best model for a task or
// named model with the reasoning, no auth, rate-limited 10/IP/day by
// the worker. tier='full' burns 1 credit, adds ranked runners-up,
// constraint filters, and an AFTA-signed receipt over the exact inputs.

interface VerdictCandidatePayload {
  rank: number;
  model: { id: string; name: string; provider: string; openSource: boolean; contextWindow: number };
  pricing: { input: number; output: number; blended: number; currency: string; unit: string };
  quality: { task_score: number; trust_discounted: number; contamination_note: string | null };
  usage: { corroborated: boolean; rank: number | null; share_pct: number | null; trend: string | null };
  latency: { measured_p95_ms: number | null; source: string };
  operational: { ok: boolean | null; status: string; source: string };
  deprecation: { flagged: boolean; status: string | null; sunset_date: string | null };
  composite_score: number;
  why: string;
}

interface VerdictTrust {
  usage_corroborated: boolean;
  benchmark_contamination: string;
  operational_layer: string;
  latency_layer: string;
}

registerTool(
  'route_verdict',
  "TensorFeed's signed model-routing decision: the single best model for a task or named model, fused from live pricing, contamination-discounted benchmarks, real production usage, measured p95 latency, incident state, and deprecation flags, with the reasoning. tier='preview' (default) is free (10 calls per day per IP), top verdict only. tier='full' costs 1 credit ($0.02), adds ranked runners-up, constraint filters, and an AFTA-signed receipt you can audit, and needs a TENSORFEED_TOKEN. Get credits at tensorfeed.ai/developers/agent-payments.",
  {
    tier: z.enum(['preview', 'full']).optional().describe("'preview' (default, free) or 'full' (1 credit; adds runners-up, filters, signed receipt)."),
    task: z.enum(['code', 'reasoning', 'creative', 'general']).optional().describe('Task type to route for (code, reasoning, creative, general). Provide task or model.'),
    model: z.string().max(200).optional().describe('Model id or display name to narrow the verdict to one model (e.g. "Claude Opus 4.7" or "claude-opus-4-7"). Provide task or model.'),
    max_latency_p95_ms: z.number().optional().describe('Full tier only. Drop candidates whose measured p95 latency exceeds this value (ms).'),
    budget: z.number().optional().describe('Full tier only. Max blended USD per 1M tokens.'),
    min_quality: z.number().min(0).max(1).optional().describe('Full tier only. Minimum trust-discounted quality score in [0, 1].'),
    require_operational: z.boolean().optional().describe('Full tier only. Default true. Set false to keep candidates known down or in failover.'),
    exclude_deprecated: z.boolean().optional().describe('Full tier only. Default true. Set false to keep deprecated or sunsetted models.'),
  },
  async ({ tier, task, model, max_latency_p95_ms, budget, min_quality, require_operational, exclude_deprecated }) => {
    if (!task && !model) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Provide a task (code, reasoning, creative, general) or a model id/name to get a routing verdict.',
          },
        ],
      };
    }
    const params = new URLSearchParams();
    if (task) params.set('task', task);
    if (model) params.set('model', model);
    if ((tier ?? 'preview') === 'full') {
      if (typeof max_latency_p95_ms === 'number') params.set('max_latency_p95_ms', String(max_latency_p95_ms));
      if (typeof budget === 'number') params.set('budget', String(budget));
      if (typeof min_quality === 'number') params.set('min_quality', String(min_quality));
      if (typeof require_operational === 'boolean') params.set('require_operational', String(require_operational));
      if (typeof exclude_deprecated === 'boolean') params.set('exclude_deprecated', String(exclude_deprecated));
      const data = (await fetchJSON(`/premium/route-verdict?${params}`, { auth: true })) as {
        ok: boolean;
        query: { task: string | null; model: string | null };
        verdict: VerdictCandidatePayload | null;
        runners_up: VerdictCandidatePayload[];
        trust: VerdictTrust;
        filters_applied: { max_latency_p95_ms: number | null; require_operational: boolean; exclude_deprecated: boolean };
        claim: string;
        billing?: { credits_charged: number; credits_remaining?: number };
      };
      if (!data.verdict) {
        return {
          content: [{ type: 'text' as const, text: `No routing verdict matched your filters.\n${data.claim ?? ''}` }],
        };
      }
      const v = data.verdict;
      const t = data.trust;
      const f = data.filters_applied;
      const runners = (data.runners_up ?? [])
        .map((r) => `  #${r.rank} ${r.model.name} (${r.model.provider}) blended $${r.pricing.blended}/1M\n     ${r.why}`)
        .join('\n');
      const trustLine = `Trust: usage ${t.usage_corroborated ? 'corroborated' : 'uncorroborated'}, benchmark contamination ${t.benchmark_contamination}, operational ${t.operational_layer}, latency ${t.latency_layer}`;
      const filterLine = `Filters: max p95 ${f.max_latency_p95_ms ?? 'none'}ms, require_operational ${f.require_operational}, exclude_deprecated ${f.exclude_deprecated}`;
      const billing = data.billing
        ? `\n\nCharged ${data.billing.credits_charged} credit. Remaining: ${data.billing.credits_remaining}.`
        : '';
      return {
        content: [
          {
            type: 'text' as const,
            text:
              `Route Verdict: ${v.model.name} (${v.model.provider}) score ${v.composite_score}\n` +
              `Why: ${v.why}\n` +
              `Blended price: $${v.pricing.blended}/1M tokens (in $${v.pricing.input}, out $${v.pricing.output})\n\n` +
              `Runners-up:\n${runners || '  (none)'}\n\n` +
              `${trustLine}\n${filterLine}\n\nClaim: ${data.claim}${billing}`,
          },
        ],
      };
    }
    const data = (await fetchJSON(`/preview/route-verdict?${params}`)) as {
      ok: boolean;
      query: { task: string | null; model: string | null };
      verdict: VerdictCandidatePayload | null;
      trust: VerdictTrust;
      data_freshness: Record<string, string | null>;
      claim: string;
      rate_limit?: { limit: number; remaining: number; scope: string };
    };
    if (!data.verdict) {
      return {
        content: [{ type: 'text' as const, text: `No routing verdict available for that query.\n${data.claim ?? ''}` }],
      };
    }
    const v = data.verdict;
    const t = data.trust;
    const fresh = [
      data.data_freshness.pricing ? `pricing ${data.data_freshness.pricing}` : null,
      data.data_freshness.probe ? `latency ${data.data_freshness.probe}` : null,
      data.data_freshness.status ? `status ${data.data_freshness.status}` : null,
    ]
      .filter(Boolean)
      .join(', ');
    const trustLine = `Trust: usage ${t.usage_corroborated ? 'corroborated' : 'uncorroborated'}, benchmark contamination ${t.benchmark_contamination}, operational ${t.operational_layer}, latency ${t.latency_layer}`;
    const rl = data.rate_limit ? `\nPreview: ${data.rate_limit.remaining} of ${data.rate_limit.limit} calls left today (${data.rate_limit.scope}).` : '';
    return {
      content: [
        {
          type: 'text' as const,
          text:
            `Route Verdict: ${v.model.name} (${v.model.provider})\n` +
            `Why: ${v.why}\n` +
            `Blended price: $${v.pricing.blended}/1M tokens (in $${v.pricing.input}, out $${v.pricing.output})\n` +
            `${trustLine}${fresh ? `\nData freshness: ${fresh}` : ''}\n` +
            `Upgrade: route_verdict tier='full' (1 credit, $0.02) adds ranked runners-up, constraint filters, and an AFTA-signed receipt you can audit. No USDC yet? Sign a wallet message at tensorfeed.ai/api/payment/trial-credits for 25 free credits.${rl}`,
        },
      ],
    };
  },
);

// ════════════════════════════════════════════════════════════════════
// Verdict family: 7 signed decisions, each a single tier-parameterized
// tool. tier='preview' (default) calls fetchJSON('/preview/<x>') (no
// auth, 10 calls per IP per day); tier='full' calls
// fetchJSON('/premium/<x>', { auth: true }) and burns 1 credit. The
// shapes below mirror the worker builder result interfaces exactly.
// ════════════════════════════════════════════════════════════════════

// Shared upsell tail for the preview tools. Mirrors ROUTE_VERDICT_FOOTER
// cadence. `tool` is the matching premium tool, `adds` names what the
// paid tier adds over the free preview, `rl` is the optional remaining
// calls suffix.
function verdictUpsell(tool: string, adds: string, rl: string): string {
  return (
    `Upgrade: call ${tool} again with tier="full" (1 credit, $0.02) for ${adds} and an AFTA-signed receipt. ` +
    `No USDC yet? Sign a wallet message at tensorfeed.ai/api/payment/trial-credits for 25 free credits.${rl}`
  );
}

// Shared billing tail for the premium tools.
interface VerdictBilling {
  credits_charged: number;
  credits_remaining?: number;
  no_charge_reason?: string;
}
function verdictBilling(billing: VerdictBilling | undefined): string {
  return billing ? `\n\nCharged ${billing.credits_charged} credit. Remaining: ${billing.credits_remaining}.` : '';
}

interface VerdictRateLimit {
  limit: number;
  remaining: number;
  scope: string;
}
function previewRateLine(rate?: VerdictRateLimit): string {
  return rate ? ` Preview: ${rate.remaining} of ${rate.limit} calls left today.` : '';
}

// ── Tool: provider_reliability_verdict (preview free / full 1 credit) ─

interface ReliabilityRankEntryPayload {
  rank: number;
  provider: string;
  ok_pct: number;
  total_p50_ms: number | null;
  total_p95_ms: number | null;
  total_p99_ms: number | null;
  spread_ratio: number | null;
  reliability_score: number;
  measured: boolean;
  note: string;
}

registerTool(
  'provider_reliability_verdict',
  "TensorFeed's signed dependability ruling over its OWN measured latency and availability probes of the frontier AI providers: the single most-dependable provider to build on and the riskiest, scoring availability and tail consistency (p50 over p95) equally because an agent retry loop feels the tail, not the median. tier='preview' (default) is free (10 calls per day per IP), top verdict only. tier='full' costs 1 credit ($0.02), adds the full per-provider ranking with measured availability and p50/p95/p99 and tail spread plus an AFTA-signed receipt, and needs a TENSORFEED_TOKEN. Get credits at tensorfeed.ai/developers/agent-payments.",
  {
    tier: z.enum(['preview', 'full']).optional().describe("'preview' (default, free) or 'full' (1 credit; adds the full per-provider ranking and signed receipt)."),
  },
  async ({ tier }) => {
    if ((tier ?? 'preview') === 'full') {
      const data = (await fetchJSON('/premium/provider-reliability-verdict', { auth: true })) as {
        ok: boolean;
        verdict: { most_dependable: string | null; riskiest: string | null };
        ranking: ReliabilityRankEntryPayload[];
        coverage: { providers_ranked: number; fully_measured: number; availability_only: number };
        captured_at?: string | null;
        capturedAt?: string | null;
        claim: string;
        billing?: VerdictBilling;
      };
      const v = data.verdict;
      if (!v || !v.most_dependable) {
        return { content: [{ type: 'text' as const, text: `No reliability verdict available right now.\n${data.claim ?? ''}` }] };
      }
      const ranking = (data.ranking ?? [])
        .map((r) => `  #${r.rank} ${r.provider}: ${r.note}`)
        .join('\n');
      return {
        content: [
          {
            type: 'text' as const,
            text:
              `Provider Reliability Verdict: most dependable ${v.most_dependable}` +
              (v.riskiest ? `, riskiest ${v.riskiest}` : '') +
              '\n\n' +
              `Ranking:\n${ranking || '  (none)'}\n\n` +
              `Claim: ${data.claim}` +
              verdictBilling(data.billing),
          },
        ],
      };
    }
    const data = (await fetchJSON('/preview/provider-reliability-verdict')) as {
      ok: boolean;
      verdict: { most_dependable: string | null; riskiest: string | null };
      coverage: { providers_ranked: number; fully_measured: number; availability_only: number };
      captured_at: string | null;
      claim: string;
      rate_limit?: VerdictRateLimit;
    };
    const v = data.verdict;
    if (!v || !v.most_dependable) {
      return { content: [{ type: 'text' as const, text: `No reliability verdict available right now.\n${data.claim ?? ''}` }] };
    }
    const cov = data.coverage;
    const rl = previewRateLine(data.rate_limit);
    return {
      content: [
        {
          type: 'text' as const,
          text:
            `Provider Reliability Verdict: most dependable ${v.most_dependable}` +
            (v.riskiest ? `, riskiest ${v.riskiest}` : '') +
            '\n' +
            `Claim: ${data.claim}\n` +
            `Coverage: ${cov.providers_ranked} providers ranked (${cov.fully_measured} fully measured, ${cov.availability_only} availability only)` +
            (data.captured_at ? `, captured ${data.captured_at}` : '') +
            '\n' +
            verdictUpsell('provider_reliability_verdict', 'the full per-provider ranking with availability, tail spread, and measured p50/p95/p99', rl),
        },
      ],
    };
  },
);

// ── Tool: x402_settlement_verdict (preview free / full 1 credit) ─────

interface X402PublisherRankEntryPayload {
  rank: number;
  domain: string;
  volume_usdc: string;
  count: number;
  share_pct: number;
}

registerTool(
  'x402_settlement_verdict',
  "TensorFeed's signed ruling on the state of the x402 USDC settlement market on Base, computed over its OWN on-chain settlement index: market momentum versus the prior window of equal length, concentration, and the leading publisher. Covers the publishers TensorFeed indexes on Base, forward-only from launch. tier='preview' (default) is free (10 calls per day per IP), headline verdict only. tier='full' costs 1 credit ($0.02), adds the full per-publisher ranking with volume share, ecosystem totals, the Herfindahl concentration index, an optional window, and an AFTA-signed receipt, and needs a TENSORFEED_TOKEN. Get credits at tensorfeed.ai/developers/agent-payments.",
  {
    tier: z.enum(['preview', 'full']).optional().describe("'preview' (default, free) or 'full' (1 credit; adds per-publisher ranking, totals, window, signed receipt)."),
    window: z.enum(['24h', '7d', '30d']).optional().describe('Full tier only. Settlement window to rule over (24h, 7d, 30d). Default 7d.'),
  },
  async ({ tier, window }) => {
    if ((tier ?? 'preview') === 'full') {
      const params = new URLSearchParams();
      if (window) params.set('window', window);
      const qs = params.toString();
      const data = (await fetchJSON(`/premium/x402-settlement-verdict${qs ? `?${qs}` : ''}`, { auth: true })) as {
        ok: boolean;
        verdict: { momentum: string; concentration: string; leading_publisher: string | null };
        window_label: string | null;
        ecosystem: {
          volume_usdc: string;
          count: number;
          unique_publishers: number;
          top_publisher_share_pct: number | null;
          hhi: number | null;
        };
        ranking: X402PublisherRankEntryPayload[];
        claim: string;
        billing?: VerdictBilling;
      };
      const v = data.verdict;
      const e = data.ecosystem;
      const ranking = (data.ranking ?? [])
        .map((r) => `  #${r.rank} ${r.domain}: ${r.volume_usdc} USDC over ${r.count} settlements (${r.share_pct}% share)`)
        .join('\n');
      return {
        content: [
          {
            type: 'text' as const,
            text:
              `x402 Settlement Verdict (${data.window_label ?? '7d'}): momentum ${v.momentum}, concentration ${v.concentration}` +
              (v.leading_publisher ? `, leading publisher ${v.leading_publisher}` : ', no leading publisher this window') +
              '\n' +
              `Ecosystem: ${e.volume_usdc} USDC over ${e.count} settlements across ${e.unique_publishers} publishers` +
              (e.top_publisher_share_pct !== null ? `, top share ${e.top_publisher_share_pct}%` : '') +
              (e.hhi !== null ? `, HHI ${e.hhi}` : '') +
              '\n\n' +
              `Ranking:\n${ranking || '  (none)'}\n\n` +
              `Claim: ${data.claim}` +
              verdictBilling(data.billing),
          },
        ],
      };
    }
    const data = (await fetchJSON('/preview/x402-settlement-verdict')) as {
      ok: boolean;
      verdict: { momentum: string; concentration: string; leading_publisher: string | null };
      window_label: string | null;
      captured_at: string | null;
      claim: string;
      rate_limit?: VerdictRateLimit;
    };
    const v = data.verdict;
    const rl = previewRateLine(data.rate_limit);
    return {
      content: [
        {
          type: 'text' as const,
          text:
            `x402 Settlement Verdict (${data.window_label ?? '7d'}): momentum ${v.momentum}, concentration ${v.concentration}` +
            (v.leading_publisher ? `, leading publisher ${v.leading_publisher}` : ', no leading publisher this window') +
            '\n' +
            `Claim: ${data.claim}` +
            (data.captured_at ? `\nIndex captured ${data.captured_at}` : '') +
            '\n' +
            verdictUpsell(
              'x402_settlement_verdict',
              'the full per-publisher ranking, ecosystem volume and count totals, the Herfindahl concentration index, and an optional 24h/7d/30d window',
              rl,
            ),
        },
      ],
    };
  },
);

// ── Tool: x402_publisher_verdict (preview free / full 1 credit) ──────

registerTool(
  'x402_publisher_verdict',
  "TensorFeed's signed trust verdict on one x402 publisher, over its OWN on-chain settlement index: whether a named publisher domain is actively settling, recently quiet, registered with no settlement, unreachable, missing a Base payTo, or not indexed. Requires a domain. tier='preview' (default) is free (10 calls per day per IP), the trust verdict only. tier='full' costs 1 credit ($0.02), adds the 30-day settlement momentum, the shared-wallet risk flag, the settlement evidence (volume, count, last settled), and an AFTA-signed receipt, and needs a TENSORFEED_TOKEN. Get credits at tensorfeed.ai/developers/agent-payments.",
  {
    tier: z.enum(['preview', 'full']).optional().describe("'preview' (default, free) or 'full' (1 credit; adds momentum, shared-wallet flag, evidence, signed receipt)."),
    domain: z.string().max(253).describe('Publisher domain to rule on, e.g. "x402.tavily.com". Required.'),
  },
  async ({ tier, domain }) => {
    if (!domain || !domain.trim()) {
      return { content: [{ type: 'text' as const, text: 'Provide a publisher domain (e.g. domain "x402.tavily.com") to get a trust verdict.' }] };
    }
    const params = new URLSearchParams({ domain: domain.trim() });
    if ((tier ?? 'preview') === 'full') {
      const data = (await fetchJSON(`/premium/x402-publisher-verdict?${params}`, { auth: true })) as {
        ok: boolean;
        domain: string;
        verdict: string;
        momentum: string;
        trust: { wallet_shared: boolean; last_settled: string | null; pay_to_wallets: string[] };
        evidence: { window_days: number; volume_usdc: string; count: number };
        claim: string;
        billing?: VerdictBilling;
      };
      const t = data.trust;
      const ev = data.evidence;
      return {
        content: [
          {
            type: 'text' as const,
            text:
              `x402 Publisher Verdict for ${sanitizeReflectedValue(data.domain)}: ${data.verdict}\n` +
              `Momentum: ${data.momentum}. Shared wallet: ${t.wallet_shared ? 'yes (risk flag)' : 'no'}` +
              (t.last_settled ? `. Last settled ${t.last_settled}` : '') +
              '\n' +
              `Evidence (${ev.window_days}d): ${ev.volume_usdc} USDC over ${ev.count} settlements\n` +
              `Claim: ${data.claim}` +
              verdictBilling(data.billing),
          },
        ],
      };
    }
    const data = (await fetchJSON(`/preview/x402-publisher-verdict?${params}`)) as {
      ok: boolean;
      domain: string;
      verdict: string;
      claim: string;
      captured_at: string | null;
      rate_limit?: VerdictRateLimit;
    };
    const rl = previewRateLine(data.rate_limit);
    return {
      content: [
        {
          type: 'text' as const,
          text:
            `x402 Publisher Verdict for ${sanitizeReflectedValue(data.domain)}: ${data.verdict}\n` +
            `Claim: ${data.claim}` +
            (data.captured_at ? `\nIndex captured ${data.captured_at}` : '') +
            '\n' +
            verdictUpsell(
              'x402_publisher_verdict',
              'the 30-day settlement momentum, the shared-wallet risk flag, and the settlement evidence (volume, count, daily series)',
              rl,
            ),
        },
      ],
    };
  },
);

// ── Tool: stack_safety_verdict (preview free / full 1 credit) ────────

interface StackPackageSlim {
  package: string;
  version: string | null;
  verdict: string;
  exploited: boolean;
  fix_available: boolean;
  reason: string;
  matched_cve_count: number;
}

interface MatchedCvePayload {
  cve_id: string;
  on_kev: boolean;
  severity_label: string;
  affected_version_ranges: string[];
  fixed_versions: string[];
}
interface StackPackageFull {
  package: string;
  version: string | null;
  verdict: string;
  exploited: boolean;
  fix_available: boolean;
  matched_cves: MatchedCvePayload[];
  reason: string;
}

registerTool(
  'stack_safety_verdict',
  "TensorFeed's deploy gate for an AI software stack: pass each package as comma-separated name@version and get the overall BLOCK / HOLD / PASS / UNKNOWN gate plus a per-package verdict, fusing the ingested AI-stack CVE batch with the CISA KEV catalog. Conservative by design: BLOCK only on an exploited CVE with no fix, HOLD when a known CVE applies and you must verify your version, PASS on no match, UNKNOWN outside the curated AI-stack cohort. tier='preview' (default) is free (10 calls per day per IP), caps at 3 packages, gate plus worst offender. tier='full' costs 1 credit ($0.02), raises the cap to 10 packages, adds the matched-CVE evidence (ids, affected ranges, fixed versions, KEV status) and an AFTA-signed receipt, and needs a TENSORFEED_TOKEN. Get credits at tensorfeed.ai/developers/agent-payments.",
  {
    tier: z.enum(['preview', 'full']).optional().describe("'preview' (default, free, caps at 3 packages) or 'full' (1 credit; up to 10 packages, matched-CVE evidence, signed receipt)."),
    packages: z.string().max(1000).describe('Comma-separated AI-stack packages as name@version (e.g. "vllm@0.5.0,transformers@4.40.0"). Required. Preview caps at 3, full up to 10.'),
  },
  async ({ tier, packages }) => {
    if (!packages || !packages.trim()) {
      return { content: [{ type: 'text' as const, text: 'Provide packages as a comma-separated name@version list (e.g. "vllm@0.5.0,transformers@4.40.0") to get a deploy gate.' }] };
    }
    const params = new URLSearchParams({ packages: packages.trim() });
    if ((tier ?? 'preview') === 'full') {
      const data = (await fetchJSON(`/premium/stack-safety-verdict?${params}`, { auth: true })) as {
        ok: boolean;
        gate: string;
        counts: { block: number; hold: number; pass: number; unknown: number };
        packages: StackPackageFull[];
        claim: string;
        billing?: VerdictBilling;
      };
      const c = data.counts;
      const lines = (data.packages ?? [])
        .map((p) => {
          const cves = p.matched_cves
            .map((m) => `${m.cve_id}${m.on_kev ? ' (KEV)' : ''} ${m.severity_label}`)
            .join('; ');
          return `  ${p.package}${p.version ? `@${p.version}` : ''}: ${p.verdict}. ${p.reason}` + (cves ? `\n     CVEs: ${cves}` : '');
        })
        .join('\n');
      return {
        content: [
          {
            type: 'text' as const,
            text:
              `Stack Safety Verdict: gate ${data.gate}\n` +
              `Counts: ${c.block} block, ${c.hold} hold, ${c.pass} pass, ${c.unknown} unknown\n\n` +
              `${lines || '  (no packages)'}\n\n` +
              `Claim: ${data.claim}` +
              verdictBilling(data.billing),
          },
        ],
      };
    }
    const data = (await fetchJSON(`/preview/stack-safety-verdict?${params}`)) as {
      ok: boolean;
      gate: string;
      counts: { block: number; hold: number; pass: number; unknown: number };
      packages: StackPackageSlim[];
      claim: string;
      rate_limit?: VerdictRateLimit;
    };
    const c = data.counts;
    const worst = (data.packages ?? []).find((p) => p.verdict === 'BLOCK') ?? (data.packages ?? []).find((p) => p.verdict === 'HOLD') ?? null;
    const worstLine = worst
      ? `Worst offender: ${worst.package}${worst.version ? `@${worst.version}` : ''} ${worst.verdict} (${worst.matched_cve_count} matched CVE${worst.matched_cve_count === 1 ? '' : 's'}). ${worst.reason}`
      : 'No package hit a BLOCK or HOLD.';
    const rl = previewRateLine(data.rate_limit);
    return {
      content: [
        {
          type: 'text' as const,
          text:
            `Stack Safety Verdict: gate ${data.gate}\n` +
            `Counts: ${c.block} block, ${c.hold} hold, ${c.pass} pass, ${c.unknown} unknown\n` +
            `${worstLine}\n` +
            `Claim: ${data.claim}\n` +
            verdictUpsell('stack_safety_verdict', 'the matched-CVE evidence (ids, affected ranges, fixed versions, KEV status) and up to 10 packages', rl),
        },
      ],
    };
  },
);

// ── Tool: benchmark_trust_verdict (preview free / full 1 credit) ─────

interface BenchmarkVerdictSlim {
  id: string;
  name: string;
  category: string;
  trust_band: string;
  trust_score: number;
}

interface BenchmarkVerdictFull {
  id: string;
  name: string;
  category: string;
  trust_band: string;
  trust_score: number;
  signals: { ceiling_proximity: string; frontier_compression: string };
  recommendation: string;
}

registerTool(
  'benchmark_trust_verdict',
  "TensorFeed's signed ruling on whether an AI benchmark is still a trustworthy capability signal or saturated, contaminated, or near ceiling so a high score should be down-weighted: a trust band (reliable, use_with_caution, saturated, contaminated, deprecated) and a 0-100 trust score per benchmark. Pass benchmark to narrow to one, or category to filter, or neither for the registry. tier='preview' (default) is free (10 calls per day per IP), top verdict and bands only. tier='full' costs 1 credit ($0.02), adds the per-signal detail (ceiling proximity, frontier compression, contamination), a down-weight recommendation with an alternative benchmark, and an AFTA-signed receipt, and needs a TENSORFEED_TOKEN. Get credits at tensorfeed.ai/developers/agent-payments.",
  {
    tier: z.enum(['preview', 'full']).optional().describe("'preview' (default, free) or 'full' (1 credit; adds per-signal detail, recommendation, signed receipt)."),
    benchmark: z.string().max(200).optional().describe('Benchmark registry id or name to narrow to one (e.g. "mmlu", "swe-bench"). Optional.'),
    category: z.string().max(100).optional().describe('Category to filter the benchmarks (e.g. "coding", "reasoning"). Optional.'),
  },
  async ({ tier, benchmark, category }) => {
    const params = new URLSearchParams();
    if (benchmark) params.set('benchmark', benchmark);
    if (category) params.set('category', category);
    const qs = params.toString();
    if ((tier ?? 'preview') === 'full') {
      const data = (await fetchJSON(`/premium/benchmark-trust-verdict${qs ? `?${qs}` : ''}`, { auth: true })) as {
        ok: boolean;
        filter: { benchmark: string | null; category: string | null };
        count: number;
        verdicts: BenchmarkVerdictFull[];
        claim: string;
        billing?: VerdictBilling;
      };
      const verdicts = data.verdicts ?? [];
      if (verdicts.length === 0) {
        return { content: [{ type: 'text' as const, text: `No benchmark matched that filter.\n${data.claim ?? ''}` }] };
      }
      const lines = verdicts
        .slice(0, 8)
        .map(
          (v) =>
            `  ${v.name} (${v.category}): ${v.trust_band}, score ${v.trust_score}/100. Ceiling ${v.signals.ceiling_proximity}, frontier ${v.signals.frontier_compression}.\n     ${v.recommendation}`,
        )
        .join('\n');
      return {
        content: [
          {
            type: 'text' as const,
            text:
              `Benchmark Trust Verdict: ${data.count} benchmark${data.count === 1 ? '' : 's'} ruled on\n\n` +
              `${lines}\n\n` +
              `Claim: ${data.claim}` +
              verdictBilling(data.billing),
          },
        ],
      };
    }
    const data = (await fetchJSON(`/preview/benchmark-trust-verdict${qs ? `?${qs}` : ''}`)) as {
      ok: boolean;
      filter: { benchmark: string | null; category: string | null };
      count: number;
      verdicts: BenchmarkVerdictSlim[];
      claim: string;
      rate_limit?: VerdictRateLimit;
    };
    const verdicts = data.verdicts ?? [];
    if (verdicts.length === 0) {
      return { content: [{ type: 'text' as const, text: `No benchmark matched that filter.\n${data.claim ?? ''}` }] };
    }
    const top = verdicts[0];
    const list = verdicts
      .slice(0, 3)
      .map((v) => `  ${v.name} (${v.category}): ${v.trust_band}, score ${v.trust_score}/100`)
      .join('\n');
    const rl = previewRateLine(data.rate_limit);
    return {
      content: [
        {
          type: 'text' as const,
          text:
            `Benchmark Trust Verdict: ${top.name} is ${top.trust_band} (trust score ${top.trust_score}/100)\n` +
            (data.count > 1 ? `${data.count} benchmarks ruled on. Top:\n${list}\n` : `${list}\n`) +
            `Claim: ${data.claim}\n` +
            verdictUpsell(
              'benchmark_trust_verdict',
              'the per-signal detail (ceiling proximity, frontier compression, contamination, status) and the down-weight recommendation with an alternative benchmark',
              rl,
            ),
        },
      ],
    };
  },
);

// ── Tool: failover_verdict (preview free / full 1 credit) ────────────

interface FailoverCandidateSlim {
  model: { id: string; name: string; provider: string };
  operational: { ok: boolean | null; status: string };
  composite_score: number;
}

interface FailoverCandidateFull {
  rank: number;
  model: { id: string; name: string; provider: string };
  pricing: { blended: number };
  latency: { measured_p95_ms: number | null };
  operational: { ok: boolean | null; status: string };
  composite_score: number;
  why: string;
}

registerTool(
  'failover_verdict',
  "Provider A is degraded; TensorFeed's signed ruling on the single best operational provider to fail over to for a task right now. Confirms A against the live incident-triage feed, then runs the route-verdict fusion with A (and any provider already in failover) excluded. Requires from. tier='preview' (default) is free (10 calls per day per IP), the failover target only. tier='full' costs 1 credit ($0.02), adds the full candidate (pricing, measured p95 latency, quality), the ranked alternatives, the confirmed incident on A, and an AFTA-signed receipt, and needs a TENSORFEED_TOKEN. Get credits at tensorfeed.ai/developers/agent-payments.",
  {
    tier: z.enum(['preview', 'full']).optional().describe("'preview' (default, free) or 'full' (1 credit; adds candidate detail, ranked alternatives, incident, signed receipt)."),
    from: z.string().max(200).describe('The degraded provider to fail over FROM (e.g. "anthropic", "openai"). Required.'),
    task: z.enum(['code', 'reasoning', 'creative', 'general']).optional().describe('Task type to optimize the failover target for. Optional.'),
  },
  async ({ tier, from, task }) => {
    if (!from || !from.trim()) {
      return { content: [{ type: 'text' as const, text: 'Provide a from provider (the degraded provider to fail over from, e.g. from "anthropic") to get a failover verdict.' }] };
    }
    const params = new URLSearchParams({ from: from.trim() });
    if (task) params.set('task', task);
    if ((tier ?? 'preview') === 'full') {
      const data = (await fetchJSON(`/premium/failover-verdict?${params}`, { auth: true })) as {
        ok: boolean;
        from: { provider: string; in_incident: boolean; incident: { title: string; recommended_action: string } | null };
        query: { task: string | null; model: string | null };
        excluded_providers: string[];
        failover_to: FailoverCandidateFull | null;
        alternatives: FailoverCandidateFull[];
        why: string;
        claim: string;
        billing?: VerdictBilling;
      };
      const dest = data.failover_to;
      const fromProvider = sanitizeReflectedValue(data.from.provider);
      const incidentLine = data.from.incident
        ? `Incident on ${fromProvider}: ${data.from.incident.title} (action ${data.from.incident.recommended_action})\n`
        : '';
      if (!dest) {
        return {
          content: [
            {
              type: 'text' as const,
              text:
                `Failover Verdict from ${fromProvider}: no operational failover target found.\n` +
                incidentLine +
                `Why: ${data.why}\nClaim: ${data.claim}` +
                verdictBilling(data.billing),
            },
          ],
        };
      }
      const alts = (data.alternatives ?? [])
        .map(
          (a) =>
            `  #${a.rank} ${a.model.name} (${a.model.provider}) blended $${a.pricing.blended}/1M, p95 ${a.latency.measured_p95_ms ?? 'n/a'}ms, status ${a.operational.status}`,
        )
        .join('\n');
      return {
        content: [
          {
            type: 'text' as const,
            text:
              `Failover Verdict from ${fromProvider}: fail over to ${dest.model.name} (${dest.model.provider})\n` +
              `Why: ${dest.why}\n` +
              `Blended $${dest.pricing.blended}/1M, p95 ${dest.latency.measured_p95_ms ?? 'n/a'}ms, status ${dest.operational.status}\n` +
              incidentLine +
              `Excluded: ${data.excluded_providers.length ? data.excluded_providers.join(', ') : 'none'}\n\n` +
              `Alternatives:\n${alts || '  (none)'}\n\n` +
              `Claim: ${data.claim}` +
              verdictBilling(data.billing),
          },
        ],
      };
    }
    const data = (await fetchJSON(`/preview/failover-verdict?${params}`)) as {
      ok: boolean;
      from: { provider: string; in_incident: boolean };
      query: { task: string | null; model: string | null };
      excluded_providers: string[];
      failover_to: FailoverCandidateSlim | null;
      why: string;
      claim: string;
      rate_limit?: VerdictRateLimit;
    };
    const dest = data.failover_to;
    const fromProvider = sanitizeReflectedValue(data.from.provider);
    const rl = previewRateLine(data.rate_limit);
    if (!dest) {
      return {
        content: [
          {
            type: 'text' as const,
            text:
              `Failover Verdict from ${fromProvider}: no operational failover target found.\n` +
              `Why: ${data.why}\n${data.claim}\n` +
              verdictUpsell('failover_verdict', 'the full failover candidate (pricing, measured latency, quality) and the ranked alternatives', rl),
          },
        ],
      };
    }
    return {
      content: [
        {
          type: 'text' as const,
          text:
            `Failover Verdict from ${fromProvider}` +
            (data.from.in_incident ? ' (confirmed in incident)' : '') +
            `: fail over to ${dest.model.name} (${dest.model.provider})\n` +
            `Why: ${data.why}\n` +
            `Excluded: ${data.excluded_providers.length ? data.excluded_providers.join(', ') : 'none'}\n` +
            `Claim: ${data.claim}\n` +
            verdictUpsell('failover_verdict', 'the full failover candidate (pricing, measured latency, quality) and the ranked alternatives', rl),
        },
      ],
    };
  },
);

// ── Tool: ssvc_verdict (preview free / full 1 credit) ────────────────

registerTool(
  'ssvc_verdict',
  "TensorFeed's signed SSVC patch-urgency decision for one CVE, applying the CISA SSVC Coordinator decision tree to the recorded Vulnrichment decision points (exploitation, automatable, technical impact). Requires a CVE id. tier='preview' (default) is free (10 calls per day per IP): the three decision points and the decision-tree provenance, WITHOUT the computed Act / Attend / Track / Track* decision. tier='full' costs 1 credit ($0.02), adds the computed decision across the full low/medium/high Mission and Well-being envelope, the per-level reasoning, a live CISA KEV cross-check, and an AFTA-signed receipt, and needs a TENSORFEED_TOKEN. Get credits at tensorfeed.ai/developers/agent-payments.",
  {
    tier: z.enum(['preview', 'full']).optional().describe("'preview' (default, free) or 'full' (1 credit; adds the computed decision, envelope, reasoning, KEV cross-check, signed receipt)."),
    cve: z.string().max(64).describe('CVE id to rule on, e.g. "CVE-2024-3094". Required.'),
  },
  async ({ tier, cve }) => {
    if (!cve || !cve.trim()) {
      return { content: [{ type: 'text' as const, text: 'Provide a CVE id (e.g. cve "CVE-2024-3094") to get the SSVC decision points.' }] };
    }
    const params = new URLSearchParams({ cve: cve.trim() });
    if ((tier ?? 'preview') === 'full') {
      const data = (await fetchJSON(`/premium/security/ssvc-verdict?${params}`, { auth: true })) as {
        cve: string;
        decision_points: { exploitation: string; automatable: string; technical_impact: string };
        decision_primary: string;
        decision_envelope: { low: string; medium: string; high: string };
        tree: { name: string; version: string };
        kev_cross_check?: { checked: boolean; kev_listed?: boolean; flag?: string };
        scored_at: string;
        billing?: VerdictBilling;
      };
      const dp = data.decision_points;
      const env = data.decision_envelope;
      const kev = data.kev_cross_check;
      const kevLine = kev && kev.checked
        ? `KEV cross-check: ${kev.kev_listed ? 'listed on CISA KEV' : 'not on KEV'}${kev.flag && kev.flag !== 'none' ? ` (${kev.flag})` : ''}`
        : 'KEV cross-check: unavailable';
      return {
        content: [
          {
            type: 'text' as const,
            text:
              `SSVC Verdict for ${sanitizeReflectedValue(data.cve)}: ${data.decision_primary} (Mission and Well-being assumed medium)\n` +
              `Envelope: low ${env.low}, medium ${env.medium}, high ${env.high}\n` +
              `Decision points: exploitation ${dp.exploitation}, automatable ${dp.automatable}, technical impact ${dp.technical_impact}\n` +
              `${kevLine}\n` +
              `Tree: ${data.tree.name} ${data.tree.version}` +
              (data.scored_at ? `, scored ${data.scored_at}` : '') +
              verdictBilling(data.billing),
          },
        ],
      };
    }
    const data = (await fetchJSON(`/preview/security/ssvc-verdict?${params}`)) as {
      cve: string;
      decision_points: { exploitation: string; automatable: string; technical_impact: string };
      tree: { name: string; version: string; source_url: string };
      scored_at: string;
      rate_limit?: VerdictRateLimit;
    };
    const dp = data.decision_points;
    const rl = previewRateLine(data.rate_limit);
    return {
      content: [
        {
          type: 'text' as const,
          text:
            `SSVC decision points for ${sanitizeReflectedValue(data.cve)}:\n` +
            `  exploitation: ${dp.exploitation}\n` +
            `  automatable: ${dp.automatable}\n` +
            `  technical impact: ${dp.technical_impact}\n` +
            `Tree: ${data.tree.name} ${data.tree.version}` +
            (data.scored_at ? `, scored ${data.scored_at}` : '') +
            '\n' +
            verdictUpsell(
              'ssvc_verdict',
              'the computed SSVC decision (Act, Attend, Track, or Track*) across the low/medium/high Mission and Well-being envelope, the per-level reasoning, and the live KEV cross-check',
              rl,
            ),
        },
      ],
    };
  },
);

// Series window helper: convert a requested day count into a `from` date
// (today minus days-1, UTC) for the premium date-range endpoints, which
// take from/to rather than a days shorthand.
function seriesFromDate(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - (days - 1));
  return d.toISOString().slice(0, 10);
}

// ── Tool: pricing_series (free 1 to 7 days, paid 8 to 90 days) ──────

registerTool(
  'pricing_series',
  'Daily price points for one AI model over a window. days 1 to 7 is free; days 8 to 90 costs 1 credit ($0.02) and needs a TENSORFEED_TOKEN, adding the min/max/delta summary over the longer window. Get credits at tensorfeed.ai/developers/agent-payments.',
  {
    model: z.string().max(200).describe('Model id or display name (e.g. "Claude Opus 4.7" or "claude-opus-4-7").'),
    days: z.number().int().min(1).max(90).optional().describe('Window length (default 7). 1 to 7 free; 8 to 90 costs 1 credit.'),
  },
  async ({ model, days }) => {
    const d = days ?? 7;
    if (d > 7) {
      const params = new URLSearchParams({ model, from: seriesFromDate(d) });
      const data = (await fetchJSON(`/premium/history/pricing/series?${params}`, { auth: true })) as {
        model: string;
        provider: string | null;
        points: { date: string; input: number; output: number; blended: number }[];
        summary: {
          first: { date: string; blended: number } | null;
          latest: { date: string; blended: number } | null;
          min_blended: number | null;
          max_blended: number | null;
          delta_pct_blended: number | null;
          changes_detected: number;
          days_with_data: number;
        };
        billing?: { credits_remaining?: number };
      };
      const s = data.summary;
      const summary = s.first && s.latest
        ? `${s.first.date} blended $${s.first.blended} -> ${s.latest.date} blended $${s.latest.blended} (${s.delta_pct_blended}%, ${s.changes_detected} changes, min $${s.min_blended}, max $${s.max_blended})`
        : 'no data points in range';
      return {
        content: [
          {
            type: 'text' as const,
            text: `${sanitizeReflectedValue(data.model)} (${sanitizeReflectedValue(data.provider ?? 'unknown')}) ${data.points.length} points\n${summary}\nCredits remaining: ${data.billing?.credits_remaining ?? '?'}`,
          },
        ],
      };
    }
    const params = new URLSearchParams({ model, days: String(d) });
    const data = (await fetchJSON(`/history/pricing/series?${params}`)) as {
      model: string;
      provider: string | null;
      points: { date: string; input: number; output: number; blended: number }[];
      summary: {
        first: { date: string; blended: number } | null;
        latest: { date: string; blended: number } | null;
        min_blended: number | null;
        max_blended: number | null;
        delta_pct_blended: number | null;
        days_with_data: number;
      };
    };
    const s = data.summary;
    const summary = s.first && s.latest
      ? `${s.first.date} blended $${s.first.blended} -> ${s.latest.date} blended $${s.latest.blended} (${s.delta_pct_blended}%, min $${s.min_blended}, max $${s.max_blended})`
      : 'no data points in range';
    return {
      content: [
        {
          type: 'text' as const,
          text: `${sanitizeReflectedValue(data.model)} (${sanitizeReflectedValue(data.provider ?? 'unknown')}) ${data.points.length} points over ${data.points.length} days\n${summary}\nFor up to 90 days, pass days 8 to 90 (1 credit).`,
        },
      ],
    };
  },
);

// ── Tool: benchmark_series (free 1 to 7 days, paid 8 to 90 days) ────

registerTool(
  'benchmark_series',
  'Daily benchmark scores for one model+benchmark over a window. Benchmark keys: swe_bench, mmlu_pro, gpqa_diamond, math, human_eval. days 1 to 7 is free; days 8 to 90 costs 1 credit ($0.02) and needs a TENSORFEED_TOKEN, tracking score evolution over the longer window. Get credits at tensorfeed.ai/developers/agent-payments.',
  {
    model: z.string().max(200).describe('Model id or display name.'),
    benchmark: z.string().max(200).describe('Benchmark key (e.g. swe_bench, mmlu_pro, gpqa_diamond, math, human_eval).'),
    days: z.number().int().min(1).max(90).optional().describe('Window length (default 7). 1 to 7 free; 8 to 90 costs 1 credit.'),
  },
  async ({ model, benchmark, days }) => {
    const d = days ?? 7;
    if (d > 7) {
      const params = new URLSearchParams({ model, benchmark, from: seriesFromDate(d) });
      const data = (await fetchJSON(`/premium/history/benchmarks/series?${params}`, { auth: true })) as {
        model: string;
        benchmark: string;
        points: { date: string; score: number }[];
        summary: { first: { date: string; score: number } | null; latest: { date: string; score: number } | null; delta_pp: number | null };
        billing?: { credits_remaining?: number };
      };
      const s = data.summary;
      const summary = s.first && s.latest
        ? `${s.first.date} score ${s.first.score} -> ${s.latest.date} score ${s.latest.score} (delta ${s.delta_pp} pp)`
        : 'no data in range';
      return {
        content: [
          {
            type: 'text' as const,
            text: `${sanitizeReflectedValue(data.model)} on ${sanitizeReflectedValue(data.benchmark)}: ${data.points.length} points\n${summary}\nCredits remaining: ${data.billing?.credits_remaining ?? '?'}`,
          },
        ],
      };
    }
    const params = new URLSearchParams({ model, benchmark, days: String(d) });
    const data = (await fetchJSON(`/history/benchmarks/series?${params}`)) as {
      model: string;
      benchmark: string;
      points: { date: string; score: number }[];
      summary: { first: { date: string; score: number } | null; latest: { date: string; score: number } | null; delta_pp: number | null };
    };
    const s = data.summary;
    const summary = s.first && s.latest
      ? `${s.first.date} score ${s.first.score} -> ${s.latest.date} score ${s.latest.score} (delta ${s.delta_pp} pp)`
      : 'no data in range';
    return {
      content: [
        {
          type: 'text' as const,
          text: `${sanitizeReflectedValue(data.model)} on ${sanitizeReflectedValue(data.benchmark)}: ${data.points.length} points\n${summary}`,
        },
      ],
    };
  },
);

// ── Tool: status_uptime (free 1 to 7 days, paid 8 to 90 days) ───────

registerTool(
  'status_uptime',
  'Daily uptime rollup for one provider over a window with operational/degraded/down day counts and uptime % (degraded counts as half-credit). days 1 to 7 is free; days 8 to 90 costs 1 credit ($0.02) and needs a TENSORFEED_TOKEN, adding per-incident-day detail over the longer window. Get credits at tensorfeed.ai/developers/agent-payments.',
  {
    provider: z.string().max(200).describe('Provider name (e.g. anthropic, openai, google).'),
    days: z.number().int().min(1).max(90).optional().describe('Window length (default 7). 1 to 7 free; 8 to 90 costs 1 credit.'),
  },
  async ({ provider, days }) => {
    const d = days ?? 7;
    if (d > 7) {
      const params = new URLSearchParams({ provider, from: seriesFromDate(d) });
      const data = (await fetchJSON(`/premium/history/status/uptime?${params}`, { auth: true })) as {
        provider: string;
        days_total: number;
        days_with_data: number;
        days_operational: number;
        days_degraded: number;
        days_down: number;
        uptime_pct: number | null;
        incident_days: { date: string; status: string }[];
        billing?: { credits_remaining?: number };
      };
      const incidents = data.incident_days.length
        ? '\n\nIncident days:\n' + data.incident_days.map(d2 => `  ${d2.date}: ${d2.status}`).join('\n')
        : '';
      return {
        content: [
          {
            type: 'text' as const,
            text:
              `${sanitizeReflectedValue(data.provider)} uptime: ${data.uptime_pct ?? 'n/a'}% over ${data.days_with_data} measured days (of ${data.days_total} in range)\n` +
              `  operational: ${data.days_operational}, degraded: ${data.days_degraded}, down: ${data.days_down}` +
              incidents +
              `\nCredits remaining: ${data.billing?.credits_remaining ?? '?'}`,
          },
        ],
      };
    }
    const params = new URLSearchParams({ provider, days: String(d) });
    const data = (await fetchJSON(`/history/status/uptime?${params}`)) as {
      provider: string;
      days_total: number;
      days_operational: number;
      days_degraded: number;
      days_down: number;
      uptime_pct: number | null;
    };
    return {
      content: [
        {
          type: 'text' as const,
          text: `${sanitizeReflectedValue(data.provider)} over ${data.days_total} days: ${data.uptime_pct ?? '?'}% uptime (${data.days_operational} operational, ${data.days_degraded} degraded, ${data.days_down} down)`,
        },
      ],
    };
  },
);

// ── Tool: status_leaderboard (free 1 to 7 days, paid 8 to 90 days) ──

registerTool(
  'status_leaderboard',
  'Cross-provider uptime leaderboard ranked by uptime % DESC, computed from minute-resolution counters (~720 samples per provider per day). days 1 to 7 is free; days 8 to 90 costs 3 credits ($0.06) and needs a TENSORFEED_TOKEN, adding incident_count and mttr_minutes (mean time to recover) per provider over the longer window. Get credits at tensorfeed.ai/developers/agent-payments.',
  {
    days: z.number().int().min(1).max(90).optional().describe('Window length (default 7). 1 to 7 free; 8 to 90 costs 3 credits.'),
  },
  async ({ days }) => {
    const d = days ?? 7;
    if (d > 7) {
      const params = new URLSearchParams({ from: seriesFromDate(d) });
      const data = (await fetchJSON(`/premium/status/leaderboard?${params}`, { auth: true })) as {
        ok: boolean;
        error?: string;
        message?: string;
        range?: { from: string; to: string; days: number };
        entries?: {
          provider: string;
          rank: number;
          uptime_pct: number;
          polls: number;
          downtime_minutes: number;
          hard_down_minutes: number;
          incident_count?: number;
          mttr_minutes?: number | null;
        }[];
        billing?: { credits_remaining?: number };
      };
      if (!data.ok) {
        return {
          content: [{ type: 'text' as const, text: `Leaderboard unavailable: ${data.error ?? 'unknown'} - ${data.message ?? ''}` }],
        };
      }
      const lines = (data.entries ?? []).map(
        (e) =>
          `#${e.rank} ${e.provider}: ${e.uptime_pct}% uptime, ${e.downtime_minutes}m downtime (${e.hard_down_minutes}m hard-down), ${e.incident_count ?? 0} incidents, MTTR ${e.mttr_minutes ?? 'n/a'}m`,
      );
      return {
        content: [
          {
            type: 'text' as const,
            text:
              `AI provider uptime leaderboard ${data.range?.from} to ${data.range?.to}\n${lines.join('\n')}\n\nCredits remaining: ${data.billing?.credits_remaining ?? '?'}`,
          },
        ],
      };
    }
    const params = new URLSearchParams({ days: String(d) });
    const data = (await fetchJSON(`/status/leaderboard?${params}`)) as {
      ok: boolean;
      error?: string;
      message?: string;
      range?: { from: string; to: string; days: number };
      entry_count?: number;
      entries?: {
        provider: string;
        rank: number;
        uptime_pct: number;
        polls: number;
        downtime_minutes: number;
        hard_down_minutes: number;
      }[];
    };
    if (!data.ok) {
      return {
        content: [{ type: 'text' as const, text: `Leaderboard unavailable: ${data.error ?? 'unknown'} - ${data.message ?? ''}` }],
      };
    }
    const lines = (data.entries ?? [])
      .slice(0, 10)
      .map((e) => `#${e.rank} ${e.provider}: ${e.uptime_pct}% (${e.downtime_minutes}m downtime, ${e.hard_down_minutes}m hard-down)`);
    return {
      content: [
        {
          type: 'text' as const,
          text: `AI provider uptime leaderboard ${data.range?.from} to ${data.range?.to}\n${lines.join('\n')}\n\nprovider_reliability_verdict ranks providers by dependability, not just current state.`,
        },
      ],
    };
  },
);

// ── Tool: whats_new (1 credit) ──────────────────────────────────────

registerTool(
  'whats_new',
  'Catch up on everything that changed in AI in one call: pricing moves, new and removed models, status incidents, and top news from the last 1 to 7 days, so your agent boots with current context instead of stale assumptions. Costs 1 credit ($0.02).',
  {
    days: z.number().min(1).max(7).optional().describe('Window length in days (default 1)'),
    news_limit: z.number().min(1).max(25).optional().describe('Max news headlines (default 10)'),
  },
  async ({ days, news_limit }) => {
    const params = new URLSearchParams();
    if (typeof days === 'number') params.set('days', String(days));
    if (typeof news_limit === 'number') params.set('news_limit', String(news_limit));
    const data = (await fetchJSON(`/premium/whats-new?${params}`, { auth: true })) as {
      window: { days: number };
      summary: { total_pricing_changes: number; new_models: number; removed_models: number; incidents: number; news_articles: number };
      pricing: {
        changes: { model: string; provider: string; field: string; from: number; to: number; delta_pct: number | null }[];
        new_models: { model: string; provider: string; input_per_1m: number; output_per_1m: number }[];
        removed_models: { model: string; provider: string }[];
      };
      status: { incidents: { service: string; severity: string; title: string; started_at: string }[]; currently_operational: number; currently_degraded: number; currently_down: number };
      news: { title: string; url: string; source: string; published_at: string }[];
      billing?: { credits_remaining?: number };
    };
    const sum = data.summary;
    const priceLines = data.pricing.changes.length
      ? '\nPricing changes:\n' + data.pricing.changes.map(c => `  ${c.model} ${c.field}: ${c.from} -> ${c.to} (${c.delta_pct ?? 'n/a'}%)`).join('\n')
      : '';
    const newLines = data.pricing.new_models.length
      ? '\nNew models:\n' + data.pricing.new_models.map(m => `  ${m.model} (${m.provider}) in $${m.input_per_1m}/1M, out $${m.output_per_1m}/1M`).join('\n')
      : '';
    const incidentLines = data.status.incidents.length
      ? '\nIncidents:\n' + data.status.incidents.map(i => `  ${i.service} (${i.severity}): ${i.title} @ ${i.started_at}`).join('\n')
      : '';
    const newsLines = data.news.length
      ? '\nTop news:\n' + data.news.map(n => `  ${n.title} (${n.source})\n    ${n.url}`).join('\n')
      : '';
    return {
      content: [
        {
          type: 'text' as const,
          text:
            `What's new (last ${data.window.days}d): ${sum.total_pricing_changes} price changes, ${sum.new_models} new models, ${sum.removed_models} removed, ${sum.incidents} incidents, ${sum.news_articles} headlines\n` +
            `Live: ${data.status.currently_operational} operational, ${data.status.currently_degraded} degraded, ${data.status.currently_down} down` +
            priceLines + newLines + incidentLines + newsLines +
            `\n\nCredits remaining: ${data.billing?.credits_remaining ?? '?'}`,
        },
      ],
    };
  },
);

// ── Tool: compare_models (1 credit) ─────────────────────────────────

registerTool(
  'compare_models',
  'Pick between models in one call: pricing, benchmarks, status, and recent news for 2 to 5 models side by side, with cheapest-blended and per-benchmark rankings, so you choose without scraping each provider. Costs 1 credit ($0.02).',
  {
    ids: z.string().max(500).describe('Comma-separated list of 2-5 model ids or display names. Examples: "Claude Opus 4.8,GPT-5.5,Gemini 3.5 Flash" or "opus-4-8,gpt-5-5"'),
  },
  async ({ ids }) => {
    const data = (await fetchJSON(`/premium/compare/models?ids=${encodeURIComponent(ids)}`, { auth: true })) as {
      benchmark_keys: string[];
      models: (
        | { matched: true; name: string; provider: string; pricing: { input: number; output: number; blended: number }; context_window: number | null; status: string; benchmarks: Record<string, number | null> }
        | { matched: false; query: string; reason: string }
      )[];
      rankings: {
        cheapest_blended: { name: string; blended: number }[];
        most_context: { name: string; context_window: number }[];
        by_benchmark: Record<string, { name: string; score: number }[]>;
      };
      billing?: { credits_remaining?: number };
    };

    const lines = data.models.map(m => {
      if (!m.matched) return `  ${sanitizeReflectedValue(m.query)}: not found`;
      const benches = data.benchmark_keys
        .map(k => `${k}=${m.benchmarks[k] ?? '-'}`)
        .join(', ');
      return `  ${m.name} (${m.provider}) [${m.status}]\n     in $${m.pricing.input}/1M, out $${m.pricing.output}/1M, ctx ${m.context_window ?? '-'}\n     ${benches}`;
    }).join('\n\n');

    const cheapest = data.rankings.cheapest_blended.map((r, i) => `  #${i + 1} ${r.name} ($${r.blended}/1M blended)`).join('\n');
    const ctxLine = data.rankings.most_context.map((r, i) => `  #${i + 1} ${r.name} (${r.context_window})`).join('\n');
    const benchSections = Object.entries(data.rankings.by_benchmark)
      .map(([k, v]) => `  ${k}: ${v.map(r => `${r.name}=${r.score}`).join(' > ')}`)
      .join('\n');

    return {
      content: [
        {
          type: 'text' as const,
          text: `Models compared:\n${lines}\n\nCheapest blended:\n${cheapest}\n\nMost context:\n${ctxLine || '  (no context data)'}\n\nBenchmark leaders:\n${benchSections || '  (no benchmark data)'}\n\nCredits remaining: ${data.billing?.credits_remaining ?? '?'}`,
        },
      ],
    };
  },
);

// ── Tool: provider_deepdive (1 credit) ──────────────────────────────

registerTool(
  'provider_deepdive',
  'Everything about one AI provider in a single call: live status, every model with pricing, tier, and benchmarks joined in, recent news, and agent traffic, replacing about four separate lookups. Costs 3 credits ($0.06). Strict premium, no free trial.',
  {
    provider: z.string().max(200).describe('Provider id or display name (case-insensitive). Examples: anthropic, openai, google, mistral, cohere'),
  },
  async ({ provider }) => {
    const data = (await fetchJSON(`/premium/providers/${encodeURIComponent(provider)}`, { auth: true })) as {
      provider: { name: string; url: string | null };
      status: { state: string; status_page_url: string | null; last_checked: string | null };
      models: { name: string; tier: string | null; pricing: { input: number; output: number }; benchmark_scores: Record<string, number> }[];
      recent_news: { title: string; url: string; published_at: string }[];
      recent_news_count: number;
      agent_traffic_24h: number;
      billing?: { credits_remaining?: number };
    };
    const modelLines = data.models
      .map(m => {
        const benchKeys = Object.keys(m.benchmark_scores);
        const benches = benchKeys.length ? ` | ${benchKeys.map(k => `${k}=${m.benchmark_scores[k]}`).join(', ')}` : '';
        return `  ${m.name} [${m.tier ?? '-'}] in $${m.pricing.input}/1M, out $${m.pricing.output}/1M${benches}`;
      })
      .join('\n');
    const newsLines = data.recent_news
      .slice(0, 5)
      .map(n => `  - ${n.title} (${n.published_at})\n    ${n.url}`)
      .join('\n');
    return {
      content: [
        {
          type: 'text' as const,
          text:
            `${data.provider.name} (${data.provider.url ?? 'no url'})\n` +
            `Status: ${data.status.state}${data.status.status_page_url ? ` (${data.status.status_page_url})` : ''}, last checked ${data.status.last_checked ?? 'unknown'}\n` +
            `Agent traffic (24h): ${data.agent_traffic_24h}\n\n` +
            `Models (${data.models.length}):\n${modelLines}\n\n` +
            `Recent news (${data.recent_news_count} matched, top 5 shown):\n${newsLines || '  none'}\n\n` +
            `Credits remaining: ${data.billing?.credits_remaining ?? '?'}`,
        },
      ],
    };
  },
);

// ── Tool: list_watches ──────────────────────────────────────────────

registerTool(
  'list_watches',
  'List the active webhook watches owned by the configured TensorFeed token. Free, requires TENSORFEED_TOKEN.',
  {},
  async () => {
    const data = (await fetchJSON('/premium/watches', { auth: true })) as {
      count: number;
      watches: {
        id: string;
        spec: { type: string; model?: string; field?: string; op?: string; threshold?: number; provider?: string; value?: string };
        callback_url: string;
        fire_count: number;
        fire_cap: number;
        expires_at: string;
        status: string;
      }[];
    };
    if (data.count === 0) {
      return { content: [{ type: 'text' as const, text: 'No active watches.' }] };
    }
    const rows = data.watches
      .map(w => {
        const desc =
          w.spec.type === 'price'
            ? `${w.spec.model} ${w.spec.field} ${w.spec.op}${w.spec.threshold !== undefined ? ' ' + w.spec.threshold : ''}`
            : `${w.spec.provider} ${w.spec.op}${w.spec.value ? ' ' + w.spec.value : ''}`;
        return `  ${w.id} (${w.status}) [${w.spec.type}] ${desc}\n     -> ${w.callback_url}\n     fired ${w.fire_count}/${w.fire_cap}, expires ${w.expires_at}`;
      })
      .join('\n\n');
    return { content: [{ type: 'text' as const, text: `${data.count} active watches:\n\n${rows}` }] };
  },
);

// ── Tool: create_watch (1 credit) ───────────────────────────────────
// Merges the four former create_*_watch tools (price, status, digest,
// leaderboard_rank) into one type-selected tool. Each case below builds
// the EXACT body and uses the EXACT output formatting the matching old
// create_*_watch tool used, against the same /premium/watches endpoint.

registerTool(
  'create_watch',
  'Register a webhook watch. type selects what to watch: "price" (a model price change), "status" (a service status transition), "digest" (a scheduled daily or weekly pricing summary), or "leaderboard_rank" (a provider crossing an uptime-rank threshold). Costs 1 credit ($0.02) at registration; the watch lives 90 days and each fire is an HMAC-signed POST to callback_url. Needs a TENSORFEED_TOKEN.',
  {
    type: z.enum(['price', 'status', 'digest', 'leaderboard_rank']).describe('What to watch.'),
    callback_url: z.string().max(2048).describe('HTTPS URL that receives the HMAC-signed POST when the watch fires.'),
    secret: z.string().max(256).optional().describe('Optional shared secret used to HMAC-sign delivery bodies.'),
    model: z.string().max(200).optional().describe('type=price only. Model name (e.g. "Claude Opus 4.7").'),
    field: z.enum(['inputPrice', 'outputPrice', 'blended']).optional().describe('type=price only. Which price field to watch.'),
    cadence: z.enum(['daily', 'weekly']).optional().describe('type=digest only. How often the digest fires.'),
    provider: z.string().max(200).optional().describe('type=status or type=leaderboard_rank only. Provider name or slug (case-insensitive). e.g. anthropic, openai, gemini, bedrock, azure.'),
    op: z
      .enum(['lt', 'gt', 'changes', 'becomes', 'drops_below', 'rises_above'])
      .optional()
      .describe('type=price uses lt/gt/changes (lt = below threshold, gt = above, changes = any change). type=status uses becomes/changes (becomes = transitions to a specific value; changes = any transition). type=leaderboard_rank uses drops_below/rises_above/changes (rank 1 = best; drops_below: was rank<=N now rank>N; rises_above: was rank>=N now rank<N; changes: any rank movement).'),
    threshold: z.number().optional().describe('type=price (when op is lt or gt) or type=leaderboard_rank (when op is drops_below or rises_above). Integer rank position for leaderboard_rank.'),
    value: z.enum(['operational', 'degraded', 'down']).optional().describe('type=status only. Required when op is becomes.'),
  },
  async (args) => {
    const { type, callback_url, secret, model, field, op, threshold, cadence, provider, value } = args;
    // The merged schema makes every type-specific field optional (each is
    // required for only one type). Guard the required fields per type here so a
    // missing one fails with a clear message instead of an opaque 4xx from the
    // paid /premium/watches endpoint (which would otherwise burn a request).
    const missingFields: string[] = [];
    if (type === 'price') {
      if (!model) missingFields.push('model');
      if (!field) missingFields.push('field');
      if (!op) missingFields.push('op');
    } else if (type === 'status') {
      if (!provider) missingFields.push('provider');
      if (!op) missingFields.push('op');
    } else if (type === 'digest') {
      if (!cadence) missingFields.push('cadence');
    } else if (type === 'leaderboard_rank') {
      if (!provider) missingFields.push('provider');
      if (!op) missingFields.push('op');
    }
    if (missingFields.length > 0) {
      return { content: [{ type: 'text' as const, text: `type=${type} requires: ${missingFields.join(', ')}.` }] };
    }
    switch (type) {
      case 'price': {
        const body: Record<string, unknown> = {
          spec: { type: 'price', model, field, op, ...(typeof threshold === 'number' ? { threshold } : {}) },
          callback_url,
        };
        if (secret !== undefined) body.secret = secret;
        const data = (await fetchJSON('/premium/watches', { method: 'POST', body, auth: true })) as {
          watch: { id: string; expires_at: string };
          billing?: { credits_remaining?: number };
        };
        return {
          content: [
            {
              type: 'text' as const,
              text: `Created watch ${data.watch.id} (expires ${data.watch.expires_at}). Credits remaining: ${data.billing?.credits_remaining ?? '?'}`,
            },
          ],
        };
      }
      case 'status': {
        const body: Record<string, unknown> = {
          spec: { type: 'status', provider, op, ...(value ? { value } : {}) },
          callback_url,
        };
        if (secret !== undefined) body.secret = secret;
        const data = (await fetchJSON('/premium/watches', { method: 'POST', body, auth: true })) as {
          watch: { id: string; expires_at: string };
          billing?: { credits_remaining?: number };
        };
        return {
          content: [
            {
              type: 'text' as const,
              text: `Created watch ${data.watch.id} (expires ${data.watch.expires_at}). Credits remaining: ${data.billing?.credits_remaining ?? '?'}`,
            },
          ],
        };
      }
      case 'digest': {
        const body: Record<string, unknown> = {
          spec: { type: 'digest', cadence },
          callback_url,
        };
        if (secret !== undefined) body.secret = secret;
        const data = (await fetchJSON('/premium/watches', { method: 'POST', body, auth: true })) as {
          watch: { id: string; expires_at: string };
          billing?: { credits_remaining?: number };
        };
        return {
          content: [
            {
              type: 'text' as const,
              text: `Created ${cadence} digest watch ${data.watch.id} (expires ${data.watch.expires_at}). First fire at the next 7am UTC daily cron. Credits remaining: ${data.billing?.credits_remaining ?? '?'}`,
            },
          ],
        };
      }
      case 'leaderboard_rank': {
        const spec: Record<string, unknown> = { type: 'leaderboard_rank', provider, op };
        if (threshold !== undefined) spec.threshold = threshold;
        const body: Record<string, unknown> = { spec, callback_url };
        if (secret !== undefined) body.secret = secret;
        const data = (await fetchJSON('/premium/watches', { method: 'POST', body, auth: true })) as {
          watch: { id: string; expires_at: string };
          billing?: { credits_remaining?: number };
        };
        const safeProvider = sanitizeReflectedValue(provider);
        const desc =
          op === 'changes'
            ? `${safeProvider} rank changes`
            : `${safeProvider} ${(op ?? '').replace('_', ' ')} #${threshold}`;
        return {
          content: [
            {
              type: 'text' as const,
              text: `Created leaderboard rank watch ${data.watch.id} (${desc}). Expires ${data.watch.expires_at}. Credits remaining: ${data.billing?.credits_remaining ?? '?'}`,
            },
          ],
        };
      }
    }
  },
  CREATE_TOOL,
);

// ── Tool: delete_watch ──────────────────────────────────────────────

registerTool(
  'delete_watch',
  'Delete one of your active webhook watches by id. Free, requires TENSORFEED_TOKEN.',
  {
    watch_id: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/, 'watch_id may only contain letters, digits, underscores, and hyphens')
      .max(128)
      .describe('The wat_... id from create_watch / list_watches'),
  },
  async ({ watch_id }) => {
    await fetchJSON(`/premium/watches/${encodeURIComponent(watch_id)}`, { method: 'DELETE', auth: true });
    return { content: [{ type: 'text' as const, text: `Deleted watch ${watch_id}.` }] };
  },
  DELETE_TOOL,
);

// ── Start ───────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('TensorFeed MCP server running on stdio');
}

main().catch(console.error);
