// @vitest-environment happy-dom

import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearPersonalAnalysisCache,
  closePersonalAnalysisCacheDatabase,
  compactPersonalAnalysisResult,
  loadPersonalAnalysisCache,
  prunePersonalAnalysisCache,
  savePersonalAnalysisSessions
} from '../src/lib/personalAnalysisCache.js';

const scope = {
  subjectId: 'user-cache-test',
  libraryId: 'library-cache-test',
  consentToken: 'consent-cache-test'
};

function session(id, handCount = 1) {
  return {
    id,
    handCount,
    hero: 'Hero',
    startedAt: '2026-08-19T10:00:00+08:00',
    endedAt: '2026-08-19T11:00:00+08:00',
    createdAt: '2026-08-19T12:00:00+08:00'
  };
}

function result(index) {
  return {
    id: `RC-${index}`,
    raw: 'Poker Hand #private raw text',
    cards: ['As', 'Ah'],
    board: ['2c', '3d', '4h'],
    date: `2026/08/19 10:${String(index % 60).padStart(2, '0')}:00`,
    stakes: 'NL100',
    bb: 1,
    gameVariant: 'holdem',
    bettingStructure: 'no_limit',
    tableType: 'rush_cash',
    maxPlayers: 6,
    analysisSupported: true,
    position: 'BTN',
    profit: 2,
    profitBB: 2,
    rake: 0.25,
    jackpot: 0,
    allInEvBeforeRakeBB: 2.25,
    heroVoluntary: true,
    heroRaise: true,
    sawFlop: true,
    wentToShowdown: false,
    wonWhenSawFlop: true,
    postflop: { flop: { cbetOpportunity: true, cbet: true } }
  };
}

afterEach(async () => {
  await clearPersonalAnalysisCache(scope).catch(() => null);
  await closePersonalAnalysisCacheDatabase();
});

describe('personal analysis IndexedDB cache', () => {
  it('stores chunked derived results without raw hands, cards or boards', async () => {
    const sourceResults = Array.from({ length: 1005 }, (_, index) => result(index));
    await savePersonalAnalysisSessions({
      ...scope,
      entries: [{ session: session('session-1', 1005), results: sourceResults, sourceHandCount: 1005 }]
    });

    const loaded = await loadPersonalAnalysisCache({
      ...scope,
      sessions: [session('session-1', 1005)]
    });

    expect(loaded.cachedSessionIds).toEqual(['session-1']);
    expect(loaded.results).toHaveLength(1005);
    expect(loaded.results[0]).toMatchObject({ stakes: 'NL100', position: 'BTN', profitBB: 2 });
    expect(loaded.results[0]).not.toHaveProperty('raw');
    expect(loaded.results[0]).not.toHaveProperty('cards');
    expect(loaded.results[0]).not.toHaveProperty('board');
  });

  it('invalidates changed sessions and prunes deleted sessions', async () => {
    await savePersonalAnalysisSessions({
      ...scope,
      entries: [
        { session: session('session-1'), results: [result(1)] },
        { session: session('session-2'), results: [result(2)] }
      ]
    });

    const changed = await loadPersonalAnalysisCache({
      ...scope,
      sessions: [session('session-1', 2), session('session-2')]
    });
    expect(changed.cachedSessionIds).toEqual(['session-2']);

    expect(await prunePersonalAnalysisCache({
      ...scope,
      activeSessionIds: ['session-1']
    })).toBe(1);
    const pruned = await loadPersonalAnalysisCache({
      ...scope,
      sessions: [session('session-1'), session('session-2')]
    });
    expect(pruned.cachedSessionIds).toEqual(['session-1']);
  });

  it('isolates consent scopes and compacting preserves only report fields', async () => {
    await savePersonalAnalysisSessions({
      ...scope,
      entries: [{ session: session('session-1'), results: [result(1)] }]
    });
    const otherConsent = await loadPersonalAnalysisCache({
      ...scope,
      consentToken: 'different-consent',
      sessions: [session('session-1')]
    });
    expect(otherConsent.results).toEqual([]);
    expect(compactPersonalAnalysisResult(result(1))).not.toHaveProperty('id');
  });
});
