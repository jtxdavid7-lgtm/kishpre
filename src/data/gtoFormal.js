export const GTO_FORMAL_CONFIG = Object.freeze({
  id: 'gg-rnc-6max-100bb-drop-1p5bb-v1',
  version: '2026.07-v3',
  source: 'KishPoker 自有 RocketSolver 求解快照',
  sourceType: 'locally-solved-static-snapshot',
  solved: true,
  game: 'GG Rush & Cash（Zoom）NLH 现金桌',
  tableSize: '6-max',
  stack: '100bb',
  blinds: '0.5bb / 1bb',
  rake: '5% · cap 3bb · 翻前不抽水',
  flatDrop: '底池达到 30bb 时先扣除 1.5bb',
  ruleBasis: 'Flat Drop 由用户依据当前 GG 客户端规则确认（2026-07-22）',
  openingSize: '2.5bb',
  abstraction: 'Flop 1000 · Turn 200 · River 200',
  solver: 'RocketSolver',
  solverFile: 'gg-rnc-6max-100bb-drop-1p5bb-formal-v1.rsl',
  iterations: 2835332758,
  entropy: 2.8,
  solveTime: '18 分 53 秒',
  treeNodes: 2356695,
  preflopDecisionNodes: 2588,
  coverage: '完整导出 2,588 个翻前决策节点，覆盖首次开池、跟注、3-bet、4-bet+ 与全下分支；每个节点包含 169 类起手牌的频率、总 EV 与各行动 EV。',
  licensing: '完整求解文件仅保存在本机；站点只使用经审核的静态数值快照。'
});

export const GTO_POSITION_ORDER = Object.freeze(['EP', 'MP', 'CO', 'BTN', 'SB', 'BB']);
export const GTO_POSITION_CODE = Object.freeze({ EP: 3, MP: 2, CO: 1, BTN: 0, SB: 9, BB: 8 });

const RANKS = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];

export function buildPreflopHandLabels() {
  return RANKS.flatMap((rowRank, rowIndex) => RANKS.map((columnRank, columnIndex) => {
    if (rowIndex === columnIndex) return `${rowRank}${columnRank}`;
    if (rowIndex < columnIndex) return `${rowRank}${columnRank}s`;
    return `${columnRank}${rowRank}o`;
  }));
}

export function preflopCombinationCount(label) {
  if (label[0] === label[1]) return 6;
  return label.endsWith('s') ? 4 : 12;
}

export function describeGtoAction(label, node = null) {
  if (label === 'Fold') return { key: label, label: '弃牌', shortLabel: '弃牌', color: '#3c7f96' };
  if (label === 'Call') return { key: label, label: '跟注', shortLabel: '跟注', color: '#56b96b' };
  if (label === 'Check') return { key: label, label: '过牌', shortLabel: '过牌', color: '#60a5fa' };
  if (label === 'All-in') return { key: label, label: '全下', shortLabel: '全下', color: '#a77bd8' };
  if (label.startsWith('Bet ')) {
    const size = label.slice(4).replace(' bb', 'bb');
    return { key: label, label: `下注 ${size}`, shortLabel: `下注 ${size}`, color: '#ef5b5b' };
  }
  if (label.startsWith('Raise ')) {
    const size = label.slice(6).replace(' bb', 'bb');
    const isOpeningRaise = node?.pot === 1.5 && label === 'Raise 2.5 bb';
    return {
      key: label,
      label: size.endsWith('%') ? `加注 ${size}` : `加注至 ${size}`,
      shortLabel: isOpeningRaise ? `开池 ${size}` : `加注 ${size}`,
      color: isOpeningRaise ? '#ef5b5b' : '#e5bd4f'
    };
  }
  return { key: label, label, shortLabel: label, color: '#64748b' };
}
