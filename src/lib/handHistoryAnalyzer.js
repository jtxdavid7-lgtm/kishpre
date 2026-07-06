const MONEY_RE = /\$(-?[\d,]+(?:\.\d+)?)/;
const HAND_SPLIT_RE = /(?=Poker Hand #)/g;
const FLOP_RE = /^\*\*\* (?:FIRST |SECOND )?FLOP \*\*\*/;
const TURN_RE = /^\*\*\* (?:FIRST |SECOND )?TURN \*\*\*/;
const RIVER_RE = /^\*\*\* (?:FIRST |SECOND )?RIVER \*\*\*/;

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

function playerFromAction(line) {
  const idx = line.indexOf(': ');
  return idx > 0 ? line.slice(0, idx) : null;
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

    if (isHeroAction && !heroActed) {
      heroThreeBetOpportunity = raiseCount === 1;
      heroSqueezeOpportunity = raiseCount === 1 && callersAfterOpen > 0;
      heroStealOpportunity = isStealPosition && raiseCount === 0 && !voluntaryBeforeHero;
      heroStealBtnOpportunity = heroStealOpportunity && heroPosition === 'BTN';
      heroStealSbOpportunity = heroStealOpportunity && heroPosition === 'SB';
      heroActed = true;
    }
    if (isHeroAction && raiseCount === 2) {
      heroFourBetOpportunity = true;
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
      if (raiseCount === 2) heroFourBet = true;
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
  const heroCandidates = [];
  const preflopLines = [];
  let currentStreet = 'preflop';
  let streetCommit = new Map();
  let rake = 0;
  let jackpot = 0;

  for (const line of lines) {
    const seatMatch = line.match(/^Seat (\d+): (.+?) \(\$[-\d,.]+ in chips\)/);
    if (seatMatch) {
      const seat = Number(seatMatch[1]);
      const name = seatMatch[2];
      seats.set(seat, name);
      players.set(name, { seat });
      continue;
    }
    const dealtMatch = line.match(/^Dealt to (.+?) \[/);
    if (dealtMatch) heroCandidates.push(dealtMatch[1]);
    const potMatch = line.match(/^Total pot \$([\d,.]+).* Rake \$([\d,.]+).* Jackpot \$([\d,.]+)/);
    if (potMatch) {
      rake = parseMoney(potMatch[2]);
      jackpot = parseMoney(potMatch[3]);
    }
    if (FLOP_RE.test(line)) {
      currentStreet = 'flop';
      streetCommit = new Map();
    } else if (TURN_RE.test(line)) {
      currentStreet = 'turn';
      streetCommit = new Map();
    } else if (RIVER_RE.test(line)) {
      currentStreet = 'river';
      streetCommit = new Map();
    }

    if (currentStreet === 'preflop') preflopLines.push(line);

    const actor = playerFromAction(line);
    if (actor && (line.includes(' posts ') || line.includes(' calls ') || line.includes(' bets ') || line.includes(' raises '))) {
      const already = streetCommit.get(actor) ?? 0;
      const amount = line.includes(' posts ') ? money(line) : actionAmount(line, already);
      if (amount > 0) {
        invested.set(actor, (invested.get(actor) ?? 0) + amount);
        streetCommit.set(actor, already + amount);
      }
    }

    const returned = line.match(/^Uncalled bet \(\$([\d,.]+)\) returned to (.+)$/);
    if (returned) {
      const amount = parseMoney(returned[1]);
      const player = returned[2];
      invested.set(player, (invested.get(player) ?? 0) - amount);
    }

    const collected = line.match(/^(.+?) collected \$([\d,.]+) from (?:the )?(?:main |side )?pot$/);
    if (collected) won.set(collected[1], (won.get(collected[1]) ?? 0) + parseMoney(collected[2]));

    const summaryMatch = line.match(/^Seat \d+: (.+?)(?: \((?:button|small blind|big blind)\))? (.+)$/);
    if (summaryMatch) {
      const [, name, detail] = summaryMatch;
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
        profit,
        profitBB: profit / bb,
        rake: rakeShare,
        jackpot: jackpotShare,
        sawFlop,
        wentToShowdown,
        wonAtShowdown,
        wonWhenSawFlop,
        ...inferPreflopStats(preflopLines, hero, player.position)
      };
    }
  };
}

export function parseGgHands(text) {
  return splitHandHistories(text).map(parseGgHand);
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
