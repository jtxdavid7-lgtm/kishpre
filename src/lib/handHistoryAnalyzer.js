const MONEY_RE = /\$(-?\d+(?:\.\d+)?)/;
const HAND_SPLIT_RE = /(?=Poker Hand #)/g;

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
  return match ? Number(match[1]) : 0;
}

function playerFromAction(line) {
  const idx = line.indexOf(': ');
  return idx > 0 ? line.slice(0, idx) : null;
}

function actionAmount(line, committed) {
  if (line.includes(' raises ')) {
    const toMatch = line.match(/\bto \$(-?\d+(?:\.\d+)?)/);
    if (toMatch) {
      const target = Number(toMatch[1]);
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

function inferPreflopStats(lines, hero) {
  let heroVoluntary = false;
  let heroRaise = false;
  let heroThreeBet = false;
  let heroThreeBetOpportunity = false;
  let heroActed = false;
  let raiseCount = 0;

  for (const line of lines) {
    if (line.startsWith('*** FLOP ***')) break;
    if (!line.includes(': ')) continue;
    const player = playerFromAction(line);
    if (!player) continue;
    const isVoluntary = line.includes(' calls ') || line.includes(' raises ') || line.includes(' bets ');
    const isRaise = line.includes(' raises ');

    if (player === hero && !heroActed && (isVoluntary || line.includes(': folds') || line.includes(': checks'))) {
      heroThreeBetOpportunity = raiseCount === 1;
      heroActed = true;
    }
    if (player === hero && isVoluntary) heroVoluntary = true;
    if (player === hero && isRaise) {
      heroRaise = true;
      if (raiseCount >= 1) heroThreeBet = true;
    }
    if (isRaise) {
      raiseCount += 1;
    }
  }

  return {
    heroFacingRaise: heroThreeBetOpportunity,
    heroThreeBetOpportunity,
    heroVoluntary,
    heroRaise,
    heroThreeBet
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
  const heroCandidates = [];
  const preflopLines = [];
  let currentStreet = 'preflop';
  let streetCommit = new Map();
  let rake = 0;
  let jackpot = 0;

  for (const line of lines) {
    const seatMatch = line.match(/^Seat (\d+): (.+?) \(\$[-\d.]+ in chips\)/);
    if (seatMatch) {
      const seat = Number(seatMatch[1]);
      const name = seatMatch[2];
      seats.set(seat, name);
      players.set(name, { seat });
      continue;
    }
    const dealtMatch = line.match(/^Dealt to (.+?) \[/);
    if (dealtMatch) heroCandidates.push(dealtMatch[1]);
    const potMatch = line.match(/^Total pot .* Rake \$([\d.]+).* Jackpot \$([\d.]+)/);
    if (potMatch) {
      rake = Number(potMatch[1]);
      jackpot = Number(potMatch[2]);
    }
    if (line.startsWith('*** FLOP ***')) {
      currentStreet = 'flop';
      streetCommit = new Map();
    } else if (line.startsWith('*** TURN ***')) {
      currentStreet = 'turn';
      streetCommit = new Map();
    } else if (line.startsWith('*** RIVER ***')) {
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

    const returned = line.match(/^Uncalled bet \(\$([\d.]+)\) returned to (.+)$/);
    if (returned) {
      const amount = Number(returned[1]);
      const player = returned[2];
      invested.set(player, (invested.get(player) ?? 0) - amount);
    }

    const collected = line.match(/^Seat \d+: (.+?) .*?(?:collected|won) \(\$([\d.]+)\)/);
    if (collected) won.set(collected[1], (won.get(collected[1]) ?? 0) + Number(collected[2]));
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
      const profit = (won.get(hero) ?? 0) - (invested.get(hero) ?? 0);
      return {
        id,
        date,
        stakes,
        bb,
        position: player.position,
        profit,
        profitBB: profit / bb,
        rake,
        jackpot,
        ...inferPreflopStats(preflopLines, hero)
      };
    }
  };
}

export function parseGgHands(text) {
  return splitHandHistories(text).map(parseGgHand);
}

export function summarizeHeroResults(results) {
  const totalHands = results.length;
  const totalProfit = results.reduce((sum, hand) => sum + hand.profit, 0);
  const totalProfitBB = results.reduce((sum, hand) => sum + hand.profitBB, 0);
  const vpipCount = results.filter((hand) => hand.heroVoluntary).length;
  const pfrCount = results.filter((hand) => hand.heroRaise).length;
  const facingThreeBet = results.filter((hand) => hand.heroThreeBetOpportunity || hand.heroFacingRaise).length;
  const threeBetCount = results.filter((hand) => hand.heroThreeBet).length;
  const byPosition = new Map();
  const byStakes = new Map();
  let running = 0;
  const curve = results.map((hand, index) => {
    running += hand.profitBB;
    return { hand: index + 1, profitBB: running };
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
    bbPer100: totalHands ? (totalProfitBB / totalHands) * 100 : 0,
    vpip: totalHands ? (vpipCount / totalHands) * 100 : 0,
    pfr: totalHands ? (pfrCount / totalHands) * 100 : 0,
    threeBet: facingThreeBet ? (threeBetCount / facingThreeBet) * 100 : 0,
    facingThreeBet,
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
