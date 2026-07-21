const RANKS = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];

export const GTO_DEMO_ACTIONS = Object.freeze({
  raise: { key: 'raise', label: '加注至 2.5bb', shortLabel: '加注', color: '#ef5b5b' },
  fold: { key: 'fold', label: '弃牌', shortLabel: '弃牌', color: '#334155' },
  bet33: { key: 'bet33', label: '下注 33% 底池', shortLabel: '下注 33%', color: '#f59e0b' },
  bet75: { key: 'bet75', label: '下注 75% 底池', shortLabel: '下注 75%', color: '#ef4444' },
  allin: { key: 'allin', label: '全下', shortLabel: '全下', color: '#be123c' },
  check: { key: 'check', label: '过牌', shortLabel: '过牌', color: '#2563eb' }
});

export const GTO_DEMO_CONFIG = Object.freeze({
  id: 'kishpoker-demo-v1',
  version: 'demo-2026.07',
  source: 'KishPoker 产品交互演示数据',
  sourceType: 'manually-authored-demo',
  solved: false,
  game: 'NLH 现金桌',
  tableSize: '6-max',
  stack: '100bb',
  rake: '未建模',
  heroPosition: 'BTN',
  villainPosition: 'BB',
  preflopLine: '弃牌到 BTN · BTN 加注 2.5bb · BB 跟注',
  coverage: '仅覆盖 BTN 对 BB 的一条演示行动树与一个固定公共牌面',
  demoBoard: ['Ah', '7d', '2c', 'Ks', '2s']
});

function entry(actions, note) {
  return { actions, note };
}

const PREMIUM = new Set(['AA', 'KK', 'QQ', 'JJ', 'TT', 'AKs', 'AKo', 'AQs']);
const STRONG = new Set(['99', '88', 'AJs', 'ATs', 'KQs', 'KJs', 'AQo', 'AJo', 'KQo']);
const OPEN_MIX = new Set([
  '77', '66', '55', '44', '33', '22', 'A9s', 'A8s', 'A7s', 'A6s', 'A5s', 'A4s', 'A3s', 'A2s',
  'KTs', 'K9s', 'QJs', 'QTs', 'Q9s', 'JTs', 'J9s', 'T9s', 'T8s', '98s', '87s', '76s', '65s', '54s',
  'ATo', 'A9o', 'KJo', 'KTo', 'QJo', 'QTo', 'JTo'
]);

const FLOP_VALUE = new Set(['AA', '77', '22', 'AKs', 'AQs', 'AJs', 'ATs', 'AKo', 'AQo', 'AJo']);
const FLOP_MIX = new Set(['KK', 'QQ', 'JJ', 'TT', '99', '88', 'A9s', 'A8s', 'A7s', 'A5s', 'KQs', 'KJs', 'QJs', '76s', '65s', '54s']);
const TURN_VALUE = new Set(['AA', 'KK', '77', '22', 'AKs', 'K7s', 'A7s', 'AKo']);
const TURN_MIX = new Set(['AQs', 'AJs', 'ATs', 'KQs', 'KJs', 'QJs', 'AQo', 'KQo', '76s', '65s']);
const RIVER_VALUE = new Set(['AA', 'KK', '77', '22', 'AKs', 'K7s', 'A7s', 'AKo']);
const RIVER_BLUFF = new Set(['QJs', 'QTs', 'JTs', 'T9s', '65s', '54s']);

function strategyFor(nodeKey, hand) {
  if (nodeKey === 'preflop') {
    if (PREMIUM.has(hand)) return entry({ raise: 1 }, '演示：强价值牌持续加注。');
    if (STRONG.has(hand)) return entry({ raise: 0.86, fold: 0.14 }, '演示：以加注为主的混合策略。');
    if (OPEN_MIX.has(hand)) return entry({ raise: 0.48, fold: 0.52 }, '演示：边缘开池组合采用混合频率。');
    return entry({ fold: 1 }, '演示：当前组合不进入开池范围。');
  }

  if (nodeKey === 'flop') {
    if (FLOP_VALUE.has(hand)) return entry({ bet33: 0.78, check: 0.22 }, '演示：价值与保护驱动的小尺度下注。');
    if (FLOP_MIX.has(hand)) return entry({ bet33: 0.46, check: 0.54 }, '演示：中等牌力与后门组合混合行动。');
    return entry({ bet33: 0.24, check: 0.76 }, '演示：弱组合以过牌为主。');
  }

  if (nodeKey === 'turn') {
    if (TURN_VALUE.has(hand)) return entry({ bet75: 0.82, check: 0.18 }, '演示：强成牌以大尺度继续取值。');
    if (TURN_MIX.has(hand)) return entry({ bet75: 0.38, check: 0.62 }, '演示：部分听牌与中等牌力混合二次开火。');
    return entry({ bet75: 0.12, check: 0.88 }, '演示：多数弱组合选择控池。');
  }

  if (RIVER_VALUE.has(hand)) return entry({ allin: 0.88, check: 0.12 }, '演示：强价值牌高频全下。');
  if (RIVER_BLUFF.has(hand)) return entry({ allin: 0.34, check: 0.66 }, '演示：部分未完成听牌作为混合诈唬。');
  return entry({ allin: 0.04, check: 0.96 }, '演示：摊牌价值或弱牌以过牌为主。');
}

function combinationCount(label, board = []) {
  const suits = ['s', 'h', 'd', 'c'];
  const blocked = new Set(board);
  const rankA = label[0];
  const rankB = label[1];
  if (rankA === rankB) {
    const available = suits.filter((suit) => !blocked.has(`${rankA}${suit}`)).length;
    return available * (available - 1) / 2;
  }
  if (label.endsWith('s')) {
    return suits.filter((suit) => !blocked.has(`${rankA}${suit}`) && !blocked.has(`${rankB}${suit}`)).length;
  }
  return suits.reduce((count, suitA) => count + suits.filter((suitB) => (
    suitA !== suitB
    && !blocked.has(`${rankA}${suitA}`)
    && !blocked.has(`${rankB}${suitB}`)
  )).length, 0);
}

function buildMatrix(nodeKey, board = []) {
  return RANKS.flatMap((rowRank, rowIndex) => RANKS.map((columnRank, columnIndex) => {
    const pair = rowIndex === columnIndex;
    const suited = rowIndex < columnIndex;
    const label = pair ? `${rowRank}${columnRank}` : `${rowRank}${columnRank}${suited ? 's' : 'o'}`;
    return {
      label,
      rowIndex,
      columnIndex,
      combinations: combinationCount(label, board),
      ...strategyFor(nodeKey, label)
    };
  }));
}

export const GTO_DEMO_NODES = Object.freeze([
  {
    key: 'preflop',
    street: 'preflop',
    label: '翻前',
    actor: 'BTN',
    potBb: 1.5,
    board: [],
    path: ['弃牌到 BTN', 'BTN 决策'],
    actions: ['raise', 'fold'],
    matrix: buildMatrix('preflop')
  },
  {
    key: 'flop',
    street: 'flop',
    label: '翻牌',
    actor: 'BTN',
    potBb: 5.5,
    board: GTO_DEMO_CONFIG.demoBoard.slice(0, 3),
    path: ['BTN 加注 2.5bb', 'BB 跟注', 'BB 过牌', 'BTN 决策'],
    actions: ['bet33', 'check'],
    matrix: buildMatrix('flop', GTO_DEMO_CONFIG.demoBoard.slice(0, 3))
  },
  {
    key: 'turn',
    street: 'turn',
    label: '转牌',
    actor: 'BTN',
    potBb: 9.1,
    board: GTO_DEMO_CONFIG.demoBoard.slice(0, 4),
    path: ['Flop：BB 过牌 · BTN 下注 33% · BB 跟注', 'Turn：BB 过牌', 'BTN 决策'],
    actions: ['bet75', 'check'],
    matrix: buildMatrix('turn', GTO_DEMO_CONFIG.demoBoard.slice(0, 4))
  },
  {
    key: 'river',
    street: 'river',
    label: '河牌',
    actor: 'BTN',
    potBb: 22.8,
    board: GTO_DEMO_CONFIG.demoBoard,
    path: ['Flop：下注 33% · 跟注', 'Turn：下注 75% · 跟注', 'River：BB 过牌', 'BTN 决策'],
    actions: ['allin', 'check'],
    matrix: buildMatrix('river', GTO_DEMO_CONFIG.demoBoard)
  }
]);

export function getGtoDemoNode(street) {
  return GTO_DEMO_NODES.find((node) => node.street === street) ?? GTO_DEMO_NODES[0];
}
