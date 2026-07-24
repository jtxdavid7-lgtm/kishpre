import { describe, expect, it } from 'vitest';

function permutations(values) {
  if (values.length === 1) return [values];
  return values.flatMap((value, index) => permutations(
    values.filter((_, itemIndex) => itemIndex !== index)
  ).map((tail) => [value, ...tail]));
}

const suitPermutations = permutations([0, 1, 2, 3]);
const mapCard = (card, suits) => Math.floor(card / 4) * 4 + suits[card % 4];

function canonicalFlop(cards) {
  return suitPermutations
    .map((suits) => cards.map((card) => mapCard(card, suits)).sort((left, right) => left - right))
    .sort((left, right) => {
      for (let index = 0; index < left.length; index += 1) {
        if (left[index] !== right[index]) return left[index] - right[index];
      }
      return 0;
    })[0];
}

function enumerateFlops() {
  const flops = new Map();
  for (let first = 0; first < 52; first += 1) {
    for (let second = first + 1; second < 52; second += 1) {
      for (let third = second + 1; third < 52; third += 1) {
        const flop = canonicalFlop([first, second, third]);
        flops.set(flop.join('-'), flop);
      }
    }
  }
  return [...flops.values()];
}

function enumerateTurns(flop) {
  const normalizedFlop = [...flop].sort((left, right) => left - right);
  const used = new Set(normalizedFlop);
  const stabilizer = suitPermutations.filter((suits) => {
    const mapped = normalizedFlop
      .map((card) => mapCard(card, suits))
      .sort((left, right) => left - right);
    return mapped.every((card, index) => card === normalizedFlop[index]);
  });
  const turns = new Map();
  for (let card = 0; card < 52; card += 1) {
    if (used.has(card)) continue;
    const orbit = [...new Set(stabilizer.map((suits) => mapCard(card, suits)))];
    const representative = Math.min(...orbit);
    if (!turns.has(representative)) turns.set(representative, orbit.length);
  }
  return turns;
}

describe('canonical turn enumeration', () => {
  it('covers all 49 physical turns for symmetric and asymmetric canonical flops', () => {
    for (const flop of [[0, 1, 2], [0, 4, 8], [0, 5, 10], [48, 22, 3]]) {
      const turns = enumerateTurns(flop);
      expect([...turns.values()].reduce((sum, value) => sum + value, 0)).toBe(49);
      expect(turns.size).toBeGreaterThanOrEqual(23);
      expect(turns.size).toBeLessThanOrEqual(49);
    }
  });

  it('produces exactly 63,193 ordered canonical flop-turn histories', () => {
    const flops = enumerateFlops();
    expect(flops).toHaveLength(1755);
    const historyCount = flops.reduce((sum, flop) => sum + enumerateTurns(flop).size, 0);
    expect(historyCount).toBe(63193);
  });
});
