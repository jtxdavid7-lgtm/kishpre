import { parseGgHand } from './handHistoryAnalyzer.js';

const HAND_START = 'Poker Hand #';

export function* iterateGgHandHistories(text) {
  const source = String(text ?? '');
  let start = source.indexOf(HAND_START);

  while (start >= 0) {
    const next = source.indexOf(HAND_START, start + HAND_START.length);
    const raw = source.slice(start, next >= 0 ? next : source.length).trim();
    if (raw.startsWith(HAND_START)) yield raw;
    if (next < 0) break;
    start = next;
  }
}

export function primaryHeroFromChunks(chunks = []) {
  const dealtCounts = new Map();
  const playerCounts = new Map();

  for (const chunk of chunks) {
    for (const raw of iterateGgHandHistories(chunk?.text)) {
      const match = raw.match(/^Dealt to (.+?)(?: \[[^\]]+\])?\s*$/m);
      const name = match?.[1]?.trim();
      if (name) dealtCounts.set(name, (dealtCounts.get(name) ?? 0) + 1);

      for (const seatMatch of raw.matchAll(/^Seat \d+: (.+?) \(\$[-\d,.]+ in chips\)/gm)) {
        const player = seatMatch[1]?.trim();
        if (player) playerCounts.set(player, (playerCounts.get(player) ?? 0) + 1);
      }
    }
  }

  return [...dealtCounts.entries()]
    .sort((left, right) => (
      right[1] - left[1]
      || (playerCounts.get(right[0]) ?? 0) - (playerCounts.get(left[0]) ?? 0)
      || left[0].localeCompare(right[0])
    ))
    .at(0)?.[0] ?? '';
}

export function compactParsedHand(hand, primaryHero = '') {
  if (!hand || typeof hand !== 'object') return hand;
  const normalizedHero = String(primaryHero ?? '').trim();
  const precomputedHeroResult = normalizedHero
    ? hand.getHeroResult?.(normalizedHero) ?? null
    : null;
  const { getHeroResult: _getHeroResult, ...serializableHand } = hand;

  return {
    ...serializableHand,
    precomputedHero: normalizedHero,
    precomputedHeroResult
  };
}

export function hydrateImportedHand(hand) {
  if (!hand || typeof hand !== 'object' || typeof hand.getHeroResult === 'function') return hand;

  Object.defineProperty(hand, 'getHeroResult', {
    configurable: true,
    enumerable: false,
    value(hero) {
      const normalizedHero = String(hero ?? '').trim();
      if (normalizedHero && normalizedHero === this.precomputedHero) {
        return this.precomputedHeroResult ?? null;
      }
      if (!normalizedHero || !this.raw) return null;
      if (this.players?.has && !this.players.has(normalizedHero)) return null;

      const reparsed = parseGgHand(this.raw);
      return reparsed.getHeroResult(normalizedHero);
    }
  });

  return hand;
}
