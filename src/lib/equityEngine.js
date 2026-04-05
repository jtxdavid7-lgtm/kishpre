import { Hand } from 'pokersolver';

const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const SUITS = ['s', 'h', 'd', 'c'];
const FULL_DECK = RANKS.flatMap((rank) => SUITS.map((suit) => `${rank}${suit}`));

function getDeck(excluded) {
  const blocked = new Set(excluded.filter(Boolean));
  return FULL_DECK.filter((card) => !blocked.has(card));
}

function drawCards(deck, count, startIndex) {
  return deck.slice(startIndex, startIndex + count);
}

export function simulateEquity({
  heroCards,
  boardCards,
  opponents = 1,
  iterations = 4000
}) {
  const hero = heroCards.filter(Boolean);
  const board = boardCards.filter(Boolean);

  if (hero.length !== 2) {
    return { status: 'incomplete' };
  }

  const deck = getDeck([...hero, ...board]);
  if ((opponents * 2) + (5 - board.length) > deck.length) {
    return { status: 'invalid' };
  }

  let wins = 0;
  let ties = 0;
  let losses = 0;
  const sample = [];

  for (let i = 0; i < iterations; i += 1) {
    const shuffled = deck.slice();
    for (let j = shuffled.length - 1; j > 0; j -= 1) {
      const k = Math.floor(Math.random() * (j + 1));
      [shuffled[j], shuffled[k]] = [shuffled[k], shuffled[j]];
    }
    const drawnBoard = [...board];
    const boardNeeded = 5 - drawnBoard.length;
    if (boardNeeded > 0) {
      drawnBoard.push(...drawCards(shuffled, boardNeeded, 0));
    }

    const heroHand = Hand.solve([...hero, ...drawnBoard]);
    const villainHands = [];
    for (let v = 0; v < opponents; v += 1) {
      const start = boardNeeded + (v * 2);
      const villainCards = drawCards(shuffled, 2, start);
      villainHands.push(Hand.solve([...villainCards, ...drawnBoard]));
    }

    const winners = Hand.winners([heroHand, ...villainHands]);
    if (winners.includes(heroHand)) {
      if (winners.length > 1) ties += 1;
      else wins += 1;
    } else {
      losses += 1;
    }

    if (sample.length < 3) {
      sample.push({
        hero: heroHand.descr,
        villains: villainHands.map((hand) => hand.descr)
      });
    }
  }

  const total = wins + ties + losses || 1;
  return {
    status: 'ok',
    iterations: total,
    winPct: wins / total,
    tiePct: ties / total,
    losePct: losses / total,
    sample
  };
}

export const deckList = FULL_DECK;
