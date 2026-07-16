// @vitest-environment happy-dom

import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearGoogleLoginAnalysisDraft,
  closeGoogleLoginAnalysisDraftDatabase,
  saveGoogleLoginAnalysisDraft,
  takeGoogleLoginAnalysisDraft
} from '../src/lib/oauthAnalysisDraft.js';

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

describe('Google OAuth analysis draft', () => {
  afterEach(async () => {
    await clearGoogleLoginAnalysisDraft();
  });

  it('restores the local analysis once and removes the temporary copy', async () => {
    const saved = await saveGoogleLoginAnalysisDraft({
      hands: [{ raw: rawHand }],
      hero: 'Hero',
      fileMeta: { files: 1, hands: 1 },
      startTp: '10',
      endTp: '20',
      datasetFilters: { timePreset: 'today', stakes: ['NL100'], gameTypes: [] },
      positionFilter: 'BTN',
      holeCardFilter: { ranks: ['A', null], suitedOnly: false },
      historyTab: 'history',
      postLoginAction: 'open-cloud-save'
    });
    expect(saved.handCount).toBe(1);

    const restored = await takeGoogleLoginAnalysisDraft();
    expect(restored.rawHands).toEqual([rawHand]);
    expect(restored.hero).toBe('Hero');
    expect(restored.fileMeta).toEqual({ files: 1, hands: 1 });
    expect(restored.datasetFilters.timePreset).toBe('today');
    expect(restored.positionFilter).toBe('BTN');
    expect(restored.holeCardFilter.ranks).toEqual(['A', null]);
    expect(restored.historyTab).toBe('history');
    expect(restored.postLoginAction).toBe('open-cloud-save');
    expect(await takeGoogleLoginAnalysisDraft()).toBeNull();
  });

  it('keeps a full 6,309-hand session across an OAuth reload', async () => {
    const hands = Array.from({ length: 6309 }, (_, index) => ({
      raw: rawHand.replace('#RC123', `#RC${String(index + 1).padStart(9, '0')}`)
    }));
    const saved = await saveGoogleLoginAnalysisDraft({ hands, hero: 'Hero' });
    expect(saved.handCount).toBe(6309);

    const restored = await takeGoogleLoginAnalysisDraft();
    expect(restored.handCount).toBe(6309);
    expect(restored.rawHands).toHaveLength(6309);
  });

  afterEach(async () => {
    await closeGoogleLoginAnalysisDraftDatabase();
  });
});
