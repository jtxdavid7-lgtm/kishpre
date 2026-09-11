import { describe, expect, it } from 'vitest';

import { childNodesForAction, sameHistory } from '../src/lib/solverNavigation.js';

describe('solver human action navigation', () => {
  const check = { id: 'Check', actor: 'OOP', street: 'flop' };
  const root = { actor: 'OOP', street: 'flop', history: [], currentBoardText: ['As', 'Kh', '9c'] };
  const nodes = [
    root,
    {
      id: 1,
      history: [check],
      currentBoardText: ['As', 'Kh', '9c'],
      actor: 'IP',
      street: 'flop'
    },
    {
      id: 2,
      history: [check],
      currentBoardText: ['As', 'Kh', '9c', '7d'],
      actor: 'OOP',
      street: 'turn'
    }
  ];

  it('matches a visible action to its following strategy nodes', () => {
    expect(sameHistory([check], [{ ...check }])).toBe(true);
    expect(childNodesForAction(nodes, root, { id: 'Check' }).map((node) => node.id))
      .toEqual([1, 2]);
    expect(childNodesForAction(nodes, root, { id: 'Bet 4.37' })).toEqual([]);
  });
});
