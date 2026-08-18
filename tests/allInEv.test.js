import { describe, expect, it } from 'vitest';
import pkg from 'pokersolver';
import { calculateAllInEvForHero, holdemWinnerIndexes } from '../src/lib/allInEv.js';
import { parseGgHand, summarizeHeroResults } from '../src/lib/handHistoryAnalyzer.js';

const TURN_BOARD = ['Ah', 'Ad', 'Kc', 'Kd'];
const FINAL_VILLAIN_BOARD = 'Board [Ah Ad Kc Kd Jc]';
const { Hand } = pkg;

function lockedAction(player, contributionAfter, { allIn = false, board = TURN_BOARD, type = 'call' } = {}) {
  return {
    player,
    type,
    contributionAfter,
    allIn,
    board
  };
}

function calculateHeadsUp(raw = FINAL_VILLAIN_BOARD) {
  return calculateAllInEvForHero({
    raw,
    handId: 'EV-HEADS-UP',
    hero: 'Hero',
    holeCards: new Map([
      ['Hero', ['Qs', 'Qh']],
      ['Villain', ['Js', 'Jh']]
    ]),
    actions: [
      lockedAction('Hero', 100, { allIn: true, type: 'bet' }),
      lockedAction('Villain', 100, { allIn: true })
    ],
    contributions: new Map([['Hero', 100], ['Villain', 100]]),
    foldedPlayers: new Set()
  });
}

describe('All-in EV calculation', () => {
  it('matches the established evaluator across randomized heads-up and multiway showdowns', () => {
    const deck = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A']
      .flatMap((rank) => ['s', 'h', 'd', 'c'].map((suit) => `${rank}${suit}`));
    let state = 0x5eed1234;
    const random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };

    for (let sample = 0; sample < 500; sample += 1) {
      const shuffled = deck.slice();
      for (let index = shuffled.length - 1; index > 0; index -= 1) {
        const swap = Math.floor(random() * (index + 1));
        [shuffled[index], shuffled[swap]] = [shuffled[swap], shuffled[index]];
      }
      const playerCount = 2 + (sample % 5);
      const board = shuffled.slice(0, 5);
      const holeCardSets = Array.from({ length: playerCount }, (_, index) => (
        shuffled.slice(5 + index * 2, 7 + index * 2)
      ));
      const solved = holeCardSets.map((cards) => Hand.solve([...cards, ...board]));
      const expected = Hand.winners(solved).map((winner) => solved.indexOf(winner)).sort((a, b) => a - b);

      expect(holdemWinnerIndexes(holeCardSets, board)).toEqual(expected);
    }
  });

  it('enumerates the remaining turn card and replaces a losing result with its expected pot share', () => {
    const result = calculateHeadsUp();

    expect(result).toMatchObject({
      opportunity: true,
      covered: true,
      method: 'exact',
      relevantPotCount: 1,
      coveredPotCount: 1,
      samples: 44
    });
    expect(result.adjustment).toBeCloseTo(200 * (40 / 44), 8);
  });

  it('uses both actual runouts while retaining the same lock-point equity', () => {
    const result = calculateHeadsUp([
      'Hand was run two times',
      'FIRST Board [Ah Ad Kc Kd Jc]',
      'SECOND Board [Ah Ad Kc Kd Qc]'
    ].join('\n'));

    expect(result.covered).toBe(true);
    expect(result.adjustment).toBeCloseTo(200 * ((40 / 44) - 0.5), 8);
  });

  it('calculates a multiway main pot and a heads-up side pot independently', () => {
    const result = calculateAllInEvForHero({
      raw: FINAL_VILLAIN_BOARD,
      handId: 'EV-SIDE-POT',
      hero: 'Hero',
      holeCards: new Map([
        ['Hero', ['Qs', 'Qh']],
        ['Short', ['2c', '2d']],
        ['Deep', ['Js', 'Jh']]
      ]),
      actions: [
        lockedAction('Short', 50, { allIn: true, type: 'bet' }),
        lockedAction('Hero', 50),
        lockedAction('Deep', 50),
        lockedAction('Hero', 100, { allIn: true, type: 'bet' }),
        lockedAction('Deep', 100, { allIn: true })
      ],
      contributions: new Map([['Hero', 100], ['Short', 50], ['Deep', 100]]),
      foldedPlayers: new Set()
    });

    expect(result).toMatchObject({
      opportunity: true,
      covered: true,
      method: 'exact',
      relevantPotCount: 2,
      coveredPotCount: 2
    });
    expect(result.adjustment).toBeGreaterThan(0);
    expect(result.adjustment).toBeLessThan(250);
  });

  it('fails closed when an eligible all-in hand is not shown', () => {
    const result = calculateAllInEvForHero({
      raw: FINAL_VILLAIN_BOARD,
      handId: 'EV-HIDDEN-CARDS',
      hero: 'Hero',
      holeCards: new Map([['Hero', ['Qs', 'Qh']]]),
      actions: [
        lockedAction('Hero', 100, { allIn: true, type: 'bet' }),
        lockedAction('Villain', 100)
      ],
      contributions: new Map([['Hero', 100], ['Villain', 100]]),
      foldedPlayers: new Set()
    });

    expect(result).toMatchObject({
      opportunity: true,
      covered: false,
      method: 'unsupported',
      adjustment: 0,
      coveredPotCount: 0
    });
    expect(result.reason).toContain('未公开底牌');
  });

  it('parses GG actions and drives the yellow curve from real All-in EV', () => {
    const raw = `Poker Hand #EV100: Hold'em No Limit ($0.5/$1) - 2026/08/05 12:00:00
Table 'AllInTest' 2-max Seat #1 is the button
Seat 1: Hero ($100 in chips)
Seat 2: Villain ($100 in chips)
Hero: posts small blind $0.5
Villain: posts big blind $1
*** HOLE CARDS ***
Dealt to Hero [Qs Qh]
Dealt to Villain
Hero: calls $0.5
Villain: checks
*** FLOP *** [Ah Ad Kc]
Villain: checks
Hero: checks
*** TURN *** [Ah Ad Kc] [Kd]
Hero: bets $99 and is all-in
Villain: calls $99 and is all-in
Hero: shows [Qs Qh]
Villain: shows [Js Jh]
*** RIVER *** [Ah Ad Kc Kd] [Jc]
*** SHOWDOWN ***
Villain collected $200 from pot
*** SUMMARY ***
Total pot $200 | Rake $0 | Jackpot $0 | Bingo $0 | Fortune $0 | Tax $0
Board [Ah Ad Kc Kd Jc]
Seat 1: Hero (button) showed [Qs Qh] and lost with two pair
Seat 2: Villain (big blind) showed [Js Jh] and won ($200) with a full house`;
    const heroResult = parseGgHand(raw).getHeroResult('Hero');
    const summary = summarizeHeroResults([heroResult]);

    expect(heroResult.allInEvCovered).toBe(true);
    expect(heroResult.allInEvMethod).toBe('exact');
    expect(heroResult.allInEvBeforeRakeBB).toBeCloseTo(-100 + 200 * (40 / 44), 8);
    expect(summary.curve[0].evBB).toBeCloseTo(heroResult.allInEvBeforeRakeBB, 8);
    expect(summary.curve[0].evBB).not.toBeCloseTo(heroResult.profitBB, 4);
    expect(summary).toMatchObject({
      allInEvOpportunityCount: 1,
      allInEvCoveredCount: 1,
      allInEvExactCount: 1,
      allInEvEstimatedCount: 0
    });
  });
});
