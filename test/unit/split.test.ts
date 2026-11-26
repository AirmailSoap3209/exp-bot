import { describe, expect, it } from 'vitest';
import { splitMessage } from '../../src/commands/split.js';

describe('splitMessage', () => {
  it('keeps short replies whole', () => {
    expect(splitMessage('a\nb')).toEqual(['a\nb']);
    expect(splitMessage('')).toEqual(['']);
  });

  it('splits at line breaks, every part under the limit, nothing lost', () => {
    const text = Array.from({ length: 60 }, (_, i) => `• Stat ${i} +${i * 1000} (0.${i} per item)`).join('\n');
    const parts = splitMessage(text, 200);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(200);
    expect(parts.join('\n')).toBe(text);
  });

  it('cuts a single line longer than the limit', () => {
    const parts = splitMessage('x'.repeat(450), 200);
    expect(parts.map((p) => p.length)).toEqual([200, 200, 50]);
  });
});
