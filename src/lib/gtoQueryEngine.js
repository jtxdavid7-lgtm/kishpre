import { GTO_DEMO_ACTIONS, GTO_DEMO_CONFIG, getGtoDemoNode } from '../data/gtoDemo.js';

export function boardsMatch(expected = [], actual = []) {
  return expected.length === actual.length && expected.every((card, index) => card === actual[index]);
}

export function queryDemoStrategy({ street, board = [] }) {
  const node = getGtoDemoNode(street);
  const requiredBoard = node.board;
  const available = boardsMatch(requiredBoard, board.slice(0, requiredBoard.length));

  return {
    available,
    node,
    config: GTO_DEMO_CONFIG,
    actions: node.actions.map((key) => GTO_DEMO_ACTIONS[key]),
    reason: available ? '' : `演示数据仅覆盖 ${formatBoard(requiredBoard)} 这一固定牌面。`
  };
}

export function summarizeDemoStrategy(node) {
  const weighted = {};
  let combinations = 0;
  node.matrix.forEach((hand) => {
    combinations += hand.combinations;
    Object.entries(hand.actions).forEach(([action, frequency]) => {
      weighted[action] = (weighted[action] ?? 0) + frequency * hand.combinations;
    });
  });
  return Object.fromEntries(Object.entries(weighted).map(([action, value]) => [action, value / combinations]));
}

export function formatBoard(cards = []) {
  if (!cards.length) return '翻前';
  const suits = { s: '♠', h: '♥', d: '♦', c: '♣' };
  return cards.map((card) => `${card[0]}${suits[card[1]] ?? ''}`).join(' ');
}

export function strategyGradient(actions = {}) {
  const segments = [];
  let offset = 0;
  Object.entries(actions).forEach(([key, frequency]) => {
    if (frequency <= 0) return;
    const end = offset + frequency * 100;
    const color = GTO_DEMO_ACTIONS[key]?.color ?? '#334155';
    segments.push(`${color} ${offset}%`, `${color} ${end}%`);
    offset = end;
  });
  return `linear-gradient(90deg, ${segments.join(', ')})`;
}

