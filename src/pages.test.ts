import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOL_PAGES, withSourceLine } from './pages';

const HERE = dirname(fileURLToPath(import.meta.url));

describe('TOOL_PAGES', () => {
  it('names only tools this server registers', () => {
    const src = readFileSync(join(HERE, 'index.ts'), 'utf8');
    for (const name of Object.keys(TOOL_PAGES)) {
      expect(src.includes(`'${name}'`), name).toBe(true);
    }
  });

  it('points only at tensorfeed.ai pages, never API paths', () => {
    for (const url of Object.values(TOOL_PAGES)) {
      expect(url.startsWith('https://tensorfeed.ai')).toBe(true);
      expect(url.includes('/api/')).toBe(false);
    }
  });
});

describe('withSourceLine', () => {
  it('appends a separate Source item and leaves the data text untouched', () => {
    const result = { content: [{ type: 'text', text: '{"signed":"payload"}' }] };
    const out = withSourceLine('get_ai_status', result);
    expect(out.content[0]).toEqual({ type: 'text', text: '{"signed":"payload"}' });
    expect(out.content[1]).toEqual({ type: 'text', text: 'Source: https://tensorfeed.ai/status' });
  });

  it('skips errors and unmapped tools', () => {
    const err = { content: [{ type: 'text', text: 'boom' }], isError: true };
    expect(withSourceLine('get_ai_status', err)).toBe(err);
    const other = { content: [{ type: 'text', text: 'x' }] };
    expect(withSourceLine('account_status', other)).toBe(other);
  });
});
