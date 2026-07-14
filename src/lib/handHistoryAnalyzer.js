const MONEY_RE = /\$(-?[\d,]+(?:\.\d+)?)/;
const HAND_SPLIT_RE = /(?=Poker Hand #)/g;
const FLOP_RE = /^\*\*\* (?:FIRST |SECOND )?FLOP \*\*\*/;
const TURN_RE = /^\*\*\* (?:FIRST |SECOND )?TURN \*\*\*/;
const RIVER_RE = /^\*\*\* (?:FIRST |SECOND )?RIVER \*\*\*/;
const POSTFLOP_STREETS = ['flop', 'turn', 'river'];
const CARD_RE = /([2-9TJQKA][shdc])/g;
const RANK_VALUE = Object.freeze({ 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, T: 10, J: 11, Q: 12, K: 13, A: 14 });
const RANK_LABEL = Object.freeze({ 14: 'A', 13: 'K', 12: 'Q', 11: 'J', 10: 'T', 9: '9', 8: '8', 7: '7', 6: '6', 5: '5', 4: '4', 3: '3', 2: '2' });

export const POSITIONS = ['BTN', 'SB', 'BB', 'UTG', 'HJ', 'CO', 'MP', 'EP'];

export function splitHandHistories(text) {
  return text
    .replace(/\r\n/g, '\n')
    .split(HAND_SPLIT_RE)
    .map((hand) => hand.trim())
    .filter((hand) => hand.startsWith('Poker Hand #'));
}

function money(line) {
  const match = line.match(MONEY_RE);
  return match ? parseMoney(match[1]) : 0;
}

function parseMoney(value) {
  return Number(String(value).replaceAll(',', ''));
}

function parseCards(value = '') {
  return [...String(value).matchAll(CARD_RE)].map((match) => match[1]);
}

function straightHigh(values) {
  const unique = [...new Set(values)].sort((a, b) => b - a);
  if (unique.includes(14)) unique.push(1);
  for (let index = 0; index <= unique.length - 5; index += 1) {
    if (unique[index] - unique[index + 4] === 4) return unique[index];
  }
  return 0;
}

export function evaluateHandValue(cards = []) {
  const parsed = cards
    .map((card) => ({ rank: RANK_VALUE[card?.[0]], suit: card?.[1] }))
    .filter((card) => card.rank && card.suit);
  if (!parsed.length) return '—';

  const rankCounts = new Map();
  const suitCards = new Map();
  for (const card of parsed) {
    rankCounts.set(card.rank, (rankCounts.get(card.rank) ?? 0) + 1);
    const suited = suitCards.get(card.suit) ?? [];
    suited.push(card.rank);
    suitCards.set(card.suit, suited);
  }
  const groups = [...rankCounts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const flushRanks = [...suitCards.values()].find((ranks) => ranks.length >= 5);
  const straightFlush = flushRanks ? straightHigh(flushRanks) : 0;
  const straight = straightHigh(parsed.map((card) => card.rank));
  const quads = groups.find(([, count]) => count === 4)?.[0];
  const trips = groups.filter(([, count]) => count >= 3).map(([rank]) => rank);
  const pairs = groups.filter(([, count]) => count >= 2).map(([rank]) => rank);

  if (straightFlush) return `同花顺 ${RANK_LABEL[straightFlush]}高`;
  if (quads) return `四条 ${RANK_LABEL[quads]}`;
  if (trips.length && pairs.some((rank) => rank !== trips[0])) return `葫芦 ${RANK_LABEL[trips[0]]}满`;
  if (flushRanks) return `同花 ${RANK_LABEL[Math.max(...flushRanks)]}高`;
  if (straight) return `顺子 ${RANK_LABEL[straight]}高`;
  if (trips.length) return `三条 ${RANK_LABEL[trips[0]]}`;
  if (pairs.length >= 2) return `两对 ${RANK_LABEL[pairs[0]]}${RANK_LABEL[pairs[1]]}`;
  if (pairs.length === 1) return `一对 ${RANK_LABEL[pairs[0]]}`;
  return `高牌 ${RANK_LABEL[Math.max(...parsed.map((card) => card.rank))]}`;
}

function playerFromAction(line) {
  const idx = line.indexOf(': ');
  return idx > 0 ? line.slice(0, idx) : null;
}

function actionType(line) {
  if (line.includes(': folds')) return 'fold';
  if (line.includes(': checks')) return 'check';
  if (line.includes(' calls ')) return 'call';
  if (line.includes(' bets ')) return 'bet';
  if (line.includes(' raises ')) return 'raise';
  return null;
}

function isAggressiveAction(action) {
  return action?.type === 'bet' || action?.type === 'raise';
}

function actionAmount(line, committed) {
  if (line.includes(' raises ')) {
    const toMatch = line.match(/\bto \$(-?[\d,]+(?:\.\d+)?)/);
    if (toMatch) {
      const target = parseMoney(toMatch[1]);
      return Math.max(0, target - committed);
    }
  }
  return money(line);
}

function lastRaiser(lines) {
  let raiser = null;
  for (const line of lines) {
    if (FLOP_RE.test(line)) break;
    if (line.includes(' raises ')) raiser = playerFromAction(line);
  }
  return raiser;
}

function postflopOrder(seats, buttonSeat, activePlayers) {
  const seatNums = [...seats.keys()].sort((a, b) => a - b);
  if (!seatNums.length || !buttonSeat) return activePlayers;
  const buttonIndex = seatNums.indexOf(buttonSeat);
  const orderedSeats = buttonIndex >= 0
    ? [...seatNums.slice(buttonIndex + 1), ...seatNums.slice(0, buttonIndex + 1)]
    : seatNums;
  const active = new Set(activePlayers);
  return orderedSeats.map((seat) => seats.get(seat)).filter((name) => active.has(name));
}

function positionMap(seats, buttonSeat) {
  const seatNums = [...seats.keys()].sort((a, b) => a - b);
  if (!seatNums.length || !buttonSeat) return new Map();
  const btnIndex = seatNums.indexOf(buttonSeat);
  const ordered = btnIndex >= 0
    ? [...seatNums.slice(btnIndex), ...seatNums.slice(0, btnIndex)]
    : seatNums;
  const labels = ordered.length === 2
    ? ['BTN', 'BB']
    : ordered.length === 3
      ? ['BTN', 'SB', 'BB']
      : ordered.length === 4
        ? ['BTN', 'SB', 'BB', 'CO']
        : ordered.length === 5
          ? ['BTN', 'SB', 'BB', 'UTG', 'CO']
          : ['BTN', 'SB', 'BB', 'UTG', 'HJ', 'CO', 'MP', 'EP'];
  return new Map(ordered.map((seat, index) => [seat, labels[index] ?? `S${index + 1}`]));
}

function inferPreflopStats(lines, hero, heroPosition = '') {
  let heroVoluntary = false;
  let heroRaise = false;
  let heroThreeBet = false;
  let heroThreeBetOpportunity = false;
  let heroSqueeze = false;
  let heroSqueezeOpportunity = false;
  let heroFourBet = false;
  let heroFourBetOpportunity = false;
  let heroFoldToThreeBet = false;
  let heroFoldToThreeBetOpportunity = false;
  let heroFoldToFourBet = false;
  let heroFoldToFourBetOpportunity = false;
  let heroSteal = false;
  let heroStealOpportunity = false;
  let heroStealBtn = false;
  let heroStealBtnOpportunity = false;
  let heroStealSb = false;
  let heroStealSbOpportunity = false;
  let heroActed = false;
  let heroOpened = false;
  let heroMadeThreeBet = false;
  let raiseCount = 0;
  let callersAfterOpen = 0;
  let voluntaryBeforeHero = false;
  const isStealPosition = ['CO', 'BTN', 'SB'].includes(heroPosition);

  for (const line of lines) {
    if (FLOP_RE.test(line)) break;
    if (!line.includes(': ')) continue;
    const player = playerFromAction(line);
    if (!player) continue;
    const isVoluntary = line.includes(' calls ') || line.includes(' raises ') || line.includes(' bets ');
    const isRaise = line.includes(' raises ');
    const isCall = line.includes(' calls ');
    const isFold = line.includes(': folds');
    const isCheck = line.includes(': checks');
    const isHeroAction = player === hero && (isVoluntary || isFold || isCheck);
    const isFirstHeroAction = isHeroAction && !heroActed;

    if (isFirstHeroAction) {
      heroThreeBetOpportunity = raiseCount === 1;
      heroSqueezeOpportunity = raiseCount === 1 && callersAfterOpen > 0;
      heroStealOpportunity = isStealPosition && raiseCount === 0 && !voluntaryBeforeHero;
      heroStealBtnOpportunity = heroStealOpportunity && heroPosition === 'BTN';
      heroStealSbOpportunity = heroStealOpportunity && heroPosition === 'SB';
      heroFourBetOpportunity = raiseCount === 2;
      heroActed = true;
    }
    if (isHeroAction && raiseCount === 2) {
      if (heroOpened) {
        heroFoldToThreeBetOpportunity = true;
        if (isFold) heroFoldToThreeBet = true;
      }
    }
    if (isHeroAction && raiseCount === 3 && heroMadeThreeBet) {
      heroFoldToFourBetOpportunity = true;
      if (isFold) heroFoldToFourBet = true;
    }
    if (player === hero && isVoluntary) heroVoluntary = true;
    if (player === hero && isRaise) {
      heroRaise = true;
      if (raiseCount === 0) {
        heroOpened = true;
        if (heroStealOpportunity) {
          heroSteal = true;
          heroStealBtn = heroPosition === 'BTN';
          heroStealSb = heroPosition === 'SB';
        }
      }
      if (raiseCount === 1) {
        heroThreeBet = true;
        heroMadeThreeBet = true;
        if (callersAfterOpen > 0) heroSqueeze = true;
      }
      if (raiseCount === 2 && isFirstHeroAction) heroFourBet = true;
    }
    if (player !== hero && isCall && raiseCount === 0) voluntaryBeforeHero = true;
    if (isRaise) {
      raiseCount += 1;
    } else if (isCall && raiseCount === 1 && player !== hero) {
      callersAfterOpen += 1;
    }
  }

  return {
    heroFacingRaise: heroThreeBetOpportunity,
    heroThreeBetOpportunity,
    heroVoluntary,
    heroRaise,
    heroThreeBet,
    heroSqueezeOpportunity,
    heroSqueeze,
    heroFourBetOpportunity,
    heroFourBet,
    heroFoldToThreeBetOpportunity,
    heroFoldToThreeBet,
    heroFoldToFourBetOpportunity,
    heroFoldToFourBet,
    heroStealOpportunity,
    heroSteal,
    heroStealBtnOpportunity,
    heroStealBtn,
    heroStealSbOpportunity,
    heroStealSb
  };
}

function emptyStreetStats() {
  return {
    cbetOpportunity: false,
    cbet: false,
    cbetIpOpportunity: false,
    cbetIp: false,
    cbetOopOpportunity: false,
    cbetOop: false,
    foldToCbetOpportunity: false,
    foldToCbet: false,
    foldToCbetIpOpportunity: false,
    foldToCbetIp: false,
    foldToCbetOopOpportunity: false,
    foldToCbetOop: false,
    donkOpportunity: false,
    donk: false,
    checkResponseOpportunity: false,
    checkCall: false,
    checkRaise: false
  };
}

function inferPostflopStats(lines, seats, buttonSeat, hero, preflopAggressor) {
  const streetActions = {
    flop: [],
    turn: [],
    river: []
  };
  const activeAtStart = {
    flop: [],
    turn: [],
    river: []
  };
  const folded = new Set();
  let currentStreet = 'preflop';

  for (const line of lines) {
    if (FLOP_RE.test(line)) {
      currentStreet = 'flop';
      activeAtStart.flop = [...seats.values()].filter((name) => !folded.has(name));
      continue;
    }
    if (TURN_RE.test(line)) {
      currentStreet = 'turn';
      activeAtStart.turn = [...seats.values()].filter((name) => !folded.has(name));
      continue;
    }
    if (RIVER_RE.test(line)) {
      currentStreet = 'river';
      activeAtStart.river = [...seats.values()].filter((name) => !folded.has(name));
      continue;
    }

    const player = playerFromAction(line);
    const type = actionType(line);
    if (!player || !type) continue;
    if (POSTFLOP_STREETS.includes(currentStreet)) {
      streetActions[currentStreet].push({ player, type });
    }
    if (type === 'fold') folded.add(player);
  }

  const result = {
    flop: emptyStreetStats(),
    turn: emptyStreetStats(),
    river: emptyStreetStats()
  };
  let previousAggressor = preflopAggressor;

  for (const street of POSTFLOP_STREETS) {
    const activePlayers = activeAtStart[street];
    const actions = streetActions[street];
    const stats = result[street];
    const heroReachedStreet = activePlayers.includes(hero);
    const ordered = postflopOrder(seats, buttonSeat, activePlayers);
    const heroIsIp = ordered.length > 1 && ordered[ordered.length - 1] === hero;
    const firstAggressiveIndex = actions.findIndex(isAggressiveAction);
    const firstAggressive = firstAggressiveIndex >= 0 ? actions[firstAggressiveIndex] : null;
    const heroFirstActionIndex = actions.findIndex((action) => action.player === hero);
    const heroCbetIsIp = heroFirstActionIndex > 0;

    if (heroReachedStreet && preflopAggressor === hero && heroFirstActionIndex >= 0) {
      const gotDonkedInto = firstAggressive && firstAggressive.player !== hero && firstAggressiveIndex < heroFirstActionIndex;
      stats.cbetOpportunity = true;
      stats.cbetIpOpportunity = heroCbetIsIp;
      stats.cbetOopOpportunity = !heroCbetIsIp;
      const heroFirstAction = actions[heroFirstActionIndex];
      if (!gotDonkedInto && heroFirstAction.type === 'bet') {
        stats.cbet = true;
        stats.cbetIp = heroCbetIsIp;
        stats.cbetOop = !heroCbetIsIp;
      }
    }

    if (heroReachedStreet && preflopAggressor && preflopAggressor !== hero && firstAggressive?.player === preflopAggressor) {
      const heroResponse = actions.slice(firstAggressiveIndex + 1).find((action) => action.player === hero);
      if (heroResponse) {
        stats.foldToCbetOpportunity = true;
        stats.foldToCbetIpOpportunity = heroIsIp;
        stats.foldToCbetOopOpportunity = !heroIsIp;
        if (heroResponse.type === 'fold') {
          stats.foldToCbet = true;
          stats.foldToCbetIp = heroIsIp;
          stats.foldToCbetOop = !heroIsIp;
        }
      }
    }

    if (heroReachedStreet && previousAggressor && previousAggressor !== hero && heroFirstActionIndex >= 0) {
      const previousAggressorActionIndex = actions.findIndex((action) => action.player === previousAggressor);
      const heroActsBeforeAggressor = activePlayers.includes(previousAggressor)
        && previousAggressorActionIndex >= 0
        && heroFirstActionIndex < previousAggressorActionIndex;
      const noBetBeforeHero = firstAggressiveIndex < 0 || heroFirstActionIndex <= firstAggressiveIndex;
      if (heroActsBeforeAggressor && noBetBeforeHero) {
        stats.donkOpportunity = true;
        if (actions[heroFirstActionIndex].type === 'bet') stats.donk = true;
      }
    }

    const heroCheckIndex = actions.findIndex((action) => action.player === hero && action.type === 'check');
    if (heroCheckIndex >= 0) {
      const opponentBetIndex = actions.findIndex((action, index) => (
        index > heroCheckIndex && action.player !== hero && isAggressiveAction(action)
      ));
      if (opponentBetIndex >= 0) {
        const heroResponse = actions.slice(opponentBetIndex + 1).find((action) => action.player === hero);
        if (heroResponse) {
          stats.checkResponseOpportunity = true;
          stats.checkCall = heroResponse.type === 'call';
          stats.checkRaise = heroResponse.type === 'raise';
        }
      }
    }

    const lastAggressive = actions.filter(isAggressiveAction).at(-1);
    if (lastAggressive) previousAggressor = lastAggressive.player;
  }

  return result;
}

export function parseGgHand(raw) {
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  const header = lines[0] ?? '';
  const id = header.match(/Poker Hand #([^:]+):/)?.[1] ?? header.slice(0, 48);
  const stakes = header.match(/\((\$[\d.]+\/\$[\d.]+)\)/)?.[1] ?? 'Unknown';
  const bb = Number((stakes.split('/')[1] ?? '').replace('$', '')) || 1;
  const date = header.match(/ - ([\d/]+ [\d:]+)/)?.[1] ?? '';
  const buttonSeat = Number(lines.find((line) => line.includes('Seat #') && line.includes('button'))?.match(/Seat #(\d+)/)?.[1] ?? 0);
  const seats = new Map();
  const players = new Map();
  const invested = new Map();
  const won = new Map();
  const summary = new Map();
  const holeCards = new Map();
  const winners = new Map();
  const actions = [];
  const heroCandidates = [];
  const preflopLines = [];
  let currentStreet = 'preflop';
  let streetCommit = new Map();
  let runningPot = 0;
  let board = [];
  let totalPot = 0;
  let rake = 0;
  let jackpot = 0;

  for (const line of lines) {
    const seatMatch = line.match(/^Seat (\d+): (.+?) \(\$[-\d,.]+ in chips\)/);
    if (seatMatch) {
      const seat = Number(seatMatch[1]);
      const name = seatMatch[2];
      const stack = parseMoney(line.match(/\(\$([-\d,.]+) in chips\)/)?.[1] ?? 0);
      seats.set(seat, name);
      players.set(name, { seat, stack });
      continue;
    }
    const dealtMatch = line.match(/^Dealt to (.+?)(?: \[([^\]]+)\])?$/);
    if (dealtMatch) {
      if (dealtMatch[2]) {
        heroCandidates.push(dealtMatch[1]);
        holeCards.set(dealtMatch[1], parseCards(dealtMatch[2]));
      }
    }
    const potMatch = line.match(/^Total pot \$([\d,.]+).* Rake \$([\d,.]+).* Jackpot \$([\d,.]+)/);
    if (potMatch) {
      totalPot = parseMoney(potMatch[1]);
      rake = parseMoney(potMatch[2]);
      jackpot = parseMoney(potMatch[3]);
    }
    const boardMatch = line.match(/^Board \[([^\]]+)\]/);
    if (boardMatch) board = parseCards(boardMatch[1]);
    if (FLOP_RE.test(line)) {
      currentStreet = 'flop';
      streetCommit = new Map();
      if (!board.length) board = parseCards(line);
    } else if (TURN_RE.test(line)) {
      currentStreet = 'turn';
      streetCommit = new Map();
      const cards = parseCards(line);
      if (cards.length > board.length) board = cards;
    } else if (RIVER_RE.test(line)) {
      currentStreet = 'river';
      streetCommit = new Map();
      const cards = parseCards(line);
      if (cards.length > board.length) board = cards;
    }

    if (currentStreet === 'preflop') preflopLines.push(line);

    const actor = playerFromAction(line);
    if (actor && (line.includes(' posts ') || line.includes(' calls ') || line.includes(' bets ') || line.includes(' raises '))) {
      const already = streetCommit.get(actor) ?? 0;
      const amount = line.includes(' posts ') ? money(line) : actionAmount(line, already);
      if (amount > 0) {
        invested.set(actor, (invested.get(actor) ?? 0) + amount);
        streetCommit.set(actor, already + amount);
        runningPot += amount;
        actions.push({
          street: currentStreet,
          player: actor,
          type: line.includes(' posts ') ? 'post' : actionType(line),
          amount,
          potAfter: runningPot,
          text: line.slice(line.indexOf(': ') + 2)
        });
      }
    } else if (actor && actionType(line)) {
      actions.push({
        street: currentStreet,
        player: actor,
        type: actionType(line),
        amount: 0,
        potAfter: runningPot,
        text: line.slice(line.indexOf(': ') + 2)
      });
    }

    const returned = line.match(/^Uncalled bet \(\$([\d,.]+)\) returned to (.+)$/);
    if (returned) {
      const amount = parseMoney(returned[1]);
      const player = returned[2];
      invested.set(player, (invested.get(player) ?? 0) - amount);
      runningPot = Math.max(0, runningPot - amount);
      actions.push({ street: currentStreet, player, type: 'return', amount, potAfter: runningPot, text: `收回未跟注下注 $${amount}` });
    }

    const collected = line.match(/^(.+?) collected \$([\d,.]+) from (?:the )?(?:main |side )?pot$/);
    if (collected) {
      const amount = parseMoney(collected[2]);
      won.set(collected[1], (won.get(collected[1]) ?? 0) + amount);
      winners.set(collected[1], (winners.get(collected[1]) ?? 0) + amount);
      actions.push({ street: 'showdown', player: collected[1], type: 'collect', amount, potAfter: totalPot || runningPot, text: `赢得底池 $${amount}` });
    }

    const summaryMatch = line.match(/^Seat \d+: (.+?)(?: \((?:button|small blind|big blind)\))? (.+)$/);
    if (summaryMatch) {
      const [, name, detail] = summaryMatch;
      const shown = detail.match(/(?:showed|mucked) \[([^\]]+)\]/)?.[1];
      if (shown) holeCards.set(name, parseCards(shown));
      const prev = summary.get(name) ?? {};
      summary.set(name, {
        ...prev,
        detail,
        folded: detail.includes('folded'),
        showed: detail.includes('showed '),
        won: detail.includes(' won ') || detail.startsWith('won '),
        lost: detail.includes(' lost ') || detail.startsWith('lost ')
      });
    }
  }

  const posBySeat = positionMap(seats, buttonSeat);
  for (const [seat, name] of seats.entries()) {
    const prev = players.get(name) ?? { seat };
    players.set(name, { ...prev, position: posBySeat.get(seat) ?? '' });
  }

  return {
    id,
    date,
    stakes,
    bb,
    players,
    holeCards,
    board,
    totalPot,
    winners: [...winners.entries()].map(([name, amount]) => ({ name, amount })),
    actions,
    heroCandidates,
    rake,
    jackpot,
    raw,
    getHeroResult(hero) {
      const player = players.get(hero);
      if (!player) return null;
      const heroWon = won.get(hero) ?? 0;
      const totalWon = [...won.values()].reduce((sum, amount) => sum + amount, 0);
      const winnerShare = totalWon ? heroWon / totalWon : 0;
      const rakeShare = rake * winnerShare;
      const jackpotShare = jackpot * winnerShare;
      const profit = (won.get(hero) ?? 0) - (invested.get(hero) ?? 0);
      const heroSummary = summary.get(hero) ?? {};
      const sawFlop = lines.some((line) => FLOP_RE.test(line)) && !heroSummary.detail?.includes('folded before Flop');
      const wentToShowdown = Boolean(heroSummary.showed);
      const wonAtShowdown = Boolean(heroSummary.showed && heroSummary.won);
      const wonWhenSawFlop = Boolean(sawFlop && heroSummary.won);
      return {
        id,
        date,
        stakes,
        bb,
        position: player.position,
        cards: holeCards.get(hero) ?? [],
        board,
        handValue: evaluateHandValue([...(holeCards.get(hero) ?? []), ...board]),
        winners: [...winners.entries()].map(([name, amount]) => ({ name, amount })),
        totalPot,
        profit,
        profitBB: profit / bb,
        rake: rakeShare,
        jackpot: jackpotShare,
        sawFlop,
        wentToShowdown,
        wonAtShowdown,
        wonWhenSawFlop,
        ...inferPreflopStats(preflopLines, hero, player.position),
        postflop: inferPostflopStats(lines, seats, buttonSeat, hero, lastRaiser(preflopLines))
      };
    }
  };
}

export function parseGgHands(text) {
  return splitHandHistories(text).map(parseGgHand);
}

function percentage(count, opportunity) {
  return opportunity ? (count / opportunity) * 100 : null;
}

function summarizePostflopStats(results) {
  const summary = {};
  for (const street of POSTFLOP_STREETS) {
    const streetHands = results.map((hand) => hand.postflop?.[street]).filter(Boolean);
    const cbetOpportunity = streetHands.filter((stats) => stats.cbetOpportunity).length;
    const cbet = streetHands.filter((stats) => stats.cbet).length;
    const cbetIpOpportunity = streetHands.filter((stats) => stats.cbetIpOpportunity).length;
    const cbetIp = streetHands.filter((stats) => stats.cbetIp).length;
    const cbetOopOpportunity = streetHands.filter((stats) => stats.cbetOopOpportunity).length;
    const cbetOop = streetHands.filter((stats) => stats.cbetOop).length;
    const foldToCbetOpportunity = streetHands.filter((stats) => stats.foldToCbetOpportunity).length;
    const foldToCbet = streetHands.filter((stats) => stats.foldToCbet).length;
    const foldToCbetIpOpportunity = streetHands.filter((stats) => stats.foldToCbetIpOpportunity).length;
    const foldToCbetIp = streetHands.filter((stats) => stats.foldToCbetIp).length;
    const foldToCbetOopOpportunity = streetHands.filter((stats) => stats.foldToCbetOopOpportunity).length;
    const foldToCbetOop = streetHands.filter((stats) => stats.foldToCbetOop).length;
    const donkOpportunity = streetHands.filter((stats) => stats.donkOpportunity).length;
    const donk = streetHands.filter((stats) => stats.donk).length;
    const checkResponseOpportunity = streetHands.filter((stats) => stats.checkResponseOpportunity).length;
    const checkCall = streetHands.filter((stats) => stats.checkCall).length;
    const checkRaise = streetHands.filter((stats) => stats.checkRaise).length;

    summary[street] = {
      cbet: percentage(cbet, cbetOpportunity),
      cbetOpportunity,
      cbetIp: percentage(cbetIp, cbetIpOpportunity),
      cbetIpOpportunity,
      cbetOop: percentage(cbetOop, cbetOopOpportunity),
      cbetOopOpportunity,
      foldToCbet: percentage(foldToCbet, foldToCbetOpportunity),
      foldToCbetOpportunity,
      foldToCbetIp: percentage(foldToCbetIp, foldToCbetIpOpportunity),
      foldToCbetIpOpportunity,
      foldToCbetOop: percentage(foldToCbetOop, foldToCbetOopOpportunity),
      foldToCbetOopOpportunity,
      donk: percentage(donk, donkOpportunity),
      donkOpportunity,
      checkCall: percentage(checkCall, checkResponseOpportunity),
      checkRaise: percentage(checkRaise, checkResponseOpportunity),
      checkResponseOpportunity
    };
  }
  return summary;
}

export function summarizeHeroResults(results) {
  const totalHands = results.length;
  const rawProfit = results.reduce((sum, hand) => sum + hand.profit, 0);
  const gameRake = results.reduce((sum, hand) => sum + hand.rake, 0);
  const totalJackpot = results.reduce((sum, hand) => sum + hand.jackpot, 0);
  const totalRake = gameRake + totalJackpot;
  const totalRakeBB = results.reduce((sum, hand) => sum + (hand.rake + hand.jackpot) / hand.bb, 0);
  const gameRakeBB = results.reduce((sum, hand) => sum + hand.rake / hand.bb, 0);
  const jackpotRakeBB = results.reduce((sum, hand) => sum + hand.jackpot / hand.bb, 0);
  const totalProfit = rawProfit;
  const totalProfitBB = results.reduce((sum, hand) => sum + hand.profit / hand.bb, 0);
  const vpipCount = results.filter((hand) => hand.heroVoluntary).length;
  const pfrCount = results.filter((hand) => hand.heroRaise).length;
  const facingThreeBet = results.filter((hand) => hand.heroThreeBetOpportunity || hand.heroFacingRaise).length;
  const threeBetCount = results.filter((hand) => hand.heroThreeBet).length;
  const squeezeOpportunityCount = results.filter((hand) => hand.heroSqueezeOpportunity).length;
  const squeezeCount = results.filter((hand) => hand.heroSqueeze).length;
  const fourBetOpportunityCount = results.filter((hand) => hand.heroFourBetOpportunity).length;
  const fourBetCount = results.filter((hand) => hand.heroFourBet).length;
  const foldToThreeBetOpportunityCount = results.filter((hand) => hand.heroFoldToThreeBetOpportunity).length;
  const foldToThreeBetCount = results.filter((hand) => hand.heroFoldToThreeBet).length;
  const foldToFourBetOpportunityCount = results.filter((hand) => hand.heroFoldToFourBetOpportunity).length;
  const foldToFourBetCount = results.filter((hand) => hand.heroFoldToFourBet).length;
  const stealOpportunityCount = results.filter((hand) => hand.heroStealOpportunity).length;
  const stealCount = results.filter((hand) => hand.heroSteal).length;
  const stealBtnOpportunityCount = results.filter((hand) => hand.heroStealBtnOpportunity).length;
  const stealBtnCount = results.filter((hand) => hand.heroStealBtn).length;
  const stealSbOpportunityCount = results.filter((hand) => hand.heroStealSbOpportunity).length;
  const stealSbCount = results.filter((hand) => hand.heroStealSb).length;
  const sawFlopCount = results.filter((hand) => hand.sawFlop).length;
  const showdownCount = results.filter((hand) => hand.sawFlop && hand.wentToShowdown).length;
  const wonAtShowdownCount = results.filter((hand) => hand.sawFlop && hand.wentToShowdown && hand.wonAtShowdown).length;
  const wonWhenSawFlopCount = results.filter((hand) => hand.wonWhenSawFlop).length;
  const byPosition = new Map();
  const byStakes = new Map();
  const postflop = summarizePostflopStats(results);
  let running = 0;
  let runningBeforeRake = 0;
  let runningEv = 0;
  let runningNonShowdown = 0;
  let runningShowdown = 0;
  const curve = results.map((hand, index) => {
    const displayProfitBB = hand.profit / hand.bb;
    running += displayProfitBB;
    const rakeBB = (hand.rake + hand.jackpot) / hand.bb;
    runningBeforeRake += displayProfitBB + rakeBB;
    runningEv += displayProfitBB + rakeBB * 0.36;
    if (hand.wentToShowdown) {
      runningShowdown += hand.profitBB;
    } else {
      runningNonShowdown += hand.profitBB;
    }
    return {
      hand: index + 1,
      profitBB: running,
      beforeRakeBB: runningBeforeRake,
      evBB: runningEv,
      nonShowdownBB: runningNonShowdown,
      showdownBB: runningShowdown
    };
  });

  for (const hand of results) {
    const pos = hand.position || 'Unknown';
    const stake = hand.stakes || 'Unknown';
    byPosition.set(pos, (byPosition.get(pos) ?? 0) + 1);
    byStakes.set(stake, (byStakes.get(stake) ?? 0) + 1);
  }

  return {
    totalHands,
    totalProfit,
    totalProfitBB,
    beforeRakeProfit: totalProfit + totalRake,
    beforeRakeProfitBB: totalProfitBB + totalRakeBB,
    totalRake,
    totalJackpot,
    gameRake,
    bbPer100: totalHands ? (totalProfitBB / totalHands) * 100 : 0,
    beforeRakeBBPer100: totalHands ? ((totalProfitBB + totalRakeBB) / totalHands) * 100 : 0,
    rakeBBPer100: totalHands ? (totalRakeBB / totalHands) * 100 : 0,
    gameRakeBBPer100: totalHands ? (gameRakeBB / totalHands) * 100 : 0,
    jackpotRakeBBPer100: totalHands ? (jackpotRakeBB / totalHands) * 100 : 0,
    vpip: totalHands ? (vpipCount / totalHands) * 100 : 0,
    pfr: totalHands ? (pfrCount / totalHands) * 100 : 0,
    threeBet: facingThreeBet ? (threeBetCount / facingThreeBet) * 100 : 0,
    facingThreeBet,
    squeeze: squeezeOpportunityCount ? (squeezeCount / squeezeOpportunityCount) * 100 : null,
    squeezeOpportunityCount,
    fourBet: fourBetOpportunityCount ? (fourBetCount / fourBetOpportunityCount) * 100 : null,
    fourBetOpportunityCount,
    foldToThreeBet: foldToThreeBetOpportunityCount ? (foldToThreeBetCount / foldToThreeBetOpportunityCount) * 100 : null,
    foldToThreeBetOpportunityCount,
    foldToFourBet: foldToFourBetOpportunityCount ? (foldToFourBetCount / foldToFourBetOpportunityCount) * 100 : null,
    foldToFourBetOpportunityCount,
    stealTotal: stealOpportunityCount ? (stealCount / stealOpportunityCount) * 100 : null,
    stealOpportunityCount,
    stealBtn: stealBtnOpportunityCount ? (stealBtnCount / stealBtnOpportunityCount) * 100 : null,
    stealBtnOpportunityCount,
    stealSb: stealSbOpportunityCount ? (stealSbCount / stealSbOpportunityCount) * 100 : null,
    stealSbOpportunityCount,
    wtsd: sawFlopCount ? (showdownCount / sawFlopCount) * 100 : 0,
    wwsf: sawFlopCount ? (wonWhenSawFlopCount / sawFlopCount) * 100 : 0,
    wsd: showdownCount ? (wonAtShowdownCount / showdownCount) * 100 : 0,
    sawFlopCount,
    showdownCount,
    postflop,
    curve,
    positions: [...byPosition.entries()].map(([label, count]) => ({ label, count })),
    stakes: [...byStakes.entries()].map(([label, count]) => ({ label, count }))
  };
}

export function exportSummaryCsv(results) {
  const header = ['hand', 'date', 'stakes', 'position', 'profit', 'profitBB', 'vpip', 'pfr', 'threeBet'];
  const rows = results.map((hand, index) => [
    index + 1,
    hand.date,
    hand.stakes,
    hand.position,
    hand.profit.toFixed(2),
    hand.profitBB.toFixed(2),
    hand.heroVoluntary ? 1 : 0,
    hand.heroRaise ? 1 : 0,
    hand.heroThreeBet ? 1 : 0
  ]);
  return [header, ...rows]
    .map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(','))
    .join('\n');
}
