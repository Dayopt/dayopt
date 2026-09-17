import { describe, expect, it } from 'vitest';
import { isActivityVisible } from './activity-visibility';

describe('initial activity visibility', () => {
  it('shows a known activity before filter initialization, so SSR can render the card', () => {
    expect(isActivityVisible('activity', false, new Set())).toBe(true);
  });
  it('honors an explicitly empty selection after initialization', () => {
    expect(isActivityVisible('activity', true, new Set())).toBe(false);
  });
  it('honors selected and hidden activities', () => {
    expect(isActivityVisible('selected', true, new Set(['selected']))).toBe(true);
    expect(isActivityVisible('hidden', true, new Set(['selected']))).toBe(false);
  });
  it('always shows records without an activity', () => {
    expect(isActivityVisible(null, true, new Set())).toBe(true);
  });
});
