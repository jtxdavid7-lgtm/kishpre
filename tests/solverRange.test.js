import { describe, expect, it } from 'vitest';

import {
  rangeMapToSolverText,
  solverTextToRangeMap,
  summarizeSolverRange
} from '../src/lib/solverRange.js';

describe('solver range matrix adapter', () => {
  it('serializes matrix weights to syntax accepted by postflop-solver', () => {
    expect(rangeMapToSolverText({
      AKo: { weight: 0.5 },
      AA: { weight: 1 },
      AKs: { weight: 0.75 }
    })).toBe('AA,AKs:0.75,AKo:0.5');
  });

  it('restores exact class imports and normalizes hand order', () => {
    expect(solverTextToRangeMap('aa, kas:0.25, ako:0.5')).toEqual({
      AA: { weight: 1 },
      AKs: { weight: 0.25 },
      AKo: { weight: 0.5 }
    });
    expect(solverTextToRangeMap('TT+,AKs')).toBeNull();
  });

  it('reports weighted combo coverage', () => {
    expect(summarizeSolverRange({ AA: { weight: 1 }, AKs: { weight: 0.5 } })).toEqual({
      cells: 2,
      combos: 8,
      coverage: 8 / 1326
    });
  });
});
