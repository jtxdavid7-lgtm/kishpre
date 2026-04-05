import { Hand } from 'pokersolver';

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

export function simulateEquity({
  players,
  boardCards,
  iterations = 5000
}) {
  const board = boardCards.filter(Boolean);
  if (!players || players.length < 2) {
    return { status: 'need-players' };
  }

  const allPlayerCards = players.flatMap((player) => player.cards || []).filter(Boolean);
  if (players.some((player) => (player.cards?.filter(Boolean).length ?? 0) !== 2)) {
    return { status: 'need-cards' };
  }

  const deck = getDeck([...board, ...allPlayerCards]);
  if (deck.length < (5 - board.length)) {
    return { status: 'invalid' };
  }

  const scores = players.map(() => 0);

  for (let i = 0; i < iterations; i += 1) {
    const shuffled = fisherYates(deck);
    const drawnBoard = [...board];
    const boardNeeded = 5 - drawnBoard.length;
    if (boardNeeded > 0) {
      drawnBoard.push(...shuffled.slice(0, boardNeeded));
    }

    const solvedHands = players.map((player) => Hand.solve([...player.cards, ...drawnBoard]));
    const winners = Hand.winners(solvedHands);
    winners.forEach((winnerHand) => {
      const idx = solvedHands.findIndex((hand) => hand === winnerHand);
      if (idx >= 0) {
        scores[idx] += 1 / winners.length;
      }
    });
  }

  return {
    status: 'ok',
    iterations,
    players: players.map((player, idx) => ({
      id: player.id,
      label: player.label,
      equity: scores[idx] / iterations
    }))
  };
}

export const deckList = FULL_DECK;
