import { describe, expect, it } from 'vitest';
import { parseGgHand, summarizeHeroResults } from '../src/lib/handHistoryAnalyzer.js';
import {
  compactParsedHand,
  hydrateImportedHand,
  iterateGgHandHistories,
  primaryHeroFromChunks
} from '../src/lib/handHistoryImport.js';

const rawHand = `Poker Hand #RC123: Hold'em No Limit ($0.50/$1.00) - 2026/07/16 12:00:00
Table 'RushAndCash123' 6-max Seat #1 is the button
Seat 1: Hero ($100 in chips)
Seat 2: Villain ($100 in chips)
*** HOLE CARDS ***
Dealt to Hero [As Ah]
Hero: raises $2 to $2
Villain: folds
Uncalled bet ($1) returned to Hero
Hero collected $1 from pot
*** SUMMARY ***`;

describe('large hand-history import helpers', () => {
  it('iterates concatenated hands without building a split array', () => {
    const input = Array.from({ length: 1000 }, (_, index) => (
      rawHand.replace('#RC123', `#RC${index + 1}`)
    )).join('\r\n\r\n');

    expect([...iterateGgHandHistories(input)]).toHaveLength(1000);
  });

  it('selects the same primary dealt-to player across chunks', () => {
    const otherHero = rawHand
      .replace('#RC123', '#RC999')
      .replaceAll('Hero', 'SecondHero');
    const chunks = [{ text: `${rawHand}\n\n${rawHand.replace('#RC123', '#RC124')}` }, { text: otherHero }];

    expect(primaryHeroFromChunks(chunks)).toBe('Hero');
  });

  it('keeps the default Hero result while removing parser closures from the transferred object', () => {
    const parsed = parseGgHand(rawHand);
    const expected = parsed.getHeroResult('Hero');
    const transferred = structuredClone(compactParsedHand(parsed, 'Hero'));

    expect(transferred.getHeroResult).toBeUndefined();
    const hydrated = hydrateImportedHand(transferred);
    expect(hydrated.getHeroResult('Hero')).toEqual(expected);
    expect(hydrated.getHeroResult('Villain')).toEqual(parsed.getHeroResult('Villain'));
    expect(hydrated.getHeroResult('NotAtThisTable')).toBeNull();
  });

  it('can summarize cloud metadata without allocating a full bankroll curve', () => {
    const result = parseGgHand(rawHand).getHeroResult('Hero');
    const summary = summarizeHeroResults([result], { includeCurve: false });

    expect(summary.totalHands).toBe(1);
    expect(summary.curve).toEqual([]);
  });
});
