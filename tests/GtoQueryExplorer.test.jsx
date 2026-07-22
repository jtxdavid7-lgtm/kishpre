// @vitest-environment happy-dom

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GtoQueryExplorer } from '../src/components/GtoQueryExplorer.jsx';
import {
  findActionTransition,
  findSeatDecisionNode,
  getGtoDecisionTrail,
  loadGtoPreflopIndex,
  loadGtoPreflopNode,
  resetGtoDataCacheForTests,
  summarizeStrategy
} from '../src/lib/gtoQueryEngine.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root;
let container;
let originalFetch;

async function localDataFetch(input) {
  const url = new URL(String(input), 'http://127.0.0.1');
  const filePath = path.join(process.cwd(), 'public', ...url.pathname.split('/').filter(Boolean));
  try {
    const body = await fs.readFile(filePath);
    return new Response(body, { status: 200 });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

async function click(element) {
  await act(async () => element.click());
}

async function waitForText(text) {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (container.textContent.includes(text)) return;
    await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
  }
  throw new Error(`页面未出现文本：${text}`);
}

async function renderExplorer() {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<GtoQueryExplorer />));
  await waitForText('EP 的可选行动');
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(localDataFetch);
  resetGtoDataCacheForTests();
});

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  container?.remove();
  root = null;
  container = null;
  globalThis.fetch = originalFetch;
  resetGtoDataCacheForTests();
});

describe('GTO complete preflop explorer', () => {
  it('loads all 2,588 formal preflop nodes and decodes frequency plus EV', async () => {
    const index = await loadGtoPreflopIndex();
    expect(index.nodes).toHaveLength(2588);
    expect(index.chunks).toHaveLength(21);

    const rootNode = await loadGtoPreflopNode(index, index.rootId);
    expect(rootNode.matrix).toHaveLength(169);
    const aceKing = rootNode.matrix.find((hand) => hand.label === 'AKs');
    expect(aceKing.actions['Raise 2.5 bb']).toBeCloseTo(1, 5);
    expect(aceKing.totalEv).toBeCloseTo(1.407, 3);
    expect(aceKing.actionEvs.Fold).toBeCloseTo(0, 5);
  });

  it('keeps decoded node summaries normalized', async () => {
    const index = await loadGtoPreflopIndex();
    const sampleIds = [0, 25, 127, 128, 900, 2587];
    for (const nodeId of sampleIds) {
      const node = await loadGtoPreflopNode(index, nodeId);
      const summary = summarizeStrategy(node);
      expect(node.actions.reduce((sum, action) => sum + summary[action], 0)).toBeCloseTo(1, 3);
    }
  });

  it('jumps directly to BTN and automatically fills prior unopened seats as folds', async () => {
    const index = await loadGtoPreflopIndex();
    const btnNodeId = findSeatDecisionNode(index, index.rootId, 0);
    const trail = getGtoDecisionTrail(index, btnNodeId);
    expect(trail.map((entry) => [index.positions[entry.node.actor], entry.selectedAction])).toEqual([
      ['EP', 'Fold'],
      ['MP', 'Fold'],
      ['CO', 'Fold'],
      ['BTN', null]
    ]);

    await renderExplorer();
    const btnCard = [...container.querySelectorAll('.gto-tree-node--seat')].find((card) => card.querySelector('strong')?.textContent === 'BTN');
    await click(btnCard.querySelector('.gto-seat-selector'));
    await waitForText('BTN 的可选行动');
    expect(container.querySelector('.gto-action-history').textContent).toContain('EP · 弃牌');
    expect(container.querySelector('.gto-action-history').textContent).toContain('CO · 弃牌');
  });

  it('makes the full seat card a clickable decision target without covering action buttons', async () => {
    await renderExplorer();
    const mpCard = [...container.querySelectorAll('.gto-tree-node--seat')].find((card) => card.querySelector('strong')?.textContent === 'MP');
    const seatTarget = mpCard.querySelector('.gto-seat-selector');
    expect(seatTarget.getAttribute('aria-label')).toBe('查看 MP 的决策节点');
    expect(seatTarget.childElementCount).toBe(0);

    await click(seatTarget);
    await waitForText('MP 的可选行动');
    const mpAction = mpCard.querySelector('.gto-tree-actions button');
    expect(mpAction).not.toBeNull();
  });

  it('opens 3-bet branches and always provides a visible back path', async () => {
    await renderExplorer();
    const epOpen = [...container.querySelectorAll('.gto-tree-actions button')].find((button) => button.textContent === '开池 2.5bb');
    await click(epOpen);
    await waitForText('MP 的可选行动');

    const mpThreeBet = [...container.querySelectorAll('.gto-tree-node--seat.hero .gto-tree-actions button')].find((button) => button.textContent === '加注 8bb');
    await click(mpThreeBet);
    await waitForText('CO 的可选行动');
    expect(container.textContent).not.toContain('未导出');

    const back = [...container.querySelectorAll('.gto-tree-toolbar button')].find((button) => button.textContent.includes('返回一步'));
    expect(back.disabled).toBe(false);
    await click(back);
    await waitForText('MP 的可选行动');
  });

  it('shows the selected hand strategy frequency, total EV and every action EV', async () => {
    const index = await loadGtoPreflopIndex();
    const epOpen = findActionTransition(index, index.rootId, 'Raise 2.5 bb');
    expect(epOpen.nextId).not.toBeNull();

    await renderExplorer();
    const aceKing = container.querySelector('[aria-label^="AKs，"]');
    await click(aceKing);
    expect(container.textContent).toContain('策略总 EV');
    expect(container.textContent).toContain('EV 1.407bb');
    expect(container.textContent).toContain('2,588 个翻前节点');
    expect(container.textContent).not.toContain('演示数据');
  });
});
