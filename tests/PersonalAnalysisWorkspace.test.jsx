// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PersonalAnalysisWorkspace } from '../src/components/PersonalAnalysisWorkspace.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let authValue;
const loadCloudLibraryIndex = vi.fn();
const loadCloudLibraryHands = vi.fn();
const loadCloudLibrarySessionHands = vi.fn();
const acceptOperatorArchivePreference = vi.fn();
const archiveImportedHands = vi.fn();
const disableOperatorArchivePreference = vi.fn();
const getOperatorArchivePreference = vi.fn();
const resolveOperatorArchiveConsent = vi.fn();
const clearPersonalAnalysisCache = vi.fn();
const loadPersonalAnalysisCache = vi.fn();
const prunePersonalAnalysisCache = vi.fn();
const savePersonalAnalysisSessions = vi.fn();

vi.mock('../src/auth/AuthProvider.jsx', () => ({
  useAuth: () => authValue
}));

vi.mock('../src/lib/cloudLibrary.js', () => ({
  loadCloudLibraryIndex: (...args) => loadCloudLibraryIndex(...args),
  loadCloudLibraryHands: (...args) => loadCloudLibraryHands(...args),
  loadCloudLibrarySessionHands: (...args) => loadCloudLibrarySessionHands(...args)
}));

vi.mock('../src/lib/personalAnalysisCache.js', () => ({
  clearPersonalAnalysisCache: (...args) => clearPersonalAnalysisCache(...args),
  loadPersonalAnalysisCache: (...args) => loadPersonalAnalysisCache(...args),
  prunePersonalAnalysisCache: (...args) => prunePersonalAnalysisCache(...args),
  savePersonalAnalysisSessions: (...args) => savePersonalAnalysisSessions(...args)
}));

vi.mock('../src/lib/operatorArchive.js', () => ({
  acceptOperatorArchivePreference: (...args) => acceptOperatorArchivePreference(...args),
  archiveImportedHands: (...args) => archiveImportedHands(...args),
  disableOperatorArchivePreference: (...args) => disableOperatorArchivePreference(...args),
  getOperatorArchivePreference: (...args) => getOperatorArchivePreference(...args),
  resolveOperatorArchiveConsent: (...args) => resolveOperatorArchiveConsent(...args)
}));

let root;
let container;

async function renderWorkspace() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<PersonalAnalysisWorkspace />);
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function cloudHand({ id, profit, position, wentToShowdown, stakes = 'NL100' }) {
  const result = {
    id,
    date: `2026/08/1${id} 12:00:00`,
    stakes,
    bb: 1,
    position,
    profit,
    profitBB: profit,
    rake: 0.5,
    jackpot: 0,
    allInEvBeforeRakeBB: profit + 0.5,
    allInEvOpportunity: false,
    allInEvCovered: false,
    sawFlop: true,
    wentToShowdown,
    wonAtShowdown: wentToShowdown && profit > 0,
    wonWhenSawFlop: profit > 0,
    heroVoluntary: true,
    heroRaise: id === '1',
    heroThreeBetOpportunity: true,
    heroFacingRaise: true,
    heroThreeBet: id === '1',
    heroSqueezeOpportunity: false,
    heroSqueeze: false,
    heroFourBetOpportunity: false,
    heroFourBet: false,
    heroFoldToThreeBetOpportunity: false,
    heroFoldToThreeBet: false,
    heroFoldToFourBetOpportunity: false,
    heroFoldToFourBet: false,
    heroStealOpportunity: false,
    heroSteal: false,
    heroStealBtnOpportunity: false,
    heroStealBtn: false,
    heroStealSbOpportunity: false,
    heroStealSb: false,
    postflop: {}
  };
  return {
    id,
    analysisHero: 'SavedHero',
    heroCandidates: ['AutoDetectedHero'],
    getHeroResult: (hero) => {
      if (hero === 'SavedHero') return result;
      if (hero === 'AutoDetectedHero') return { ...result, profit: 100, profitBB: 100 };
      return null;
    }
  };
}

beforeEach(() => {
  authValue = {
    authStatus: 'guest',
    isAuthenticated: false,
    openLogin: vi.fn()
  };
  getOperatorArchivePreference.mockReturnValue(null);
  resolveOperatorArchiveConsent.mockResolvedValue(null);
  loadCloudLibraryIndex.mockResolvedValue({ library: null, sessions: [] });
  loadCloudLibraryHands.mockResolvedValue({ library: null, hands: [] });
  loadCloudLibrarySessionHands.mockResolvedValue({ library: null, hands: [] });
  loadPersonalAnalysisCache.mockResolvedValue({
    results: [],
    cachedSessionIds: [],
    cachedSourceHandCount: 0,
    cachedResultCount: 0
  });
  savePersonalAnalysisSessions.mockResolvedValue({ sessions: 0, results: 0 });
  prunePersonalAnalysisCache.mockResolvedValue(0);
  clearPersonalAnalysisCache.mockResolvedValue(0);
  archiveImportedHands.mockResolvedValue({ status: 'completed', totalCount: 0 });
  acceptOperatorArchivePreference.mockResolvedValue({
    subjectId: 'user-1',
    consentToken: '00000000-0000-4000-8000-000000000001',
    acceptedAt: '2026-07-17T00:00:00.000Z'
  });
});

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

describe('PersonalAnalysisWorkspace access gate', () => {
  it('keeps advanced analytics locked for guests', async () => {
    await renderWorkspace();

    expect(container.textContent).toContain('登录后分析你的长期牌谱');
    expect(container.textContent).toContain('仅分析当前 Session');
    expect(container.textContent).not.toContain('选择分析样本');
  });

  it('requires explicit contribution consent before showing the dataset workspace', async () => {
    authValue = {
      authStatus: 'authenticated',
      isAuthenticated: true,
      openLogin: vi.fn()
    };
    loadCloudLibraryIndex.mockResolvedValue({
      library: { id: 'library-1', name: '我的牌谱' },
      sessions: [{
        id: 'session-1',
        handCount: 120,
        summary: { stakes: [{ label: 'NL100', count: 120 }], gameTypes: [] }
      }]
    });

    await renderWorkspace();
    await settle();

    expect(container.textContent).toContain('免费使用高级分析，需要贡献所分析的牌谱');
    expect(container.textContent).not.toContain('选择分析样本');

    const checkbox = container.querySelector('input[type="checkbox"]');
    const acceptButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent.includes('同意条件并开启高级分析'));
    expect(acceptButton.disabled).toBe(true);

    await act(async () => {
      checkbox.click();
    });
    expect(acceptButton.disabled).toBe(false);

    await act(async () => {
      acceptButton.click();
      await Promise.resolve();
    });

    expect(acceptOperatorArchivePreference).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('选择分析样本');
  });

  it('calculates the signed-in library from per-hand Hero results and renders the full chart and data report', async () => {
    const consent = {
      subjectId: 'user-1',
      consentToken: '00000000-0000-4000-8000-000000000001',
      acceptedAt: '2026-08-19T00:00:00.000Z'
    };
    authValue = {
      authStatus: 'authenticated',
      isAuthenticated: true,
      openLogin: vi.fn()
    };
    getOperatorArchivePreference.mockReturnValue('accepted');
    resolveOperatorArchiveConsent.mockResolvedValue(consent);
    loadCloudLibraryIndex.mockResolvedValue({
      library: { id: 'library-1', name: '我的牌谱' },
      sessions: [{
        id: 'session-1',
        handCount: 2,
        summary: {
          stakes: [{ label: 'NL100', count: 2 }],
          gameTypes: []
        }
      }]
    });
    const hands = [
      cloudHand({ id: '1', profit: 4, position: 'BTN', wentToShowdown: true }),
      cloudHand({ id: '2', profit: -1, position: 'BB', wentToShowdown: false })
    ];
    loadCloudLibrarySessionHands.mockResolvedValue({ library: { id: 'library-1' }, hands });
    archiveImportedHands.mockResolvedValue({ status: 'completed', totalCount: 2 });

    await renderWorkspace();
    await settle();

    const analyzeButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent.includes('分析所选牌谱'));
    await act(async () => {
      analyzeButton.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(loadCloudLibrarySessionHands).toHaveBeenCalledWith(expect.objectContaining({
      libraryId: 'library-1',
      sessionIds: ['session-1']
    }));
    expect(archiveImportedHands).toHaveBeenCalledWith(expect.objectContaining({ hands }));
    expect(container.textContent).toContain('2 手牌分析结果');
    expect(container.textContent).toContain('+3.0 BB');
    expect(container.textContent).toContain('整座牌谱库资金曲线');
    expect(container.querySelector('[aria-label="个人牌库资金曲线"]')).not.toBeNull();
    expect(container.textContent).toContain('位置分布');
    expect(container.textContent).toContain('级别分布');

    const dataTab = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === '数据分析');
    await act(async () => dataTab.click());

    expect(container.textContent).toContain('Fold to 4Bet');
    expect(container.textContent).toContain('翻牌圈');
    expect(container.textContent).toContain('河牌圈');
    expect(container.textContent).toContain('次机会');
  });

  it('reuses cached derived results without downloading or archiving the library again', async () => {
    const consent = {
      subjectId: 'user-1',
      consentToken: '00000000-0000-4000-8000-000000000001',
      acceptedAt: '2026-08-19T00:00:00.000Z'
    };
    const cachedResult = cloudHand({ id: '1', profit: 2, position: 'BTN', wentToShowdown: false })
      .getHeroResult('SavedHero');
    authValue = {
      authStatus: 'authenticated',
      isAuthenticated: true,
      openLogin: vi.fn()
    };
    getOperatorArchivePreference.mockReturnValue('accepted');
    resolveOperatorArchiveConsent.mockResolvedValue(consent);
    loadCloudLibraryIndex.mockResolvedValue({
      library: { id: 'library-1', name: '我的牌谱' },
      sessions: [{
        id: 'session-1',
        handCount: 1,
        summary: { stakes: [{ label: 'NL100', count: 1 }], gameTypes: [] }
      }]
    });
    loadPersonalAnalysisCache.mockResolvedValue({
      results: [cachedResult],
      cachedSessionIds: ['session-1'],
      cachedSourceHandCount: 1,
      cachedResultCount: 1
    });

    await renderWorkspace();
    await settle();
    const analyzeButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent.includes('分析所选牌谱'));
    await act(async () => {
      analyzeButton.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(loadPersonalAnalysisCache).toHaveBeenCalledWith(expect.objectContaining({
      subjectId: 'user-1',
      libraryId: 'library-1',
      consentToken: consent.consentToken
    }));
    expect(loadCloudLibraryHands).not.toHaveBeenCalled();
    expect(loadCloudLibrarySessionHands).not.toHaveBeenCalled();
    expect(archiveImportedHands).not.toHaveBeenCalled();
    expect(container.textContent).toContain('已直接使用缓存生成报告');
    expect(container.textContent).toContain('1 手牌分析结果');
  });

  it('immediately refreshes the cached report when a covered filter changes', async () => {
    const consent = {
      subjectId: 'user-1',
      consentToken: '00000000-0000-4000-8000-000000000001',
      acceptedAt: '2026-08-19T00:00:00.000Z'
    };
    authValue = {
      authStatus: 'authenticated',
      isAuthenticated: true,
      openLogin: vi.fn()
    };
    getOperatorArchivePreference.mockReturnValue('accepted');
    resolveOperatorArchiveConsent.mockResolvedValue(consent);
    loadCloudLibraryIndex.mockResolvedValue({
      library: { id: 'library-1', name: '我的牌谱' },
      sessions: [{
        id: 'session-1',
        handCount: 2,
        summary: {
          stakes: [{ label: 'NL100', count: 1 }, { label: 'NL200', count: 1 }],
          gameTypes: []
        }
      }]
    });
    loadPersonalAnalysisCache.mockResolvedValue({
      results: [
        cloudHand({ id: '1', profit: 2, position: 'BTN', wentToShowdown: false, stakes: 'NL100' }).getHeroResult('SavedHero'),
        cloudHand({ id: '2', profit: -1, position: 'BB', wentToShowdown: false, stakes: 'NL200' }).getHeroResult('SavedHero')
      ],
      cachedSessionIds: ['session-1'],
      cachedSourceHandCount: 2,
      cachedResultCount: 2
    });

    await renderWorkspace();
    await settle();
    const analyzeButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent.includes('分析所选牌谱'));
    await act(async () => {
      analyzeButton.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain('2 手牌分析结果');

    const nl200Button = [...container.querySelectorAll('button')]
      .find((button) => button.textContent.includes('NL200'));
    await act(async () => nl200Button.click());

    expect(container.textContent).toContain('当前结果1/ 2 手牌');
    expect(container.textContent).toContain('1 手牌分析结果');
    expect(container.textContent).toContain('已使用本机缓存即时筛选出 1 手牌');
    expect(loadCloudLibraryHands).not.toHaveBeenCalled();
    expect(loadCloudLibrarySessionHands).not.toHaveBeenCalled();
  });
});
