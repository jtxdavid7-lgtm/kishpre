import pkg from 'pokersolver';

const { Hand } = pkg;

const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const SUITS = ['s', 'h', 'd', 'c'];
const FULL_DECK = RANKS.flatMap((rank) => SUITS.map((suit) => `${rank}${suit}`));

function getDeck(excluded) {
  const blocked = new Set(excluded.filter(Boolean));
  return FULL_DECK.filter((card) => !blocked.has(card));
}

function fisherYates(arr) {
  const deck = arr.slice();
  for (let j = deck.length - 1; j > 0; j -= 1) {
    const k = Math.floor(Math.random() * (j + 1));
    [deck[j], deck[k]] = [deck[k], deck[j]];
  }
  return deck;
}

function expandLabel(label = '') {
  if (!label) return [];
  const rankA = label[0];
  const rankB = label[1];
  const suffix = label[2];

  if (!suffix) {
    const combos = [];
    for (let i = 0; i < SUITS.length; i += 1) {
      for (let j = i + 1; j < SUITS.length; j += 1) {
        combos.push([
          `${rankA}${SUITS[i]}`,
          `${rankB}${SUITS[j]}`
        ]);
      }
    }
    return combos;
  }

  if (suffix === 's') {
    return SUITS.map((suit) => ([`${rankA}${suit}`, `${rankB}${suit}`]));
  }

  if (suffix === 'o') {
    const combos = [];
    SUITS.forEach((suitA) => {
      SUITS.forEach((suitB) => {
        if (suitA === suitB) return;
        combos.push([`${rankA}${suitA}`, `${rankB}${suitB}`]);
      });
    });
    return combos;
  }

  return [];
}

function buildRangeCombos(range = {}, blockedSet) {
  const combos = [];
  Object.entries(range).forEach(([label, value]) => {
    const weight = Math.min(Math.max(value?.weight ?? 0, 0), 1);
    if (weight <= 0) return;
    const expanded = expandLabel(label);
    expanded.forEach((cards) => {
      if (cards.some((card) => blockedSet.has(card))) return;
      combos.push({ cards, weight });
    });
  });
  return combos;
}

function pickWeightedCombo(options) {
  if (!options || options.length === 0) return null;
  const total = options.reduce((sum, option) => sum + option.weight, 0);
  if (total <= 0) return null;
  let roll = Math.random() * total;
  for (let idx = 0; idx < options.length; idx += 1) {
    roll -= options[idx].weight;
    if (roll <= 0) {
      return options[idx];
    }
  }
  return options[options.length - 1];
}

export function simulateEquity({
  players,
  boardCards,
  iterations = 5000
}) {
  const board = boardCards.filter(Boolean);
  if (!players || players.length < 2) {
    return { status: 'need-players' };
  }

  const basePlayers = players.map((player) => ({
    id: player.id,
    label: player.label,
    mode: player.mode ?? 'hand',
    cards: player.cards ?? [],
    range: player.range ?? {}
  }));

  const blockedStatic = new Set();
  for (let i = 0; i < board.length; i += 1) {
    const card = board[i];
    if (!card) continue;
    if (blockedStatic.has(card)) {
      return { status: 'invalid' };
    }
    blockedStatic.add(card);
  }

  for (let idx = 0; idx < basePlayers.length; idx += 1) {
    const player = basePlayers[idx];
    if (player.mode !== 'hand') continue;
    const filled = player.cards.filter(Boolean);
    if (filled.length !== 2) {
      return { status: 'need-cards' };
    }
    for (let cIdx = 0; cIdx < filled.length; cIdx += 1) {
      const card = filled[cIdx];
      if (blockedStatic.has(card)) {
        return { status: 'invalid' };
      }
      blockedStatic.add(card);
    }
    player.fixedCards = filled;
  }

  for (let idx = 0; idx < basePlayers.length; idx += 1) {
    const player = basePlayers[idx];
    if (player.mode !== 'range') continue;
    const combos = buildRangeCombos(player.range, blockedStatic);
    if (combos.length === 0) {
      return { status: 'need-range' };
    }
    player.rangeCombos = combos;
  }

  const scores = basePlayers.map(() => 0);
  let completed = 0;

  for (let i = 0; i < iterations; i += 1) {
    const usedCards = new Set(board);
    const resolvedPlayers = [];
    let failed = false;

    for (let idx = 0; idx < basePlayers.length; idx += 1) {
      const player = basePlayers[idx];
      if (player.mode === 'hand') {
        resolvedPlayers[idx] = {
          id: player.id,
          label: player.label,
          cards: player.fixedCards
        };
        player.fixedCards.forEach((card) => usedCards.add(card));
        continue;
      }

      const available = player.rangeCombos.filter((combo) => (
        combo.cards.every((card) => !usedCards.has(card))
      ));
      const picked = pickWeightedCombo(available);
      if (!picked) {
        failed = true;
        break;
      }
      resolvedPlayers[idx] = {
        id: player.id,
        label: player.label,
        cards: picked.cards
      };
      picked.cards.forEach((card) => usedCards.add(card));
    }

    if (failed) {
      continue;
    }

    const deck = getDeck([...usedCards]);
    const shuffled = fisherYates(deck);
    const drawnBoard = [...board];
    const boardNeeded = 5 - drawnBoard.length;
    if (boardNeeded > 0) {
      drawnBoard.push(...shuffled.slice(0, boardNeeded));
    }

    const solvedHands = resolvedPlayers.map((player) => Hand.solve([...player.cards, ...drawnBoard]));
    const winners = Hand.winners(solvedHands);
    winners.forEach((winnerHand) => {
      const idx = solvedHands.findIndex((hand) => hand === winnerHand);
      if (idx >= 0) {
        scores[idx] += 1 / winners.length;
      }
    });
    completed += 1;
  }

  if (completed === 0) {
    return { status: 'range-conflict' };
  }

  return {
    status: 'ok',
    iterations: completed,
    players: basePlayers.map((player, idx) => ({
      id: player.id,
      label: player.label,
      equity: scores[idx] / completed
    }))
  };
}

export const deckList = FULL_DECK;
