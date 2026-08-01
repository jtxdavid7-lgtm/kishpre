import { parseGgHand } from '../lib/handHistoryAnalyzer.js';
import {
  compactParsedHand,
  iterateGgHandHistories,
  primaryHeroFromChunks
} from '../lib/handHistoryImport.js';

const DEFAULT_BATCH_SIZE = 200;

function countHands(chunks) {
  let total = 0;
  for (const chunk of chunks) {
    for (const _raw of iterateGgHandHistories(chunk?.text)) total += 1;
  }
  return total;
}

self.onmessage = (event) => {
  const chunks = Array.isArray(event.data?.chunks) ? event.data.chunks : [];
  const batchSize = Math.max(25, Number(event.data?.batchSize) || DEFAULT_BATCH_SIZE);

  try {
    const total = countHands(chunks);
    const primaryHero = primaryHeroFromChunks(chunks);
    let completed = 0;
    let batch = [];

    self.postMessage({ type: 'ready', total, primaryHero });

    for (const chunk of chunks) {
      for (const raw of iterateGgHandHistories(chunk?.text)) {
        batch.push(compactParsedHand(parseGgHand(raw), primaryHero));
        completed += 1;

        if (batch.length >= batchSize) {
          self.postMessage({ type: 'batch', hands: batch, completed, total, primaryHero });
          batch = [];
        }
      }
    }

    if (batch.length) {
      self.postMessage({ type: 'batch', hands: batch, completed, total, primaryHero });
    }
    self.postMessage({ type: 'done', completed, total, primaryHero });
  } catch (error) {
    self.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : '牌谱解析失败'
    });
  }
};
