// The tensorfeed.ai page that shows each tool's data. A successful result
// ends with a Source line naming it, so an assistant that cites TensorFeed
// links a page a person can read rather than nothing or a JSON endpoint.
// Mirrors worker/src/mcp-pages.ts for the tools both servers share.
export const TOOL_PAGES: Record<string, string> = {
  get_ai_news: 'https://tensorfeed.ai',
  get_ai_status: 'https://tensorfeed.ai/status',
  is_service_down: 'https://tensorfeed.ai/status',
  get_model_pricing: 'https://tensorfeed.ai/models',
  route_verdict: 'https://tensorfeed.ai/intelligence',
  provider_reliability_verdict: 'https://tensorfeed.ai/status',
  failover_verdict: 'https://tensorfeed.ai/status',
  status_uptime: 'https://tensorfeed.ai/status',
  status_leaderboard: 'https://tensorfeed.ai/status',
  stack_safety_verdict: 'https://tensorfeed.ai/cve-watch',
  ssvc_verdict: 'https://tensorfeed.ai/cve-watch',
  benchmark_trust_verdict: 'https://tensorfeed.ai/benchmarks',
  benchmark_series: 'https://tensorfeed.ai/benchmarks',
  pricing_series: 'https://tensorfeed.ai/models',
  compare_models: 'https://tensorfeed.ai/compare',
};

type ToolResultLike = { content?: Array<{ type: string; text?: string }>; isError?: boolean };

/** Appends the Source line as its own content item, leaving the data text byte-identical. */
export function withSourceLine<T>(name: string, result: T): T {
  const page = TOOL_PAGES[name];
  const r = result as ToolResultLike;
  if (!page || !r || r.isError || !Array.isArray(r.content)) return result;
  return { ...r, content: [...r.content, { type: 'text' as const, text: `Source: ${page}` }] } as T;
}
