import { describe, it, expect } from 'vitest';
import { containsProfanity } from './profanity';

describe('containsProfanity', () => {
  it('passes clean EAM transcript text', () => {
    expect(containsProfanity('SKYKING SKYKING DO NOT ANSWER PT3 14 AB')).toBe(false);
  });

  it('passes empty text', () => {
    expect(containsProfanity('')).toBe(false);
  });

  it('trips on obvious profanity', () => {
    expect(containsProfanity('this is fucking garbage')).toBe(true);
  });
});
