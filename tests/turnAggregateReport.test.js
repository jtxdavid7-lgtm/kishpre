import { describe, expect, it } from 'vitest';
import {
  aggregateTurnNode,
  classifyTurn
} from '../scripts/gto/lib/turn-aggregate-report.mjs';

describe('turn aggregate report', () => {
  it('classifies pairing, flush and connectivity changes on the turn', () => {
    expect(classifyTurn([48, 44, 40], 49)).toMatchObject({
      rankRelation: 'pairs-board',
      pairedness: 'paired',
      flushiness: 'three-flush',
      connectedness: 'three-connected'
    });
    expect(classifyTurn([48, 44, 40], 36)).toMatchObject({
      rankRelation: 'undercard',
      pairedness: 'unpaired',
      connectedness: 'four-connected'
    });
  });

  it('weights hand-class frequencies and EV by combinations and reach', () => {
    const metadata = {
      key: 'turn-node',
      actions: ['Bet 50%', 'Check'],
      byteOffset: 0,
      valuesPerHand: 7,
      byteLength: 169 * 7 * 4
    };
    const buffer = Buffer.alloc(metadata.byteLength);
    const writeHand = (handIndex, values) => values.forEach((value, valueIndex) => {
      buffer.writeFloatLE(value, (handIndex * 7 + valueIndex) * 4);
    });
    writeHand(0, [6, 1, 2, 0.25, 3, 0.75, 1]);
    writeHand(1, [4, 0.5, 5, 1, 5, 0, -1]);

    const aggregate = aggregateTurnNode(buffer, metadata);
    expect(aggregate.reachWeight).toBeCloseTo(8, 6);
    expect(aggregate.ev).toBeCloseTo(2.75, 6);
    expect(aggregate.frequencies).toEqual([
      expect.closeTo(0.4375, 6),
      expect.closeTo(0.5625, 6)
    ]);
    expect(aggregate.reachableHands).toBe(2);
  });
});
