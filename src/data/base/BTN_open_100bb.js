export const BTN_open_100bb = {
  key: 'BTN_open_100bb',
  meta: {
    game: 'GG Zoom 6-max',
    stack: '100bb',
    position: 'BTN',
    actionTree: 'Open Raise',
    rake: '5%',
    solver: 'Simple GTO',
    date: '2026-04-04'
  },
  matrix: {
    AA: { action: 'raise', freq: 1.0, ev: 2.40 },
    KK: { action: 'raise', freq: 1.0, ev: 2.32 },
    QQ: { action: 'raise', freq: 1.0, ev: 2.18 },
    AKs: { action: 'raise', freq: 0.98 },
    A5s: { action: 'mix', freq: 0.55 },
    KJs: { action: 'mix', freq: 0.72 },
    Q9s: { action: 'mix', freq: 0.35 },
    J8s: { action: 'mix', freq: 0.22 },
    T7s: { action: 'mix', freq: 0.15 },
    AJo: { action: 'raise', freq: 0.78 },
    KQo: { action: 'mix', freq: 0.42 },
    T8o: { action: 'fold', freq: 0.0 }
  }
};
