import { describe, it, expect } from 'vitest';
import { flattenCatalog, scoreEndpoints } from './discovery.js';

const CATALOG = {
  api: {
    getAiNews: '/api/news (free; latest AI news ranked list filterable by category)',
    pricingSeries: '/api/premium/history/pricing/series?model=&days= (1 credit; daily price points up to 90 days)',
    redditTrending: '/api/reddit-trending (free; trending AI posts from key subreddits)',
  },
};

describe('flattenCatalog', () => {
  it('flattens the meta api object into {key, path, description} rows', () => {
    const rows = flattenCatalog(CATALOG);
    expect(rows.length).toBe(3);
    const news = rows.find((r) => r.key === 'getAiNews');
    expect(news?.path).toBe('/api/news');
    expect(news?.description.toLowerCase()).toContain('latest ai news');
  });
  it('returns [] for malformed input', () => {
    expect(flattenCatalog(null)).toEqual([]);
    expect(flattenCatalog({})).toEqual([]);
  });
});

describe('scoreEndpoints', () => {
  it('ranks by keyword overlap and returns the top matches', () => {
    const rows = flattenCatalog(CATALOG);
    const top = scoreEndpoints(rows, 'trending reddit posts', 3);
    expect(top[0].key).toBe('redditTrending');
  });
  it('returns empty for no overlap', () => {
    const rows = flattenCatalog(CATALOG);
    expect(scoreEndpoints(rows, 'quantum chromodynamics', 3)).toEqual([]);
  });
});
