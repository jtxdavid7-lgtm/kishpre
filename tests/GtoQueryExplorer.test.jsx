// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { GtoQueryExplorer } from '../src/components/GtoQueryExplorer.jsx';
import { getGtoDemoNode } from '../src/data/gtoDemo.js';
import { queryDemoStrategy, summarizeDemoStrategy } from '../src/lib/gtoQueryEngine.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root;
let container;

async function click(element) {
  await act(async () => element.click());
}

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('GTO demo query framework', () => {
  it('keeps combo weighting correct after board-card removal', () => {
    const preflop = getGtoDemoNode('preflop');
    const flop = getGtoDemoNode('flop');
    expect(preflop.matrix.reduce((sum, hand) => sum + hand.combinations, 0)).toBe(1326);
    expect(flop.matrix.reduce((sum, hand) => sum + hand.combinations, 0)).toBe(1176);

    const summary = summarizeDemoStrategy(flop);
    expect(Object.values(summary).reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 10);
  });

  it('returns unavailable instead of inventing a strategy for an uncovered board', () => {
    const result = queryDemoStrategy({ street: 'flop', board: ['As', '7d', '2c'] });
    expect(result.available).toBe(false);
    expect(result.reason).toContain('仅覆盖');
  });

  it('walks through streets and exposes the fixed demo-board boundary', async () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(<GtoQueryExplorer />));

    expect(container.textContent).toContain('DEMO · 非求解结果');
    expect(container.textContent).toContain('起手牌矩阵');

    const flopTab = [...container.querySelectorAll('[role="tab"]')].find((button) => button.textContent.startsWith('翻牌'));
    await click(flopTab);
    expect(container.textContent).toContain('A♥ 7♦ 2♣');

    const firstBoardCard = container.querySelector('[aria-label="选择第 1 张公共牌"]');
    await click(firstBoardCard);
    const aceOfSpades = container.querySelector('[aria-label="黑桃A"]');
    await click(aceOfSpades);

    expect(container.textContent).toContain('当前节点未覆盖');
    expect(container.textContent).toContain('不会为缺失节点推测或生成频率');
  });

  it('separates solution selection from action-tree navigation', async () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(<GtoQueryExplorer />));

    const solutionButton = [...container.querySelectorAll('button')].find((button) => button.textContent.includes('更换方案'));
    await click(solutionButton);

    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(container.textContent).toContain('解决方案库');
    expect(container.textContent).toContain('等待授权数据');

    await click(container.querySelector('.gto-solution-row.active'));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain('翻前');
  });
});
