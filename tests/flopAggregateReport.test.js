import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildCanonicalFlopMultiplicities,
  buildFlopAggregateReport,
  canonicalFlop,
  classifyFlop
} from '../scripts/gto/lib/flop-aggregate-report.mjs';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(
    (directory) => fs.rm(directory, { recursive: true, force: true })
  ));
});

describe('flop aggregate report', () => {
  it('enumerates all 1,755 suit-isomorphic flops with 22,100 concrete boards', () => {
    const multiplicities = buildCanonicalFlopMultiplicities();
    expect(multiplicities.size).toBe(1755);
    expect([...multiplicities.values()].reduce((sum, value) => sum + value, 0)).toBe(22100);
    expect(canonicalFlop([48, 21, 2])).toEqual(canonicalFlop([51, 22, 1]));
  });

  it('classifies common flop textures without discarding rank or suit structure', () => {
    expect(classifyFlop([48, 44, 40])).toMatchObject({
      highRank: 14,
      pairedness: 'unpaired',
      suitedness: 'monotone',
      connectedness: 'connected',
      broadwayCount: 3
    });
    expect(classifyFlop([48, 49, 4])).toMatchObject({
      pairedness: 'paired',
      suitedness: 'two-tone'
    });
  });

  it('weights action frequencies by combo reach and canonical-board multiplicity', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kish-flop-report-'));
    temporaryDirectories.push(directory);
    const board = canonicalFlop([48, 44, 40]);
    const id = 'sample';
    const actions = ['Bet 33%', 'Check'];
    const valuesPerCombo = 2 + actions.length * 2;
    const payload = Buffer.alloc(1326 * valuesPerCombo * 4, 0);
    for (let comboIndex = 0; comboIndex < 1326; comboIndex += 1) {
      const offset = comboIndex * valuesPerCombo * 4;
      payload.writeFloatLE(comboIndex < 2 ? 1 : 0, offset);
      payload.writeFloatLE(comboIndex === 0 ? 2 : 4, offset + 4);
      payload.writeFloatLE(comboIndex === 0 ? 0.25 : 0.75, offset + 8);
      payload.writeFloatLE(2, offset + 12);
      payload.writeFloatLE(comboIndex === 0 ? 0.75 : 0.25, offset + 16);
      payload.writeFloatLE(3, offset + 20);
    }
    const metadata = {
      schemaVersion: 1,
      id,
      board,
      comboCount: 1326,
      nodes: [{
        key: '["Root"]',
        state: {
          pot: 5.5,
          spr: 17.7,
          players: [{ position: 8, isCurrent: true }]
        },
        actions,
        byteOffset: 0,
        byteLength: payload.length,
        valuesPerCombo
      }]
    };
    await Promise.all([
      fs.writeFile(path.join(directory, `${id}.bin`), payload),
      fs.writeFile(path.join(directory, `${id}.json`), JSON.stringify(metadata)),
      fs.writeFile(path.join(directory, 'checkpoint.json'), JSON.stringify({
        requestedFlops: 1755,
        failures: [],
        completed: [{
          id,
          board,
          dataFilename: `${id}.bin`,
          metadataFilename: `${id}.json`
        }]
      }))
    ]);

    const report = await buildFlopAggregateReport({
      inputDirectory: directory,
      allowPartial: true
    });
    const root = report.nodes[0];
    expect(report.partial).toBe(true);
    expect(root.boards[0].validCombos).toBe(1326);
    expect(root.boards[0].reachableCombos).toBe(2);
    expect(root.boards[0].frequencies).toEqual([0.5, 0.5]);
    expect(root.boards[0].ev).toBe(3);
    expect(root.aggregate.frequencies).toEqual([0.5, 0.5]);
  });
});
