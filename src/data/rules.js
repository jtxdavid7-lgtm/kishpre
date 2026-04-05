export const RULES = [
  {
    id: 'whale_calling_station',
    label: 'Whale 对 3bet 不弃',
    appliesTo: ['BTN_open_100bb'],
    trigger: {
      stat: 'foldVsThreeBet',
      op: '<',
      value: 40
    },
    adjustments: [
      { hands: ['AJo', 'KQo', 'KJs'], action: 'raise', delta: 0.15 },
      { hands: ['T8s', '97s', '86s'], action: 'fold', delta: -0.15 }
    ],
    note: '对松跟型保留价值牌，砍掉边缘偷鸡。'
  },
  {
    id: 'nit_folds_too_much',
    label: 'Nit 过度弃牌',
    appliesTo: ['BTN_open_100bb'],
    trigger: {
      stat: 'foldVsThreeBet',
      op: '>',
      value: 65
    },
    adjustments: [
      { hands: ['A5s', 'T8s', '98o'], action: 'raise', delta: 0.20 },
      { hands: ['QQ', 'JJ'], action: 'raise', delta: -0.05 }
    ],
    note: '对弃牌多的对手加大偷盲频率，保留部分强牌 slowplay。'
  }
];
