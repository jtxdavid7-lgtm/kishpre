import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildWebsiteExport,
  decodeCompactPackNode,
  solverMatrixLabels
} from '../scripts/solver-ui/compact-pack.mjs';

const temporaryDirectories = [];

function fixtureComboCards(comboIndex) {
  let remaining = comboIndex;
  for (let lowCard = 0; lowCard < 51; lowCard += 1) {
    const rowLength = 51 - lowCard;
    if (remaining < rowLength) return [lowCard + 1 + remaining, lowCard];
    remaining -= rowLength;
  }
  throw new Error(`invalid fixture combo ${comboIndex}`);
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true })
  ));
});

async function compactFixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kish-solver-pack-'));
  temporaryDirectories.push(directory);
  await fs.mkdir(path.join(directory, 'groups'));
  const valuesPerRow = 6;
  const buffer = Buffer.alloc(1326 * valuesPerRow * 4);
  for (let index = 0; index < 1326; index += 1) {
    const offset = index * valuesPerRow * 4;
    if (fixtureComboCards(index).includes(50)) {
      buffer.writeFloatLE(Number.NaN, offset);
      continue;
    }
    buffer.writeFloatLE(1, offset);
    buffer.writeFloatLE(index === 0 ? 3 : 2, offset + 4);
    buffer.writeFloatLE(0.25, offset + 8);
    buffer.writeFloatLE(1.5, offset + 12);
    buffer.writeFloatLE(0.75, offset + 16);
    buffer.writeFloatLE(2.25, offset + 20);
  }
  const asset = 'groups/flop.f32le';
  await fs.writeFile(path.join(directory, asset), buffer);
  const manifest = {
    compactPackSchemaVersion: 1,
    exactComboFormat: { comboCount: 1326 },
    board: [28, 45, 50],
    boardText: ['9h', 'Ks', 'Ad'],
    releaseStatus: 'smoke-diagnostic',
    releaseEligible: false,
    solve: { maxIterations: 64, finalExploitabilityPotFraction: 0.001 },
    economics: { modelId: 'fixture' },
    treeHash: 'tree',
    rangeHash: 'range',
    modelHash: 'model',
    provenance: { inputSha256: 'input' },
    coverage: { exportedDecisionNodes: 1 },
    groups: [{
      id: 'flop',
      asset,
      uncompressedBytes: buffer.length,
      sha256: createHash('sha256').update(buffer).digest('hex')
    }],
    nodes: [{
      id: 0,
      key: 'root',
      actor: 'OOP',
      street: 'flop',
      currentBoard: [28, 45, 50],
      currentBoardText: ['9h', 'Ks', 'Ad'],
      history: [],
      state: { potBb: 17.5 },
      actions: [
        { id: 'Check', kind: 'check', amountBb: 0 },
        { id: 'Bet 4.37', kind: 'bet', amountBb: 4.37 }
      ],
      exactComboLayout: {
        groupId: 'flop',
        byteOffset: 0,
        byteLength: buffer.length,
        valuesPerRow
      }
    }]
  };
  await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  return directory;
}

describe('solver compact pack web adapter', () => {
  it('uses conventional 13x13 label ordering', () => {
    const labels = solverMatrixLabels();
    expect(labels).toHaveLength(169);
    expect(labels.slice(0, 4)).toEqual(['AA', 'AKs', 'AQs', 'AJs']);
    expect(labels[13]).toBe('AKo');
    expect(labels.at(-1)).toBe('22');
  });

  it('decodes exact combos into weighted matrix frequencies and EV', async () => {
    const directory = await compactFixture();
    const result = await decodeCompactPackNode(directory, 0);
    expect(result.nodes).toHaveLength(1);
    expect(result.selectedNode.matrix).toHaveLength(169);
    expect(result.selectedNode.aggregate.actions.Check).toBeCloseTo(0.25);
    expect(result.selectedNode.aggregate.totalEv).toBeCloseTo(2);
    expect(result.selectedNode.matrix.find((hand) => hand.label === 'AKs').actions.Check)
      .toBeCloseTo(0.25);
    const aces = result.selectedNode.matrix.find((hand) => hand.label === 'AA');
    expect(aces.combinations).toBe(3);
    expect(aces.combos).toHaveLength(3);
    expect(aces.combos.every((combo) => !combo.cards.includes('Ad'))).toBe(true);
    const deuces = result.selectedNode.matrix.find((hand) => hand.label === '22');
    expect(new Set(deuces.combos.map((combo) => combo.totalEv))).toEqual(new Set([2, 3]));
    expect(deuces.combos[0]).toMatchObject({
      cards: ['2s', '2h'],
      totalEv: 3,
      actions: { Check: 0.25, 'Bet 4.37': 0.75 },
      actionEvs: { Check: 1.5, 'Bet 4.37': 2.25 }
    });
  });

  it('builds a self-contained website-readable export', async () => {
    const directory = await compactFixture();
    const result = await buildWebsiteExport(directory);
    expect(result.format).toBe('kishpoker-postflop-solver-website-export-v1');
    expect(result.nodes[0].matrix).toHaveLength(169);
    expect(result.source).toMatchObject({ treeHash: 'tree', rangeHash: 'range' });
  });
});
