// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PoolLeakExplorer } from '../src/components/PoolLeakExplorer.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const reliableRow = {
  b: 'ALL', l: 'FINE', p: 'SRP', s: 'flop', r: 'OD', a: 'PFA_BET',
  c: 'B', h: 'F:XB', z: '04_33pot_32_36', zl: '32–36%（约 33%）',
  n: 1000, f: .5, ca: .45, ra: .05, d: .5, m: .75, g: -.25,
  lo: .47, hi: .53, avg: .333, min: .32, max: .36,
  pot: 5, risk: 1.67, call: 1.67
};

const boardRow = {
  ...reliableRow,
  b: '01_A_HIGH_PAIRED',
  z: 'fb_02_exact33',
  zl: '约33%（|B/P−1/3|≤1%）'
};

const sparseBoardRow = {
  ...boardRow,
  z: 'fb_05_100_150',
  zl: '100–150%',
  n: 100,
  f: .52,
  ca: .43,
  d: .48,
  g: -.27,
  lo: .38,
  hi: .58,
  avg: 1.25,
  min: 1,
  max: 1.5,
  risk: 6.25,
  call: 6.25
};

let root = null;
let container = null;

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.restoreAllMocks();
});

describe('PoolLeakExplorer', () => {
  it('loads board rows only after a board is selected and warns about sparse nodes', async () => {
    const manifest = {
      summary: { handsAnalyzed: 39488382, headsUpPressureResponses: 20128857 },
      boardClasses: [{ key: '01_A_HIGH_PAIRED', label: 'A高配对面', observed: true }],
      files: {
        explorer: { path: 'explorer.json' },
        flopBoards: { path: 'flop-boards.json' }
      }
    };
    const fetchMock = vi.fn(async (url) => ({
      ok: true,
      json: async () => {
        if (String(url).endsWith('manifest.json')) return manifest;
        if (String(url).endsWith('flop-boards.json')) {
          return { boardClasses: manifest.boardClasses, rows: [boardRow, sparseBoardRow] };
        }
        return { rows: [reliableRow] };
      }
    }));
    vi.stubGlobal('fetch', fetchMock);

    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(<PoolLeakExplorer />));
    await settle();

    expect(container.textContent).toContain('真实玩家池漏洞查询器');
    expect(container.textContent).toContain('置信度');
    expect(container.textContent).not.toContain('数据口径与完整性');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('flop-boards'))).toBe(false);

    const selects = [...container.querySelectorAll('select')];
    const boardSelect = selects.find((select) => select.closest('label')?.textContent.includes('牌面（仅 Flop c-bet）'));
    const streetSelect = selects.find((select) => select.closest('label')?.textContent.startsWith('街道'));
    const familySelect = selects.find((select) => select.closest('label')?.textContent.startsWith('当前面对'));
    const roleSelect = selects.find((select) => select.closest('label')?.textContent.startsWith('响应角色'));

    await act(async () => {
      boardSelect.value = '01_A_HIGH_PAIRED';
      boardSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();

    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('flop-boards.json'))).toBe(true);
    expect(streetSelect.disabled).toBe(true);
    expect(familySelect.disabled).toBe(true);
    expect(roleSelect.querySelector('option[value="IA"]').disabled).toBe(true);
    expect(container.textContent).toContain('A高配对面');
    expect(container.textContent).toContain('另有 1 个节点低于当前 500 样本门槛，已隐藏');
  });
});
