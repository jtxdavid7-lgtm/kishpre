const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const SUITS = ['s', 'h', 'd', 'c'];
const FULL_DECK = RANKS.flatMap((rank) => SUITS.map((suit) => `${rank}${suit}`));
const RANK_VALUE = Object.freeze({ 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, T: 10, J: 11, Q: 12, K: 13, A: 14 });
const SUIT_VALUE = Object.freeze({ s: 0, h: 1, d: 2, c: 3 });
const EPSILON = 1e-7;
const EXACT_COMBINATION_LIMIT = 50_000;
const DEFAULT_MONTE_CARLO_ITERATIONS = 50_000;

function combinationCount(total, choose) {
  if (choose < 0 || choose > total) return 0;
  const normalized = Math.min(choose, total - choose);
  let result = 1;
  for (let index = 1; index <= normalized; index += 1) {
    result = (result * (total - normalized + index)) / index;
  }
  return Math.round(result);
}

function seedFromText(value) {
  let hash = 2166136261;
  for (const character of String(value ?? '')) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function distinctCards(cards) {
  const normalized = cards.filter((card) => FULL_DECK.includes(card));
  return normalized.length === cards.length && new Set(normalized).size === normalized.length;
}

function straightHighFromMask(mask) {
  if ((mask & (1 << 14)) !== 0) mask |= (1 << 1);
  for (let high = 14; high >= 5; high -= 1) {
    const needed = 0b11111 << (high - 4);
    if ((mask & needed) === needed) return high;
  }
  return 0;
}

function encodeScore(category, values = []) {
  let score = category;
  for (let index = 0; index < 5; index += 1) score = score * 15 + (values[index] ?? 0);
  return score;
}

function holdemScore(cards) {
  const rankCounts = new Uint8Array(15);
  const suitRanks = [[], [], [], []];
  let rankMask = 0;
  for (const card of cards) {
    const rank = RANK_VALUE[card[0]];
    const suit = SUIT_VALUE[card[1]];
    rankCounts[rank] += 1;
    suitRanks[suit].push(rank);
    rankMask |= (1 << rank);
  }

  for (const ranks of suitRanks) {
    if (ranks.length < 5) continue;
    let suitedMask = 0;
    for (const rank of ranks) suitedMask |= (1 << rank);
    const straightFlush = straightHighFromMask(suitedMask);
    if (straightFlush) return encodeScore(8, [straightFlush]);
  }

  const groups = [];
  for (let rank = 14; rank >= 2; rank -= 1) {
    if (rankCounts[rank]) groups.push({ rank, count: rankCounts[rank] });
  }
  const quads = groups.find((group) => group.count === 4);
  if (quads) {
    const kicker = groups.find((group) => group.rank !== quads.rank)?.rank ?? 0;
    return encodeScore(7, [quads.rank, kicker]);
  }

  const trips = groups.filter((group) => group.count >= 3);
  const pairs = groups.filter((group) => group.count >= 2);
  if (trips.length && pairs.some((group) => group.rank !== trips[0].rank)) {
    const pair = pairs.find((group) => group.rank !== trips[0].rank);
    return encodeScore(6, [trips[0].rank, pair.rank]);
  }

  const flushRanks = suitRanks
    .filter((ranks) => ranks.length >= 5)
    .map((ranks) => ranks.sort((left, right) => right - left).slice(0, 5))
    .sort((left, right) => {
      for (let index = 0; index < 5; index += 1) {
        if (left[index] !== right[index]) return right[index] - left[index];
      }
      return 0;
    })[0];
  if (flushRanks) return encodeScore(5, flushRanks);

  const straight = straightHighFromMask(rankMask);
  if (straight) return encodeScore(4, [straight]);
  if (trips.length) {
    const kickers = groups.filter((group) => group.rank !== trips[0].rank).slice(0, 2).map((group) => group.rank);
    return encodeScore(3, [trips[0].rank, ...kickers]);
  }
  if (pairs.length >= 2) {
    const kicker = groups.find((group) => group.rank !== pairs[0].rank && group.rank !== pairs[1].rank)?.rank ?? 0;
    return encodeScore(2, [pairs[0].rank, pairs[1].rank, kicker]);
  }
  if (pairs.length === 1) {
    const kickers = groups.filter((group) => group.rank !== pairs[0].rank).slice(0, 3).map((group) => group.rank);
    return encodeScore(1, [pairs[0].rank, ...kickers]);
  }
  return encodeScore(0, groups.slice(0, 5).map((group) => group.rank));
}

export function holdemWinnerIndexes(holeCardSets, board) {
  const scores = holeCardSets.map((cards) => holdemScore([...cards, ...board]));
  const winningScore = Math.max(...scores);
  return scores.flatMap((score, index) => score === winningScore ? [index] : []);
}

function heroShareOnBoard(players, hero, board) {
  const winnerIndexes = holdemWinnerIndexes(players.map((player) => player.cards), board);
  const heroIndex = players.findIndex((player) => player.name === hero);
  if (heroIndex < 0 || !winnerIndexes.includes(heroIndex)) return 0;
  return 1 / winnerIndexes.length;
}

function forEachCombination(values, choose, callback, start = 0, selected = []) {
  if (selected.length === choose) {
    callback(selected);
    return;
  }
  const remaining = choose - selected.length;
  for (let index = start; index <= values.length - remaining; index += 1) {
    selected.push(values[index]);
    forEachCombination(values, choose, callback, index + 1, selected);
    selected.pop();
  }
}

function calculateEquity({ players, hero, board, seed, monteCarloIterations }) {
  const knownCards = [...board, ...players.flatMap((player) => player.cards)];
  if (!distinctCards(knownCards)) return null;
  const deck = FULL_DECK.filter((card) => !knownCards.includes(card));
  const cardsNeeded = 5 - board.length;
  if (cardsNeeded < 0 || cardsNeeded > deck.length) return null;
  if (cardsNeeded === 0) {
    return { equity: heroShareOnBoard(players, hero, board), method: 'exact', samples: 1 };
  }

  const combinations = combinationCount(deck.length, cardsNeeded);
  let equityTotal = 0;
  if (combinations <= EXACT_COMBINATION_LIMIT) {
    forEachCombination(deck, cardsNeeded, (drawn) => {
      equityTotal += heroShareOnBoard(players, hero, [...board, ...drawn]);
    });
    return { equity: equityTotal / combinations, method: 'exact', samples: combinations };
  }

  const iterations = Math.max(1, Math.floor(monteCarloIterations));
  const random = mulberry32(seedFromText(seed));
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const shuffled = deck.slice();
    for (let drawIndex = 0; drawIndex < cardsNeeded; drawIndex += 1) {
      const swapIndex = drawIndex + Math.floor(random() * (shuffled.length - drawIndex));
      [shuffled[drawIndex], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[drawIndex]];
    }
    equityTotal += heroShareOnBoard(players, hero, [...board, ...shuffled.slice(0, cardsNeeded)]);
  }
  return { equity: equityTotal / iterations, method: 'estimated', samples: iterations };
}

function parseRunoutBoards(raw) {
  const namedBoards = new Map();
  const lines = String(raw ?? '').split(/\r?\n/);
  for (const line of lines) {
    const match = line.trim().match(/^(?:(FIRST|SECOND|THIRD) )?Board \[([^\]]+)\]/i);
    if (!match) continue;
    const cards = [...match[2].matchAll(/([2-9TJQKA][shdc])/g)].map((entry) => entry[1]);
    if (cards.length === 5 && distinctCards(cards)) namedBoards.set(match[1] ?? 'ONLY', cards);
  }
  return [...namedBoards.values()];
}

function buildPotLayers(contributions, foldedPlayers) {
  const entries = [...contributions.entries()]
    .map(([name, amount]) => [name, Number(amount)])
    .filter(([, amount]) => Number.isFinite(amount) && amount > EPSILON);
  const levels = [...new Set(entries.map(([, amount]) => amount.toFixed(6)))]
    .map(Number)
    .sort((left, right) => left - right);
  const layers = [];
  let previous = 0;

  for (const level of levels) {
    const contributors = entries.filter(([, amount]) => amount + EPSILON >= level).map(([name]) => name);
    const amount = (level - previous) * contributors.length;
    const eligible = contributors.filter((name) => !foldedPlayers.has(name));
    if (amount > EPSILON) layers.push({ level, amount, contributors, eligible });
    previous = level;
  }
  return layers;
}

function firstReachIndex(actions, player, threshold) {
  return actions.findIndex((action) => (
    action.player === player
    && Number(action.contributionAfter) + EPSILON >= threshold
  ));
}

function actualHeroShare(players, hero, finalBoards) {
  if (!finalBoards.length) return null;
  let share = 0;
  for (const board of finalBoards) {
    const knownCards = [...board, ...players.flatMap((player) => player.cards)];
    if (!distinctCards(knownCards)) return null;
    share += heroShareOnBoard(players, hero, board) / finalBoards.length;
  }
  return share;
}

export function calculateAllInEvForHero({
  raw,
  handId,
  hero,
  holeCards,
  actions,
  contributions,
  foldedPlayers,
  monteCarloIterations = DEFAULT_MONTE_CARLO_ITERATIONS
}) {
  const layers = buildPotLayers(contributions, foldedPlayers);
  const relevantLayers = [];

  for (const layer of layers) {
    if (!layer.eligible.includes(hero) || layer.eligible.length < 2) continue;
    const allInCaps = layer.eligible
      .filter((name) => actions.some((action) => action.player === name && action.allIn))
      .map((name) => Number(contributions.get(name)))
      .filter((amount) => Number.isFinite(amount) && amount + EPSILON >= layer.level);
    if (!allInCaps.length) continue;
    relevantLayers.push({ ...layer, lockThreshold: Math.min(...allInCaps) });
  }

  if (!relevantLayers.length) {
    return {
      opportunity: false,
      covered: false,
      adjustment: 0,
      relevantPotCount: 0,
      coveredPotCount: 0,
      method: 'none',
      samples: 0,
      reason: ''
    };
  }

  const finalBoards = parseRunoutBoards(raw);
  const equityCache = new Map();
  let adjustment = 0;
  let coveredPotCount = 0;
  let samples = 0;
  let usedEstimate = false;
  let failureReason = '';

  for (const layer of relevantLayers) {
    const reachIndexes = layer.eligible.map((name) => firstReachIndex(actions, name, layer.lockThreshold));
    if (reachIndexes.some((index) => index < 0)) {
      failureReason = '无法确认所有入池玩家达到全下底池上限的时点';
      break;
    }
    const lockIndex = Math.max(...reachIndexes);
    const lockAction = actions[lockIndex];
    const foldedAfterLock = layer.contributors.some((name) => actions.some((action, index) => (
      index > lockIndex && action.player === name && action.type === 'fold'
    )));
    if (foldedAfterLock) {
      failureReason = '全下底池锁定后仍有相关玩家弃牌';
      break;
    }

    const players = layer.eligible.map((name) => ({ name, cards: holeCards.get(name) ?? [] }));
    if (players.some((player) => player.cards.length !== 2)) {
      failureReason = '全下底池存在未公开底牌';
      break;
    }
    const board = Array.isArray(lockAction?.board) ? lockAction.board : [];
    if (![0, 3, 4, 5].includes(board.length)) {
      failureReason = '无法确认全下时的公共牌';
      break;
    }

    const cacheKey = JSON.stringify({
      board,
      players: players.map((player) => [player.name, ...player.cards])
    });
    let equity = equityCache.get(cacheKey);
    if (!equity) {
      equity = calculateEquity({
        players,
        hero,
        board,
        seed: `${handId}:${cacheKey}`,
        monteCarloIterations
      });
      if (equity) equityCache.set(cacheKey, equity);
    }
    if (!equity) {
      failureReason = '全下牌面或底牌存在冲突';
      break;
    }

    const actualBoards = finalBoards.length ? finalBoards : (board.length === 5 ? [board] : []);
    const actualShare = actualHeroShare(players, hero, actualBoards);
    if (actualShare === null) {
      failureReason = '无法还原全下底池的实际摊牌结果';
      break;
    }

    adjustment += layer.amount * (equity.equity - actualShare);
    coveredPotCount += 1;
    samples += equity.samples;
    if (equity.method === 'estimated') usedEstimate = true;
  }

  const covered = coveredPotCount === relevantLayers.length;
  return {
    opportunity: true,
    covered,
    adjustment: covered ? adjustment : 0,
    relevantPotCount: relevantLayers.length,
    coveredPotCount: covered ? coveredPotCount : 0,
    method: covered ? (usedEstimate ? 'estimated' : 'exact') : 'unsupported',
    samples: covered ? samples : 0,
    reason: covered ? '' : failureReason || '无法可靠计算这手牌的 All-in EV'
  };
}

export const ALL_IN_EV_MONTE_CARLO_ITERATIONS = DEFAULT_MONTE_CARLO_ITERATIONS;
