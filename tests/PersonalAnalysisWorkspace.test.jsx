// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PersonalAnalysisWorkspace } from '../src/components/PersonalAnalysisWorkspace.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let authValue;
const loadCloudLibraryIndex = vi.fn();
const loadCloudLibraryHands = vi.fn();
const acceptOperatorArchivePreference = vi.fn();
const archiveImportedHands = vi.fn();
const disableOperatorArchivePreference = vi.fn();
const getOperatorArchivePreference = vi.fn();
const resolveOperatorArchiveConsent = vi.fn();

vi.mock('../src/auth/AuthProvider.jsx', () => ({
  useAuth: () => authValue
}));

vi.mock('../src/lib/cloudLibrary.js', () => ({
  loadCloudLibraryIndex: (...args) => loadCloudLibraryIndex(...args),
  loadCloudLibraryHands: (...args) => loadCloudLibraryHands(...args)
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

beforeEach(() => {
  authValue = {
    authStatus: 'guest',
    isAuthenticated: false,
    openLogin: vi.fn()
  };
  getOperatorArchivePreference.mockReturnValue(null);
  resolveOperatorArchiveConsent.mockResolvedValue(null);
  loadCloudLibraryIndex.mockResolvedValue({ library: null, sessions: [] });
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
});
