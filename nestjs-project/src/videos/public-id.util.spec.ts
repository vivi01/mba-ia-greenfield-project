import { generatePublicId, PUBLIC_ID_LENGTH } from './public-id.util';

describe('generatePublicId', () => {
  it('returns a fixed-length string', () => {
    expect(generatePublicId()).toHaveLength(PUBLIC_ID_LENGTH);
  });

  it('contains only URL-safe characters (no URL-encoding needed)', () => {
    for (let i = 0; i < 100; i++) {
      expect(generatePublicId()).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('produces different values on consecutive calls', () => {
    expect(generatePublicId()).not.toBe(generatePublicId());
  });

  it('has no collisions across a sample of 10,000 ids', () => {
    const sample = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      sample.add(generatePublicId());
    }
    expect(sample.size).toBe(10_000);
  });
});
