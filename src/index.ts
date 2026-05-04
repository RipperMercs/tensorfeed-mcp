#!/usr/bin/env node

import { McpServer, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z, ZodRawShape } from 'zod';
import { sanitizeToolResponse } from './sanitize.js';

const API_BASE = 'https://tensorfeed.ai/api';
const SDK_VERSION = '1.9.0';

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
  const res = await fetch(`${API_BASE}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  if (!res.ok) {
    let errPayload: unknown;
    try {
      errPayload = await res.json();
    } catch {
      errPayload = await res.text().catch(() => '');
    }
    if (res.status === 402) {
      throw new Error(
        `Payment required (402). Your token may be out of credits. Top up at https://tensorfeed.ai/developers/agent-payments. Detail: ${JSON.stringify(errPayload)}`,
      );
    }
    if (res.status === 401) {
      throw new Error(
        `Token rejected (401). Check that TENSORFEED_TOKEN is set to a valid tf_live_... token. Detail: ${JSON.stringify(errPayload)}`,
      );
    }
    throw new Error(`API error ${res.status}: ${JSON.stringify(errPayload)}`);
  }
  return res.json();
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

function registerTool<Args extends ZodRawShape>(
  name: string,
  description: string,
  paramsSchema: Args,
  cb: ToolCallback<Args>,
) {
  const wrapped = (async (args: unknown, extra: unknown) => {
    const result = await (cb as (a: unknown, e: unknown) => unknown)(args, extra);
    return sanitizeToolResponse(result as Parameters<typeof sanitizeToolResponse>[0]);
  }) as ToolCallback<Args>;
  // Direct dispatch to the SDK's underlying registration. Do not call
  // registerTool() here or it will recurse forever.
  return server.tool(name, description, paramsSchema, wrapped);
}

// ── Tool: get_ai_news ───────────────────────────────────────────────

registerTool(
  'get_ai_news',
  'Get the latest AI news articles from TensorFeed.ai. Aggregates from 15+ sources including Anthropic, OpenAI, Google, TechCrunch, The Verge, arXiv, and more.',
  {
    category: z.string().optional().describe('Filter by category (e.g. "anthropic", "openai", "research", "tools")'),
    limit: z.number().min(1).max(50).optional().describe('Number of articles to return (default 10, max 50)'),
  },
  async ({ category, limit }) => {
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

// ── Tool: get_ai_status ─────────────────────────────────────────────

registerTool(
  'get_ai_status',
  'Get real-time operational status of major AI services (Claude, OpenAI, Gemini, Mistral, Cohere, Replicate, Hugging Face).',
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

    return { content: [{ type: 'text' as const, text: `AI Service Status:\n${text}` }] };
  }
);

// ── Tool: is_service_down ───────────────────────────────────────────

registerTool(
  'is_service_down',
  'Check if a specific AI service is currently down or experiencing issues.',
  {
    service: z.string().describe('Service name to check (e.g. "claude", "openai", "gemini", "mistral", "cohere", "hugging face", "replicate")'),
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
      return { content: [{ type: 'text' as const, text: `Service "${service}" not found. Available services: ${data.services.map(s => s.name).join(', ')}` }] };
    }

    const statusEmoji = match.status === 'operational' ? 'OK' : match.status === 'degraded' ? 'DEGRADED' : 'DOWN';
    const components = match.components.length > 0
      ? '\nComponents:\n' + match.components.map(c => `  ${c.name}: ${c.status}`).join('\n')
      : '';

    return {
      content: [{
        type: 'text' as const,
        text: `${statusEmoji} ${match.name} (${match.provider}) is ${match.status}${components}`
      }]
    };
  }
);

// ── Tool: get_model_pricing ─────────────────────────────────────────

registerTool(
  'get_model_pricing',
  'Get AI model pricing comparison across all major providers (Anthropic, OpenAI, Google, Meta, Mistral, Cohere). Prices per 1M tokens.',
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

    return { content: [{ type: 'text' as const, text: `AI Model Pricing (per 1M tokens):\n\n${text}` }] };
  }
);

// ── Tool: get_ai_today ──────────────────────────────────────────────

registerTool(
  'get_ai_today',
  'Get a summary of what happened in AI today. Returns the top stories from the last 24 hours.',
  {
    limit: z.number().min(1).max(20).optional().describe('Number of stories (default 5)'),
  },
  async ({ limit }) => {
    const data = await fetchJSON(`/news?limit=${limit || 5}`) as {
      articles: { title: string; url: string; source: string; publishedAt: string }[];
    };

    const text = data.articles
      .map((a, i) => `${i + 1}. ${a.title} (${a.source})\n   ${a.url}`)
      .join('\n\n');

    return { content: [{ type: 'text' as const, text: `Today in AI:\n\n${text}` }] };
  }
);

// ── Tool: get_agent_activity ────────────────────────────────────────

registerTool(
  'get_agent_activity',
  'Get live AI bot traffic on TensorFeed.ai. Returns today\'s bot hit count, the most recent 50 hits with bot name + endpoint + timestamp, and a derived top-bots breakdown. Useful when an agent wants to see which crawlers are pulling AI ecosystem data and how that distribution shifts. Free, no auth.',
  {},
  async () => {
    const data = (await fetchJSON('/agents/activity')) as {
      today_count: number;
      last_updated: string;
      recent: { bot: string; endpoint: string; timestamp: string }[];
    };

    const tally = new Map<string, number>();
    for (const hit of data.recent) {
      tally.set(hit.bot, (tally.get(hit.bot) || 0) + 1);
    }
    const breakdown = Array.from(tally.entries())
      .map(([bot, count]) => `  ${bot}: ${count}`)
      .sort()
      .join('\n');

    const tail = data.recent
      .slice(0, 10)
      .map(h => `  ${h.bot}  ${h.endpoint}  (${h.timestamp})`)
      .join('\n');

    return {
      content: [
        {
          type: 'text' as const,
          text:
            `AI bot traffic on TensorFeed.ai\n\n` +
            `Today's bot hits: ${data.today_count}\n` +
            `Last updated: ${data.last_updated}\n\n` +
            `Bot breakdown (recent ${data.recent.length} hits):\n${breakdown || '  (none)'}\n\n` +
            `Recent tail (10 most recent):\n${tail || '  (none)'}\n\n` +
            `Public dashboard: https://tensorfeed.ai/agent-traffic`,
        },
      ],
    };
  },
);

// ════════════════════════════════════════════════════════════════════
// PREMIUM TOOLS (require TENSORFEED_TOKEN env var, paid in USDC on Base)
// ════════════════════════════════════════════════════════════════════

// ── Tool: get_account_balance ───────────────────────────────────────

registerTool(
  'get_account_balance',
  'Check the credit balance for the configured TensorFeed bearer token. Free, but requires TENSORFEED_TOKEN to be set.',
  {},
  async () => {
    const data = (await fetchJSON('/payment/balance', { auth: true })) as {
      balance: number;
      created: string;
      last_used: string;
      total_purchased: number;
    };
    return {
      content: [
        {
          type: 'text' as const,
          text: `Balance: ${data.balance} credits\nTotal purchased: ${data.total_purchased}\nCreated: ${data.created}\nLast used: ${data.last_used}`,
        },
      ],
    };
  },
);

// ── Tool: get_account_usage ─────────────────────────────────────────

registerTool(
  'get_account_usage',
  'Show per-endpoint usage for the configured TensorFeed token (last 100 calls aggregated). Free, but requires TENSORFEED_TOKEN.',
  {},
  async () => {
    const data = (await fetchJSON('/payment/usage', { auth: true })) as {
      total_calls: number;
      total_credits_spent: number;
      by_endpoint: Record<string, { calls: number; credits: number; last_seen: string }>;
    };
    if (data.total_calls === 0) {
      return { content: [{ type: 'text' as const, text: 'No premium API calls on this token yet.' }] };
    }
    const rows = Object.entries(data.by_endpoint)
      .sort(([, a], [, b]) => b.calls - a.calls)
      .map(([ep, info]) => `  ${ep}: ${info.calls} calls, ${info.credits} credits, last ${info.last_seen}`)
      .join('\n');
    return {
      content: [
        {
          type: 'text' as const,
          text: `Total: ${data.total_calls} calls, ${data.total_credits_spent} credits\n\n${rows}`,
        },
      ],
    };
  },
);

// ── Tool: premium_routing (1 credit) ────────────────────────────────

registerTool(
  'premium_routing',
  'Get a ranked list of recommended AI models for a task with full score breakdown (quality, availability, cost, latency). Costs 1 credit.',
  {
    task: z.enum(['code', 'reasoning', 'creative', 'general']).optional().describe('Task type the model needs to be good at (default: general)'),
    budget: z.number().optional().describe('Max blended USD per 1M tokens'),
    min_quality: z.number().min(0).max(1).optional().describe('Minimum quality score in [0, 1]'),
    top_n: z.number().min(1).max(10).optional().describe('How many models to return (default 5)'),
  },
  async ({ task, budget, min_quality, top_n }) => {
    const params = new URLSearchParams();
    if (task) params.set('task', task);
    if (typeof budget === 'number') params.set('budget', String(budget));
    if (typeof min_quality === 'number') params.set('min_quality', String(min_quality));
    if (typeof top_n === 'number') params.set('top_n', String(top_n));
    const data = (await fetchJSON(`/premium/routing?${params}`, { auth: true })) as {
      task: string;
      recommendations: {
        rank: number;
        model: { name: string; provider: string };
        pricing: { input: number; output: number };
        composite_score: number;
        components: { quality: number; availability: number; cost: number; latency: number };
      }[];
      billing?: { credits_charged: number; credits_remaining?: number };
    };
    const list = data.recommendations
      .map(r => {
        const c = r.components;
        return `  #${r.rank} ${r.model.name} (${r.model.provider}) score=${r.composite_score.toFixed(3)}\n     in $${r.pricing.input}/1M, out $${r.pricing.output}/1M\n     quality=${c.quality.toFixed(2)} avail=${c.availability.toFixed(2)} cost=${c.cost.toFixed(2)} latency=${c.latency.toFixed(2)}`;
      })
      .join('\n\n');
    const billing = data.billing
      ? `\n\nCharged ${data.billing.credits_charged} credit. Remaining: ${data.billing.credits_remaining}.`
      : '';
    return { content: [{ type: 'text' as const, text: `Routing for "${data.task}":\n\n${list}${billing}` }] };
  },
);

// ── Tool: pricing_series (1 credit) ─────────────────────────────────

registerTool(
  'pricing_series',
  'Daily price points for one AI model with min/max/delta summary. Default range = last 30 days, max 90 days. Costs 1 credit.',
  {
    model: z.string().describe('Model id or display name (e.g. "Claude Opus 4.7" or "claude-opus-4-7")'),
    from: z.string().optional().describe('Start date YYYY-MM-DD UTC (default: 30 days ago)'),
    to: z.string().optional().describe('End date YYYY-MM-DD UTC (default: today)'),
  },
  async ({ model, from, to }) => {
    const params = new URLSearchParams({ model });
    if (from) params.set('from', from);
    if (to) params.set('to', to);
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
          text: `${data.model} (${data.provider ?? 'unknown'}) ${data.points.length} points\n${summary}\nCredits remaining: ${data.billing?.credits_remaining ?? '?'}`,
        },
      ],
    };
  },
);

// ── Tool: benchmark_series (1 credit) ───────────────────────────────

registerTool(
  'benchmark_series',
  'Score evolution for a single benchmark on one AI model. Costs 1 credit. Benchmark keys: swe_bench, mmlu_pro, gpqa_diamond, math, human_eval.',
  {
    model: z.string().describe('Model id or display name'),
    benchmark: z.string().describe('Benchmark key (e.g. swe_bench, mmlu_pro, gpqa_diamond, math, human_eval)'),
    from: z.string().optional().describe('Start date YYYY-MM-DD UTC (default: 30 days ago)'),
    to: z.string().optional().describe('End date YYYY-MM-DD UTC (default: today)'),
  },
  async ({ model, benchmark, from, to }) => {
    const params = new URLSearchParams({ model, benchmark });
    if (from) params.set('from', from);
    if (to) params.set('to', to);
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
          text: `${data.model} on ${data.benchmark}: ${data.points.length} points\n${summary}\nCredits remaining: ${data.billing?.credits_remaining ?? '?'}`,
        },
      ],
    };
  },
);

// ── Tool: status_uptime (1 credit) ──────────────────────────────────

registerTool(
  'status_uptime',
  'Daily uptime rollup for one provider with operational/degraded/down day counts and uptime % (degraded counts as half-credit). Costs 1 credit.',
  {
    provider: z.string().describe('Provider name (e.g. anthropic, openai, google)'),
    from: z.string().optional().describe('Start date YYYY-MM-DD UTC (default: 30 days ago)'),
    to: z.string().optional().describe('End date YYYY-MM-DD UTC (default: today)'),
  },
  async ({ provider, from, to }) => {
    const params = new URLSearchParams({ provider });
    if (from) params.set('from', from);
    if (to) params.set('to', to);
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
      ? '\n\nIncident days:\n' + data.incident_days.map(d => `  ${d.date}: ${d.status}`).join('\n')
      : '';
    return {
      content: [
        {
          type: 'text' as const,
          text:
            `${data.provider} uptime: ${data.uptime_pct ?? 'n/a'}% over ${data.days_with_data} measured days (of ${data.days_total} in range)\n` +
            `  operational: ${data.days_operational}, degraded: ${data.days_degraded}, down: ${data.days_down}` +
            incidents +
            `\nCredits remaining: ${data.billing?.credits_remaining ?? '?'}`,
        },
      ],
    };
  },
);

// ── Tool: premium_agents_directory (1 credit) ───────────────────────

registerTool(
  'premium_agents_directory',
  'Enriched AI agents catalog joined with live status, recent news, agent traffic, flagship pricing, and a 0-100 trending_score. Costs 1 credit.',
  {
    category: z.string().optional().describe('coding, research, general, creative, frameworks'),
    status: z.enum(['operational', 'degraded', 'down', 'unknown']).optional(),
    open_source: z.boolean().optional(),
    sort: z.enum(['trending', 'alphabetical', 'status', 'price_low', 'price_high', 'news_count']).optional(),
    limit: z.number().min(1).max(100).optional(),
  },
  async ({ category, status, open_source, sort, limit }) => {
    const params = new URLSearchParams();
    if (category) params.set('category', category);
    if (status) params.set('status', status);
    if (typeof open_source === 'boolean') params.set('open_source', String(open_source));
    if (sort) params.set('sort', sort);
    if (typeof limit === 'number') params.set('limit', String(limit));
    const data = (await fetchJSON(`/premium/agents/directory?${params}`, { auth: true })) as {
      total: number;
      returned: number;
      sort: string;
      agents: {
        id: string;
        name: string;
        provider: string;
        category: string;
        live_status: string;
        recent_news_count: number;
        flagship_pricing: { model: string; blended: number } | null;
        trending_score: number;
      }[];
      billing?: { credits_remaining?: number };
    };
    const list = data.agents
      .map(
        a =>
          `  ${a.name} (${a.provider}) [${a.category}] status=${a.live_status} score=${a.trending_score} news=${a.recent_news_count}` +
          (a.flagship_pricing ? ` flagship=${a.flagship_pricing.model} $${a.flagship_pricing.blended}/1M` : ''),
      )
      .join('\n');
    return {
      content: [
        {
          type: 'text' as const,
          text: `Agents (sort: ${data.sort}, ${data.returned} of ${data.total}):\n\n${list}\n\nCredits remaining: ${data.billing?.credits_remaining ?? '?'}`,
        },
      ],
    };
  },
);

// ── Tool: whats_new (1 credit) ──────────────────────────────────────

registerTool(
  'whats_new',
  'Agent morning brief: pricing changes, new/removed models, status incidents, and top news from the last 1-7 days. The tool to call when your agent boots up. Costs 1 credit.',
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
  'Side-by-side comparison of 2-5 AI models. Returns pricing, benchmarks (normalized to a union of keys with null for missing scores), provider status, and recent news per model, plus rankings (cheapest blended, most context, per-benchmark leaderboard). Costs 1 credit.',
  {
    ids: z.string().describe('Comma-separated list of 2-5 model ids or display names. Examples: "Claude Opus 4.7,GPT-5.5,Gemini 3" or "opus-4-7,gpt-5-5"'),
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
      if (!m.matched) return `  ${m.query}: not found`;
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
  'Everything about an AI provider in one call: live status, all models with pricing + tier + benchmark scores joined in, recent news mentions, and agent traffic. Costs 1 credit. Aggregation IS the value; doing this from free endpoints would take 4 round-trips.',
  {
    provider: z.string().describe('Provider id or display name (case-insensitive). Examples: anthropic, openai, google, mistral, cohere'),
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

// ── Tool: cost_projection (1 credit) ────────────────────────────────

registerTool(
  'cost_projection',
  'Project the cost of a token-usage workload across 1-10 AI models. Returns daily/weekly/monthly/yearly totals per model and a ranking by cheapest monthly. Costs 1 credit.',
  {
    models: z.string().describe('One model or comma-separated list of up to 10 (e.g. "Claude Opus 4.7,GPT-5.5,Gemini 3"). Names or ids both work.'),
    input_tokens_per_day: z.number().min(0).describe('Expected daily input token volume'),
    output_tokens_per_day: z.number().min(0).describe('Expected daily output token volume'),
    horizon: z.enum(['daily', 'weekly', 'monthly', 'yearly']).optional().describe('Primary horizon to highlight (default monthly). All four are always computed.'),
  },
  async ({ models, input_tokens_per_day, output_tokens_per_day, horizon }) => {
    const params = new URLSearchParams({
      model: models,
      input_tokens_per_day: String(input_tokens_per_day),
      output_tokens_per_day: String(output_tokens_per_day),
    });
    if (horizon) params.set('horizon', horizon);
    const data = (await fetchJSON(`/premium/cost/projection?${params}`, { auth: true })) as {
      workload: { input_tokens_per_day: number; output_tokens_per_day: number };
      projections: (
        | { model: string; provider: string; matched: true; daily: { total: number }; weekly_total: number; monthly_total: number; yearly_total: number; rates: { input_per_1m: number; output_per_1m: number } }
        | { model: string; matched: false; reason: string }
      )[];
      ranked_cheapest_monthly: { model: string; provider: string; monthly_total: number }[];
      billing?: { credits_remaining?: number };
    };
    const lines = data.projections.map(p => {
      if (!p.matched) return `  ${p.model}: not found in pricing catalog`;
      return `  ${p.model} (${p.provider}): $${p.daily.total}/day, $${p.weekly_total}/wk, $${p.monthly_total}/mo, $${p.yearly_total}/yr (in $${p.rates.input_per_1m}/1M, out $${p.rates.output_per_1m}/1M)`;
    }).join('\n');
    const ranked = data.ranked_cheapest_monthly.length
      ? '\n\nCheapest monthly:\n' +
        data.ranked_cheapest_monthly
          .map((r, i) => `  #${i + 1} ${r.model} (${r.provider}): $${r.monthly_total}/mo`)
          .join('\n')
      : '';
    return {
      content: [
        {
          type: 'text' as const,
          text:
            `Workload: ${data.workload.input_tokens_per_day} input + ${data.workload.output_tokens_per_day} output tokens/day\n\n${lines}${ranked}\n\nCredits remaining: ${data.billing?.credits_remaining ?? '?'}`,
        },
      ],
    };
  },
);

// ── Tool: news_search (1 credit) ────────────────────────────────────

registerTool(
  'news_search',
  'Full-text search over the TensorFeed news article corpus with optional date range, provider, and category filters. Relevance scoring with recency boost. Costs 1 credit.',
  {
    q: z.string().optional().describe('Free-text query, e.g. "claude opus pricing". Omit to browse latest filtered articles.'),
    from: z.string().optional().describe('Start date YYYY-MM-DD UTC (inclusive)'),
    to: z.string().optional().describe('End date YYYY-MM-DD UTC (inclusive end-of-day)'),
    provider: z.string().optional().describe('Substring match against source name and domain (e.g. "anthropic", "openai", "techcrunch")'),
    category: z.string().optional().describe('Substring match against article categories'),
    limit: z.number().min(1).max(100).optional().describe('Max results (default 25, max 100)'),
  },
  async ({ q, from, to, provider, category, limit }) => {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    if (provider) params.set('provider', provider);
    if (category) params.set('category', category);
    if (typeof limit === 'number') params.set('limit', String(limit));
    const data = (await fetchJSON(`/premium/news/search?${params}`, { auth: true })) as {
      query: string | null;
      matched: number;
      returned: number;
      results: { title: string; url: string; source: string; published_at: string; relevance: number; matched_terms: string[]; snippet: string }[];
      billing?: { credits_remaining?: number };
    };
    if (data.results.length === 0) {
      return { content: [{ type: 'text' as const, text: `No articles matched. (matched: ${data.matched})` }] };
    }
    const list = data.results
      .map(
        (r, i) =>
          `${i + 1}. ${r.title} (${r.source})\n   ${r.url}\n   ${r.published_at} | relevance ${r.relevance}${r.matched_terms.length ? ` | terms: ${r.matched_terms.join(', ')}` : ''}\n   ${r.snippet}`,
      )
      .join('\n\n');
    return {
      content: [
        {
          type: 'text' as const,
          text: `${data.returned} of ${data.matched} matches${data.query ? ` for "${data.query}"` : ''}:\n\n${list}\n\nCredits remaining: ${data.billing?.credits_remaining ?? '?'}`,
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

// ── Tool: create_price_watch (1 credit) ─────────────────────────────

registerTool(
  'create_price_watch',
  'Register a webhook watch on a model price change. Costs 1 credit. Watch lives 90 days. Each fire is an HMAC-signed POST to callback_url.',
  {
    model: z.string().describe('Model name (e.g. "Claude Opus 4.7")'),
    field: z.enum(['inputPrice', 'outputPrice', 'blended']).describe('Which price field to watch'),
    op: z.enum(['lt', 'gt', 'changes']).describe('Trigger: lt = below threshold, gt = above, changes = any change'),
    threshold: z.number().optional().describe('Required when op is lt or gt; ignored for changes'),
    callback_url: z.string().describe('HTTPS URL to POST to when the watch fires'),
    secret: z.string().optional().describe('Optional shared secret used to HMAC-sign delivery bodies'),
  },
  async ({ model, field, op, threshold, callback_url, secret }) => {
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
  },
);

// ── Tool: create_status_watch (1 credit) ────────────────────────────

registerTool(
  'create_status_watch',
  'Register a webhook watch on a service status transition (e.g. anthropic becomes down). Costs 1 credit. Watch lives 90 days.',
  {
    provider: z.string().describe('Provider name (e.g. anthropic, openai)'),
    op: z.enum(['becomes', 'changes']).describe('becomes = transitions to a specific value; changes = any transition'),
    value: z.enum(['operational', 'degraded', 'down']).optional().describe('Required when op is becomes'),
    callback_url: z.string().describe('HTTPS URL to POST to when the watch fires'),
    secret: z.string().optional().describe('Optional HMAC shared secret'),
  },
  async ({ provider, op, value, callback_url, secret }) => {
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
  },
);

// ── Tool: create_digest_watch (1 credit) ────────────────────────────

registerTool(
  'create_digest_watch',
  'Register a scheduled digest webhook that fires daily or weekly with a curated summary of pricing changes (regardless of whether anything dramatic happened). Costs 1 credit. Watch lives 90 days. Set-and-forget for agents that want a periodic snapshot without subscribing to realtime transitions.',
  {
    cadence: z.enum(['daily', 'weekly']).describe('How often the digest fires'),
    callback_url: z.string().describe('HTTPS URL to POST to when the digest fires'),
    secret: z.string().optional().describe('Optional HMAC shared secret'),
  },
  async ({ cadence, callback_url, secret }) => {
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
  },
);

// ── Tool: delete_watch ──────────────────────────────────────────────

registerTool(
  'delete_watch',
  'Delete one of your active webhook watches by id. Free, requires TENSORFEED_TOKEN.',
  {
    watch_id: z.string().describe('The wat_... id from create_price_watch / create_status_watch / list_watches'),
  },
  async ({ watch_id }) => {
    await fetchJSON(`/premium/watches/${watch_id}`, { method: 'DELETE', auth: true });
    return { content: [{ type: 'text' as const, text: `Deleted watch ${watch_id}.` }] };
  },
);

// ── Tool: probe_latest (free) ───────────────────────────────────────

registerTool(
  'probe_latest',
  'Last 24 hours of measured LLM endpoint latency and availability per provider (Anthropic, OpenAI, Google, Mistral, Cohere). TensorFeed pings each provider\'s chat completion endpoint every 15 min and records time-to-first-byte, total response time, and HTTP status. Returns per-provider success rate and ttfb/total p50/p95/p99 latency. The data is unique because we measure it ourselves, not self-reported by the providers. Useful when an agent needs to pick a provider whose SLA you can verify, or to detect ongoing incidents before they hit a status page. Free, no auth.',
  {},
  async () => {
    const data = (await fetchJSON('/probe/latest')) as {
      summary: {
        computed_at: string;
        window_label: string;
        providers: Array<{
          provider: string;
          count: number;
          ok_pct: number;
          ttfb: { p50: number | null; p95: number | null; p99: number | null };
          total: { p50: number | null; p95: number | null; p99: number | null };
          last_probe_at: string | null;
          last_error: string | null;
        }>;
      };
    };
    const s = data.summary;
    if (s.providers.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No probe data yet. Probing starts as soon as TensorFeed has at least one provider key configured.' }] };
    }
    const rows = s.providers
      .sort((a, b) => b.ok_pct - a.ok_pct)
      .map(p => {
        const okPct = (p.ok_pct * 100).toFixed(1);
        const ttfb = p.ttfb.p50 !== null ? `p50 ${p.ttfb.p50}ms / p95 ${p.ttfb.p95}ms / p99 ${p.ttfb.p99}ms` : 'no successful probes';
        const total = p.total.p50 !== null ? `p50 ${p.total.p50}ms / p95 ${p.total.p95}ms / p99 ${p.total.p99}ms` : 'no successful probes';
        const err = p.last_error ? `\n      last error: ${p.last_error}` : '';
        return `  ${p.provider}: ${okPct}% ok over ${p.count} probes\n    ttfb:  ${ttfb}\n    total: ${total}${err}`;
      })
      .join('\n\n');
    return {
      content: [
        {
          type: 'text' as const,
          text: `LLM Endpoint SLA (${s.window_label}, computed ${s.computed_at})\n\n${rows}\n\nSource: TensorFeed measured probes, not self-reported.`,
        },
      ],
    };
  },
);

// ── Tool: probe_series (1 credit) ───────────────────────────────────

registerTool(
  'probe_series',
  'Daily SLA series for one LLM provider, measured by TensorFeed. Returns per-day count, success rate, ttfb p50/p95/p99, total p50/p95/p99, and incident-hour count across the requested window. Provider status pages are politically managed; this is the measured truth. Pairs naturally with premium_routing for picking a model whose SLA you can verify. Costs 1 credit.',
  {
    provider: z.enum(['anthropic', 'openai', 'google', 'mistral', 'cohere']).describe('LLM provider key'),
    from: z.string().optional().describe('Inclusive start YYYY-MM-DD (default: 30 days before to)'),
    to: z.string().optional().describe('Inclusive end YYYY-MM-DD (default: today UTC)'),
  },
  async ({ provider, from, to }) => {
    const params = new URLSearchParams();
    params.set('provider', provider);
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    const data = (await fetchJSON(`/premium/probe/series?${params}`, { auth: true })) as {
      provider: string;
      from: string;
      to: string;
      days: number;
      points: Array<{
        date: string;
        ok_pct: number | null;
        ttfb_p50: number | null;
        ttfb_p95: number | null;
        total_p50: number | null;
        total_p95: number | null;
        incident_hours: number;
        has_data: boolean;
      }>;
      summary: { overall_uptime_pct: number | null; days_with_data: number; days_with_incidents: number };
      notes: string[];
      billing?: { credits_remaining?: number };
    };
    const lines = data.points
      .map(p => p.has_data
        ? `  ${p.date}  ${(p.ok_pct! * 100).toFixed(1)}% ok  ttfb p50/p95: ${p.ttfb_p50}/${p.ttfb_p95}ms  total p50/p95: ${p.total_p50}/${p.total_p95}ms  incidents: ${p.incident_hours}h`
        : `  ${p.date}  (no data)`,
      )
      .join('\n');
    const overall = data.summary.overall_uptime_pct !== null
      ? `${(data.summary.overall_uptime_pct * 100).toFixed(2)}%`
      : 'insufficient data';
    const notes = data.notes.length ? '\nNotes: ' + data.notes.join('; ') : '';
    return {
      content: [
        {
          type: 'text' as const,
          text: `${data.provider} measured SLA, ${data.from} -> ${data.to}\nOverall uptime: ${overall}  (${data.summary.days_with_data} days with data, ${data.summary.days_with_incidents} with incidents)\n\n${lines}${notes}\n\nCredits remaining: ${data.billing?.credits_remaining ?? '?'}`,
        },
      ],
    };
  },
);

// ── Tool: mcp_registry_snapshot (free) ──────────────────────────────

registerTool(
  'mcp_registry_snapshot',
  'Today\'s summary of the official Model Context Protocol server registry. Returns total servers, by-status breakdown, top namespaces, and 1-day deltas (newly added, reactivated, deprecated). Captured daily at 9:30 AM UTC from registry.modelcontextprotocol.io. Useful when an agent wants to see how the MCP ecosystem is growing or detect freshly-deprecated servers it may be using. Free, no auth.',
  {},
  async () => {
    const data = (await fetchJSON('/mcp/registry/snapshot')) as {
      summary: {
        date: string;
        capturedAt: string;
        total_servers: number;
        total_versions: number;
        by_status: Record<string, number>;
        top_namespaces: { namespace: string; count: number }[];
        new_today: { count: number; names: string[] };
        reactivated_today: { count: number; names: string[] };
        deprecated_today: { count: number; names: string[] };
        delta_vs_yesterday: { added: number; removed: number; net: number } | null;
      };
    };
    const s = data.summary;
    const statusLine = Object.entries(s.by_status)
      .map(([k, v]) => `${k}: ${v}`)
      .join(', ');
    const topNs = s.top_namespaces.slice(0, 10).map(n => `  ${n.namespace}: ${n.count}`).join('\n');
    const delta = s.delta_vs_yesterday
      ? `Day over day: +${s.delta_vs_yesterday.added} new, -${s.delta_vs_yesterday.removed} removed, net ${s.delta_vs_yesterday.net >= 0 ? '+' : ''}${s.delta_vs_yesterday.net}`
      : 'Day over day: not available (first snapshot)';
    const newToday = s.new_today.count > 0
      ? `\nNewly listed today (${s.new_today.count}):\n` + s.new_today.names.slice(0, 10).map(n => `  ${n}`).join('\n')
      : '';
    const deprecatedToday = s.deprecated_today.count > 0
      ? `\nDeprecated today (${s.deprecated_today.count}):\n` + s.deprecated_today.names.slice(0, 10).map(n => `  ${n}`).join('\n')
      : '';
    return {
      content: [
        {
          type: 'text' as const,
          text:
            `MCP Server Registry — ${s.date}\n` +
            `Total servers: ${s.total_servers} (across ${s.total_versions} versioned entries)\n` +
            `Status: ${statusLine}\n${delta}\n\n` +
            `Top namespaces:\n${topNs}` +
            newToday + deprecatedToday +
            `\n\nSource: registry.modelcontextprotocol.io`,
        },
      ],
    };
  },
);

// ── Tool: mcp_registry_series (1 credit) ────────────────────────────

registerTool(
  'mcp_registry_series',
  'Multi-day series of MCP server registry growth and churn. Returns per-day total servers, active count, and daily added/removed counts across the requested window. The registry itself is open data, but a 30/90-day trend requires daily capture started weeks ago, which TensorFeed has been running. Costs 1 credit.',
  {
    from: z.string().optional().describe('Inclusive start date YYYY-MM-DD (default: 30 days before to)'),
    to: z.string().optional().describe('Inclusive end date YYYY-MM-DD (default: today UTC)'),
  },
  async ({ from, to }) => {
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    const data = (await fetchJSON(`/premium/mcp/registry/series?${params}`, { auth: true })) as {
      from: string;
      to: string;
      days: number;
      points: { date: string; total_servers: number | null; added: number | null; removed: number | null; has_data: boolean }[];
      delta_in_window: { start_total: number | null; end_total: number | null; net: number | null };
      notes: string[];
      billing?: { credits_remaining?: number };
    };
    const lines = data.points
      .map(p => p.has_data
        ? `  ${p.date}  total=${p.total_servers}  +${p.added ?? 0}/-${p.removed ?? 0}`
        : `  ${p.date}  (no snapshot captured)`,
      )
      .join('\n');
    const w = data.delta_in_window;
    const summary = w.start_total !== null && w.end_total !== null
      ? `Window ${data.from} -> ${data.to}: ${w.start_total} -> ${w.end_total} (net ${w.net! >= 0 ? '+' : ''}${w.net})`
      : `Window ${data.from} -> ${data.to}: insufficient data`;
    const notes = data.notes.length ? '\nNotes: ' + data.notes.join('; ') : '';
    return {
      content: [
        {
          type: 'text' as const,
          text: `${summary}\n\n${lines}${notes}\n\nCredits remaining: ${data.billing?.credits_remaining ?? '?'}`,
        },
      ],
    };
  },
);

// ── Tool: get_ai_papers_trending (free) ─────────────────────────────

registerTool(
  'get_ai_papers_trending',
  'Daily curated AI/ML research papers ranked by citation count. Sourced from Semantic Scholar across five fan-out queries (large language model, transformer, RLHF, AI agents, diffusion model), deduped by paperId, top 30 returned. Each paper carries title, abstract, authors, year, venue, citation count, arxivId, doi, and fields of study. Refreshed daily at 11:00 UTC. Use this when an agent wants the citation-ranked top of the AI research literature. Free, no auth.',
  {},
  async () => {
    const data = (await fetchJSON('/papers/ai-trending')) as {
      snapshot: {
        date: string;
        capturedAt: string;
        total_papers: number;
        papers: { title: string; year: number | null; venue: string | null; citationCount: number; authors: string[]; arxivId: string | null; url: string | null }[];
        summary: { top_venues: { venue: string; count: number }[] };
      };
    };
    const s = data.snapshot;
    const lines = s.papers.map((p, i) => {
      const authors = p.authors.slice(0, 3).join(', ') + (p.authors.length > 3 ? ' et al.' : '');
      const year = p.year ? ` (${p.year})` : '';
      const venue = p.venue ? ` ${p.venue}.` : '';
      const arxiv = p.arxivId ? ` arXiv:${p.arxivId}` : '';
      const link = p.url ? `\n     ${p.url}` : '';
      return `${i + 1}. ${p.title}${year}\n     ${authors}.${venue} Citations: ${p.citationCount}.${arxiv}${link}`;
    }).join('\n\n');
    const venues = s.summary.top_venues.slice(0, 5).map(v => `${v.venue} (${v.count})`).join(', ');
    return {
      content: [
        {
          type: 'text' as const,
          text:
            `AI Papers, citation-ranked. ${s.date}, ${s.total_papers} papers.\n` +
            (venues ? `Top venues: ${venues}\n\n` : '\n') +
            lines +
            `\n\nSource: Semantic Scholar Graph API. Captured ${s.capturedAt}.`,
        },
      ],
    };
  },
);

// ── Tool: get_arxiv_recent (free) ───────────────────────────────────

registerTool(
  'get_arxiv_recent',
  'Most recent arXiv submissions in cs.AI / cs.LG / cs.CL / cs.CV. Single Atom API call, deduped by arxivId, top 50 by submission date. The firehose pair to get_ai_papers_trending: this shows what just dropped, ai_papers_trending ranks by citation count. Each paper carries arxivId, title, abstract, authors, primary category, publication date, html and pdf URLs. Refreshed daily at 11:30 UTC. Free, no auth.',
  {
    limit: z.number().min(1).max(50).optional().describe('Max papers to include in the rendered list (default 25, max 50)'),
  },
  async ({ limit }) => {
    const data = (await fetchJSON('/papers/arxiv-recent')) as {
      snapshot: {
        date: string;
        capturedAt: string;
        total_papers: number;
        categories_queried: string[];
        papers: { arxivId: string; title: string; authors: string[]; primaryCategory: string | null; publishedAt: string; htmlUrl: string }[];
      };
    };
    const s = data.snapshot;
    const cap = Math.min(limit ?? 25, s.papers.length);
    const lines = s.papers.slice(0, cap).map((p, i) => {
      const authors = p.authors.slice(0, 3).join(', ') + (p.authors.length > 3 ? ' et al.' : '');
      const cat = p.primaryCategory ? ` [${p.primaryCategory}]` : '';
      const date = p.publishedAt ? ` ${p.publishedAt.slice(0, 10)}` : '';
      return `${i + 1}. ${p.title}${cat}${date}\n     ${authors}\n     ${p.htmlUrl}`;
    }).join('\n\n');
    return {
      content: [
        {
          type: 'text' as const,
          text:
            `arXiv recent submissions. ${s.date}, showing ${cap} of ${s.total_papers}.\n` +
            `Categories: ${s.categories_queried.join(', ')}\n\n` +
            lines +
            `\n\nSource: arxiv.org. Captured ${s.capturedAt}.`,
        },
      ],
    };
  },
);

// ── Tool: get_hf_trending (free) ────────────────────────────────────

registerTool(
  'get_hf_trending',
  'Top Hugging Face models, datasets, and Spaces. Models + datasets ranked by downloads (top 30 each); Spaces ranked by likes (top 30, since downloads is meaningless for hosted apps). Captured daily at 12:00 UTC against the public HF API (no auth). Each model entry carries id, downloads, likes, pipeline_tag, tags, lastModified, private, gated. Each space entry carries id, author, sdk (gradio/streamlit/static/docker), likes, tags, lastModified, private, runtime_stage, hardware. Use this when an agent wants the current shape of the open model + dataset + app ecosystem. Once enough daily snapshots accumulate, day-over-day deltas become a real trending signal. Free, no auth.',
  {
    section: z.enum(['models', 'datasets', 'spaces', 'all', 'both']).optional().describe('Which to include in the rendered output (default all). "both" is accepted as alias for "models+datasets" for backward compat.'),
    limit: z.number().min(1).max(30).optional().describe('Max items per section (default 15, max 30)'),
  },
  async ({ section, limit }) => {
    const data = (await fetchJSON('/hf/trending')) as {
      snapshot: {
        date: string;
        capturedAt: string;
        models: { items: { id: string; downloads: number; likes: number; pipeline_tag: string | null }[] };
        datasets: { items: { id: string; downloads: number; likes: number }[] };
        spaces: { items: { id: string; sdk: string | null; likes: number; runtime_stage: string | null; hardware: string | null }[] };
        summary: { top_pipeline_tags: { tag: string; count: number }[]; top_namespaces: { namespace: string; count: number }[]; top_space_sdks: { sdk: string; count: number }[] };
      };
    };
    const s = data.snapshot;
    const sec = section ?? 'all';
    const n = Math.min(limit ?? 15, 30);
    const fmtCount = (x: number) => x >= 1_000_000 ? `${(x / 1_000_000).toFixed(1)}M` : x >= 1_000 ? `${(x / 1_000).toFixed(1)}K` : String(x);

    const modelLines = s.models.items.slice(0, n).map((m, i) => {
      const tag = m.pipeline_tag ? ` [${m.pipeline_tag}]` : '';
      return `${i + 1}. ${m.id}${tag}  ${fmtCount(m.downloads)} downloads, ${fmtCount(m.likes)} likes`;
    }).join('\n');
    const datasetLines = s.datasets.items.slice(0, n).map((d, i) =>
      `${i + 1}. ${d.id}  ${fmtCount(d.downloads)} downloads, ${fmtCount(d.likes)} likes`,
    ).join('\n');
    const spaceLines = (s.spaces?.items ?? []).slice(0, n).map((sp, i) => {
      const sdk = sp.sdk ? ` [${sp.sdk}]` : '';
      const hw = sp.hardware ? `, hw: ${sp.hardware}` : '';
      const stage = sp.runtime_stage ? `, ${sp.runtime_stage.toLowerCase()}` : '';
      return `${i + 1}. ${sp.id}${sdk}  ${fmtCount(sp.likes)} likes${stage}${hw}`;
    }).join('\n');

    const pipelines = s.summary.top_pipeline_tags.slice(0, 5).map(t => `${t.tag} (${t.count})`).join(', ');
    const namespaces = s.summary.top_namespaces.slice(0, 5).map(n => `${n.namespace} (${n.count})`).join(', ');
    const sdks = (s.summary.top_space_sdks ?? []).slice(0, 5).map(t => `${t.sdk} (${t.count})`).join(', ');

    let text = `Hugging Face top assets. ${s.date}.\n`;
    if (pipelines) text += `Top pipeline tags (models): ${pipelines}\n`;
    if (sdks) text += `Top Space SDKs: ${sdks}\n`;
    if (namespaces) text += `Top namespaces: ${namespaces}\n`;
    const includeModels = sec === 'models' || sec === 'all' || sec === 'both';
    const includeDatasets = sec === 'datasets' || sec === 'all' || sec === 'both';
    const includeSpaces = sec === 'spaces' || sec === 'all';
    if (includeModels) text += `\nModels (by downloads):\n${modelLines}\n`;
    if (includeDatasets) text += `\nDatasets (by downloads):\n${datasetLines}\n`;
    if (includeSpaces) text += `\nSpaces (by likes):\n${spaceLines || '  (none returned)'}\n`;
    text += `\nSource: huggingface.co. Captured ${s.capturedAt}.`;
    return { content: [{ type: 'text' as const, text }] };
  },
);

// ── Tool: get_hot_issues (free) ─────────────────────────────────────

registerTool(
  'get_hot_issues',
  'Currently-hot GitHub issues across the AI ecosystem. Five fan-out search queries on AI-relevant topics (llm, ai-agents, large-language-models, machine-learning, transformer) for is:issue is:open archived:false comments>=10 updated within the last 7 days. Deduped by URL, top 30 by comment count. Each issue carries url, repo, number, title, author, state, comments, reactions_total, labels, created_at, updated_at, and matched_topic. Refreshed daily at 12:30 UTC. Companion to get_trending_repos: that shows which AI repos are gaining stars, this shows where the active conversations are. Free, no auth.',
  {
    limit: z.number().min(1).max(30).optional().describe('Max issues to render (default 15, max 30)'),
  },
  async ({ limit }) => {
    const data = (await fetchJSON('/issues/hot')) as {
      snapshot: {
        date: string;
        capturedAt: string;
        total_issues: number;
        topics_queried: string[];
        recent_window_days: number;
        comments_threshold: number;
        issues: { url: string; repo: string; title: string; author: string | null; state: 'open' | 'closed'; comments: number; reactions_total: number; matched_topic: string; updated_at: string }[];
        summary: { by_topic: Record<string, number>; top_repos: { repo: string; count: number }[] };
      };
    };
    const s = data.snapshot;
    const cap = Math.min(limit ?? 15, s.issues.length);
    const lines = s.issues.slice(0, cap).map((i, n) => {
      const meta = `${i.comments} comments, ${i.reactions_total} reactions  [${i.matched_topic}]`;
      const author = i.author ? ` by ${i.author}` : '';
      const updated = i.updated_at ? `  updated ${i.updated_at.slice(0, 10)}` : '';
      return `${n + 1}. ${i.repo}: ${i.title}\n     ${meta}${updated}${author}\n     ${i.url}`;
    }).join('\n\n');
    const repos = s.summary.top_repos.slice(0, 5).map(r => `${r.repo} (${r.count})`).join(', ');
    return {
      content: [
        {
          type: 'text' as const,
          text:
            `Hot AI GitHub issues. ${s.date}, showing ${cap} of ${s.total_issues}.\n` +
            `Window: last ${s.recent_window_days} days, comments threshold ${s.comments_threshold}.\n` +
            (repos ? `Most-active repos: ${repos}\n\n` : '\n') +
            lines +
            `\n\nSource: GitHub Search API. Captured ${s.capturedAt}.`,
        },
      ],
    };
  },
);

// ── Tool: get_reddit_trending (free) ────────────────────────────────

registerTool(
  'get_reddit_trending',
  'Currently-hot threads in 7 AI-relevant subreddits (LocalLLaMA, MachineLearning, ClaudeAI, OpenAI, singularity, artificial, AI_Agents). Stickied and NSFW posts filtered, deduped by post id, ranked by score, top 30. Each post carries id, subreddit, title, author, score, upvote_ratio, num_comments, permalink, url, created_utc, flair, is_self, is_video. Refreshed daily at 13:00 UTC. Companion to get_hot_issues: that surfaces developer conversation on GitHub, this surfaces community conversation on Reddit. Titles are sanitized at capture time against prompt-injection tokens. Free, no auth.',
  {
    subreddit: z.string().optional().describe('Optional filter to a single subreddit name (e.g. "LocalLLaMA"). Case-insensitive. If absent, returns posts from all 7.'),
    limit: z.number().min(1).max(30).optional().describe('Max posts to render (default 15, max 30)'),
  },
  async ({ subreddit, limit }) => {
    const data = (await fetchJSON('/reddit/trending')) as {
      snapshot: {
        date: string;
        capturedAt: string;
        total_posts: number;
        subreddits_queried: string[];
        posts: { subreddit: string; title: string; author: string | null; score: number; num_comments: number; permalink: string; flair: string | null }[];
        summary: { by_subreddit: Record<string, number>; top_authors: { author: string; count: number }[] };
      };
    };
    const s = data.snapshot;
    const subFilter = subreddit?.trim().toLowerCase();
    const filtered = subFilter
      ? s.posts.filter(p => p.subreddit.toLowerCase() === subFilter)
      : s.posts;
    const cap = Math.min(limit ?? 15, filtered.length);
    const fmtCount = (x: number) => x >= 1_000 ? `${(x / 1_000).toFixed(1)}K` : String(x);
    const lines = filtered.slice(0, cap).map((p, i) => {
      const author = p.author ? ` by ${p.author}` : '';
      const flair = p.flair ? ` [${p.flair}]` : '';
      return `${i + 1}. r/${p.subreddit}: ${p.title}${flair}\n     ${fmtCount(p.score)} pts, ${fmtCount(p.num_comments)} comments${author}\n     ${p.permalink}`;
    }).join('\n\n');
    const subs = Object.entries(s.summary.by_subreddit)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([sub, n]) => `r/${sub} (${n})`)
      .join(', ');
    let text = `Hot AI Reddit threads. ${s.date}, showing ${cap} of ${filtered.length}`;
    if (subFilter) text += ` (filtered to r/${subreddit})`;
    text += '.\n';
    if (subs && !subFilter) text += `Most-active subreddits: ${subs}\n`;
    text += '\n' + (lines || '  (no posts)');
    text += `\n\nSource: reddit.com. Captured ${s.capturedAt}.`;
    return { content: [{ type: 'text' as const, text }] };
  },
);

// ── Tool: get_openrouter_models (free) ──────────────────────────────

registerTool(
  'get_openrouter_models',
  'OpenRouter cross-provider model catalog (200+ models normalized across 50+ inference providers). Each entry has per-token pricing (prompt + completion + image + request), context window, modality (e.g. text+image->text), instruct_type, tokenizer, top provider metadata (max_completion_tokens, moderation flag), and supported_parameters. Use this to find the long tail of OSS models on cloud inference, including the cheapest model for a given workload, the model with the largest context window, or the free-tier set. Pairs with get_model_pricing (curated frontier-lab catalog). Refreshed daily at 14:00 UTC. Free, no auth.',
  {
    namespace: z.string().optional().describe('Optional filter to a single provider namespace (e.g. "anthropic", "openai", "meta-llama"). Case-insensitive.'),
    free_only: z.boolean().optional().describe('If true, return only models with prompt+completion both 0 (free-tier).'),
    cheapest: z.boolean().optional().describe('If true, sort by cheapest input price ascending. Free-tier models excluded from this sort.'),
    limit: z.number().min(1).max(50).optional().describe('Max models to render (default 20, max 50)'),
  },
  async ({ namespace, free_only, cheapest, limit }) => {
    const data = (await fetchJSON('/openrouter/models')) as {
      snapshot: {
        date: string;
        capturedAt: string;
        total_models: number;
        models: { id: string; name: string; context_length: number | null; modality: string | null; pricing: { prompt: number | null; completion: number | null; image: number | null; request: number | null } }[];
        summary: { by_namespace: { namespace: string; count: number }[]; cheapest_input: { id: string; usd_per_million: number } | null; cheapest_output: { id: string; usd_per_million: number } | null; largest_context: { id: string; tokens: number } | null; free_tier_count: number };
      };
    };
    const s = data.snapshot;
    const ns = namespace?.trim().toLowerCase();
    let list = s.models;
    if (ns) list = list.filter(m => m.id.toLowerCase().startsWith(ns + '/'));
    if (free_only) list = list.filter(m => m.pricing.prompt === 0 && m.pricing.completion === 0);
    if (cheapest) {
      list = list
        .filter(m => typeof m.pricing.prompt === 'number' && m.pricing.prompt > 0)
        .sort((a, b) => (a.pricing.prompt ?? 0) - (b.pricing.prompt ?? 0));
    }

    const cap = Math.min(limit ?? 20, list.length);
    const fmtPrice = (p: number | null) =>
      p === null ? '?' : p === 0 ? 'free' : `$${(p * 1_000_000).toFixed(2)}/Mtok`;
    const fmtCtx = (c: number | null) =>
      c === null ? 'unknown' : c >= 1_000_000 ? `${(c / 1_000_000).toFixed(0)}M` : `${(c / 1_000).toFixed(0)}K`;

    const lines = list.slice(0, cap).map((m, i) => {
      const modality = m.modality ? ` ${m.modality}` : '';
      return `${i + 1}. ${m.id}${modality}\n     in ${fmtPrice(m.pricing.prompt)}, out ${fmtPrice(m.pricing.completion)}, ctx ${fmtCtx(m.context_length)}`;
    }).join('\n\n');

    const namespaces = s.summary.by_namespace.slice(0, 5).map(n => `${n.namespace} (${n.count})`).join(', ');
    let header = `OpenRouter catalog. ${s.date}. ${s.total_models} models total, ${list.length} after filters, showing ${cap}.\n`;
    header += `Top provider namespaces: ${namespaces}\n`;
    if (s.summary.cheapest_input) header += `Cheapest input (paid): ${s.summary.cheapest_input.id} at $${s.summary.cheapest_input.usd_per_million.toFixed(2)}/Mtok\n`;
    if (s.summary.largest_context) header += `Largest context: ${s.summary.largest_context.id} at ${fmtCtx(s.summary.largest_context.tokens)} tokens\n`;
    header += `Free-tier models available: ${s.summary.free_tier_count}\n`;

    return {
      content: [
        {
          type: 'text' as const,
          text: header + '\n' + (lines || '  (no models match the filters)') + `\n\nSource: openrouter.ai. Captured ${s.capturedAt}.`,
        },
      ],
    };
  },
);

// ── Tool: get_hf_daily_papers (free) ────────────────────────────────

registerTool(
  'get_hf_daily_papers',
  'Hugging Face Daily Papers: editor-curated AI/ML papers from huggingface.co/papers, layered with community upvotes and discussion counts. Different signal from get_arxiv_recent (firehose) and get_ai_papers_trending (citation-ranked all-time): this is editor picks of-the-day with engagement signal. Each paper carries paperId, title, summary, authors, upvotes, num_comments, hf_url, arxiv_url (when applicable), github_repo, github_stars, ai_keywords. Refreshed daily at 14:30 UTC. Titles sanitized at capture time. Free, no auth.',
  {
    limit: z.number().min(1).max(30).optional().describe('Max papers to render (default 15, max 30)'),
  },
  async ({ limit }) => {
    const data = (await fetchJSON('/papers/hf-daily')) as {
      snapshot: {
        date: string;
        capturedAt: string;
        total_papers: number;
        papers: { paperId: string; title: string; authors: string[]; upvotes: number; num_comments: number; hf_url: string; arxiv_url: string | null; ai_keywords: string[] }[];
        summary: { by_keyword: { keyword: string; count: number }[]; most_upvoted: { paperId: string; title: string; upvotes: number } | null };
      };
    };
    const s = data.snapshot;
    const cap = Math.min(limit ?? 15, s.papers.length);
    const lines = s.papers.slice(0, cap).map((p, i) => {
      const authors = p.authors.slice(0, 3).join(', ') + (p.authors.length > 3 ? ' et al.' : '');
      const kw = p.ai_keywords.length > 0 ? `\n     keywords: ${p.ai_keywords.slice(0, 5).join(', ')}` : '';
      const arxiv = p.arxiv_url ? `\n     arxiv: ${p.arxiv_url}` : '';
      return `${i + 1}. ${p.title}\n     ${authors}\n     ${p.upvotes} upvotes, ${p.num_comments} comments\n     ${p.hf_url}${arxiv}${kw}`;
    }).join('\n\n');
    const kw = s.summary.by_keyword.slice(0, 5).map(k => `${k.keyword} (${k.count})`).join(', ');
    let text = `HF Daily Papers (editor-curated). ${s.date}, showing ${cap} of ${s.total_papers}.\n`;
    if (kw) text += `Top keywords: ${kw}\n`;
    if (s.summary.most_upvoted) text += `Most upvoted: "${s.summary.most_upvoted.title}" (${s.summary.most_upvoted.upvotes})\n`;
    text += '\n' + lines + `\n\nSource: huggingface.co/papers. Captured ${s.capturedAt}.`;
    return { content: [{ type: 'text' as const, text }] };
  },
);

// ── Start ───────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('TensorFeed MCP server running on stdio');
}

main().catch(console.error);
