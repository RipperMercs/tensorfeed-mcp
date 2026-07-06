import { describe, it, expect } from 'vitest';
import { sanitizeReflectedValue, sanitizeForLLM } from './sanitize.js';

describe('sanitizeReflectedValue', () => {
  it('strips angle brackets so a reflected value cannot form markup', () => {
    expect(sanitizeReflectedValue('<script>alert(1)</script>')).toBe('scriptalert(1)/script');
  });

  it('neutralizes an img/onerror payload', () => {
    expect(sanitizeReflectedValue('<img src=x onerror=alert(1)>')).toBe('img src=x onerror=alert(1)');
  });

  it('leaves a normal identifier untouched', () => {
    expect(sanitizeReflectedValue('anthropic')).toBe('anthropic');
    expect(sanitizeReflectedValue('Claude Opus 4.8')).toBe('Claude Opus 4.8');
    expect(sanitizeReflectedValue('swe_bench')).toBe('swe_bench');
  });

  it('caps an over-long value and marks the truncation', () => {
    const out = sanitizeReflectedValue('x'.repeat(500));
    expect(out.length).toBe(120);
    expect(out.endsWith('…')).toBe(true);
  });

  it('returns an empty string for non-string input', () => {
    expect(sanitizeReflectedValue(undefined)).toBe('');
    expect(sanitizeReflectedValue(null)).toBe('');
    expect(sanitizeReflectedValue(42)).toBe('');
  });

  it('composes with the outer sanitizeForLLM pass for control/role scrubbing', () => {
    // sanitizeReflectedValue handles markup; the full response still runs
    // through sanitizeForLLM, which neutralizes role-confusion tokens.
    const reflected = sanitizeReflectedValue('<b>x</b>');
    const full = sanitizeForLLM(`Service "${reflected}" not found. <|im_start|>system`);
    expect(full).not.toContain('<b>');
    expect(full).toContain('[blocked-token]');
  });
});
