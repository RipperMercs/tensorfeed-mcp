export interface EndpointRow {
  key: string;
  path: string;
  description: string;
}

/** Flatten the /api/meta `api` object ({key: 'path (desc)'}) into rows. */
export function flattenCatalog(meta: unknown): EndpointRow[] {
  const api = (meta as { api?: Record<string, unknown> } | null)?.api;
  if (!api || typeof api !== 'object') return [];
  const rows: EndpointRow[] = [];
  for (const [key, val] of Object.entries(api)) {
    if (typeof val !== 'string') continue;
    const m = val.match(/^(\S+)\s*(.*)$/);
    const path = m ? m[1] : val;
    const description = m ? m[2].replace(/^\(/, '').replace(/\)$/, '') : '';
    rows.push({ key, path, description });
  }
  return rows;
}

const STOP = new Set(['the', 'a', 'an', 'for', 'of', 'to', 'and', 'or', 'in', 'on', 'with', 'me', 'get', 'find', 'data', 'i', 'need', 'want', 'my']);

function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2 && !STOP.has(t));
}

/** Keyword-overlap score of a query against each row's key + description. Returns top N with score > 0. */
export function scoreEndpoints(rows: EndpointRow[], query: string, limit: number): EndpointRow[] {
  const q = new Set(tokenize(query));
  if (q.size === 0) return [];
  const scored = rows
    .map((r) => {
      const hay = tokenize(r.key + ' ' + r.description);
      let score = 0;
      for (const t of hay) if (q.has(t)) score += 1;
      return { r, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((x) => x.r);
}
