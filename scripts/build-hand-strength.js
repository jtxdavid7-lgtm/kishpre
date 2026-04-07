import { simulateEquity } from '../src/lib/equityEngine.js';
import { writeFile } from 'node:fs/promises';

const RANKS = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];
const SUFFIXES = ['s', 'o'];

function buildLabel(rowRank, colRank) {
  if (rowRank === colRank) return `${rowRank}${colRank}`;
  const suited = RANKS.indexOf(rowRank) < RANKS.indexOf(colRank) ? 's' : 'o';
  const high = RANKS.indexOf(rowRank) <= RANKS.indexOf(colRank) ? rowRank : colRank;
  const low = high === rowRank ? colRank : rowRank;
  return `${high}${low}${suited}`;
}

function buildAllLabels() {
  const labels = [];
  for (let i = 0; i < RANKS.length; i += 1) {
    for (let j = 0; j < RANKS.length; j += 1) {
      if (i === j) {
        labels.push(`${RANKS[i]}${RANKS[j]}`);
      } else if (i < j) {
        labels.push(`${RANKS[i]}${RANKS[j]}s`);
      } else {
        labels.push(`${RANKS[j]}${RANKS[i]}o`);
      }
    }
  }
  return Array.from(new Set(labels));
}

function buildFullRange() {
  const range = {};
  for (let i = 0; i < RANKS.length; i += 1) {
    for (let j = i; j < RANKS.length; j += 1) {
      if (i === j) {
        range[`${RANKS[i]}${RANKS[j]}`] = { weight: 1 };
      } else {
        range[`${RANKS[i]}${RANKS[j]}s`] = { weight: 1 };
        range[`${RANKS[i]}${RANKS[j]}o`] = { weight: 1 };
      }
    }
  }
  return range;
}

async function main() {
  const labels = buildAllLabels();
  const fullRange = buildFullRange();
  const iterations = Number(process.env.HAND_ITERATIONS ?? 5000);
  const results = [];

  for (let idx = 0; idx < labels.length; idx += 1) {
    const label = labels[idx];
    const sim = simulateEquity({
      players: [
        { id: 'hero', label: 'Hero', mode: 'range', range: { [label]: { weight: 1 } } },
        { id: 'villain', label: 'Villain', mode: 'range', range: fullRange }
      ],
      boardCards: [],
      iterations
    });
    if (sim.status !== 'ok') {
      throw new Error(`Simulation failed for ${label}: ${sim.status}`);
    }
    const equity = sim.players[0].equity;
    results.push({ label, equity });
    process.stdout.write(`\rProcessed ${idx + 1}/${labels.length}`);
  }

  results.sort((a, b) => b.equity - a.equity);
  const ordered = results.map((entry) => entry.label);
  const map = Object.fromEntries(results.map((entry) => [entry.label, entry.equity]));

  await writeFile(
    new URL('../src/data/handStrength.json', import.meta.url),
    JSON.stringify({ generatedAt: new Date().toISOString(), iterations, order: ordered, equity: map }, null, 2),
    'utf8'
  );
  process.stdout.write('\nDone.\n');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
