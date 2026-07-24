import fs from 'node:fs/promises';
import path from 'node:path';
import { buildTurnAggregateForFlop } from './lib/turn-aggregate-report.mjs';

const inputDirectory = path.resolve(
  process.env.GTO_TURN_BATCH_INPUT ?? 'F:/kish-gto/turn-batch-v1'
);
const outputDirectory = path.resolve(
  process.env.GTO_TURN_REPORT_OUTPUT ?? 'F:/kish-gto/turn-aggregate-v1'
);
const allowPartial = process.argv.includes('--allow-partial');
const limitArgument = process.argv.find((argument) => argument.startsWith('--limit='));
const limit = limitArgument ? Number.parseInt(limitArgument.slice('--limit='.length), 10) : 0;
const checkpointPath = path.join(outputDirectory, 'checkpoint.json');

async function writeJsonAtomic(filePath, value) {
  const temporaryPath = `${filePath}.tmp`;
  await fs.writeFile(temporaryPath, JSON.stringify(value), 'utf8');
  await fs.rename(temporaryPath, filePath);
}

const sourceCheckpoint = JSON.parse(
  await fs.readFile(path.join(inputDirectory, 'checkpoint.json'), 'utf8')
);
if (sourceCheckpoint.failures?.length) {
  throw new Error(`转牌批次仍有 ${sourceCheckpoint.failures.length} 个失败项`);
}
if (
  !allowPartial &&
  sourceCheckpoint.completed.length !== sourceCheckpoint.requestedFlops
) {
  throw new Error(
    `转牌批次尚未完成：${sourceCheckpoint.completed.length}/${sourceCheckpoint.requestedFlops}`
  );
}
const tree = JSON.parse(await fs.readFile(path.join(inputDirectory, 'turn-tree.json'), 'utf8'));
if (tree.schemaVersion !== 1 || tree.nodeCount !== 72 || tree.nodes.length !== 72) {
  throw new Error('转牌节点树格式无效');
}
const requested = limit > 0
  ? sourceCheckpoint.completed.slice(0, limit)
  : sourceCheckpoint.completed;
await fs.mkdir(outputDirectory, { recursive: true });

let checkpoint;
try {
  checkpoint = JSON.parse(await fs.readFile(checkpointPath, 'utf8'));
} catch {
  checkpoint = {
    schemaVersion: 1,
    datasetId: 'gg-rnc-6max-100bb-btn-vs-bb-srp-turn-aggregate-v1',
    generatedAt: new Date().toISOString(),
    sourceDirectory: inputDirectory,
    requestedFlops: requested.length,
    completed: [],
    failures: []
  };
}

const completedIds = new Set(checkpoint.completed.map((entry) => entry.id));
for (const flopEntry of requested) {
  if (completedIds.has(flopEntry.id)) continue;
  try {
    const report = await buildTurnAggregateForFlop({ inputDirectory, flopEntry, tree });
    const filename = `${flopEntry.id}.json`;
    await writeJsonAtomic(path.join(outputDirectory, filename), report);
    checkpoint.failures = checkpoint.failures.filter((failure) => failure.id !== flopEntry.id);
    checkpoint.completed = checkpoint.completed.filter((entry) => entry.id !== flopEntry.id);
    checkpoint.completed.push({
      id: flopEntry.id,
      flop: flopEntry.flop,
      filename,
      canonicalTurnCount: report.canonicalTurnCount,
      concreteTurnWeight: report.concreteTurnWeight,
      nodeCount: report.nodeCount,
      completedAt: new Date().toISOString()
    });
    completedIds.add(flopEntry.id);
    await writeJsonAtomic(checkpointPath, checkpoint);
    console.log(JSON.stringify({
      event: 'turn-aggregate-complete',
      progress: `${checkpoint.completed.length}/${requested.length}`,
      id: flopEntry.id,
      filename
    }));
  } catch (error) {
    checkpoint.failures = checkpoint.failures.filter((failure) => failure.id !== flopEntry.id);
    checkpoint.failures.push({
      id: flopEntry.id,
      error: error.message,
      failedAt: new Date().toISOString()
    });
    await writeJsonAtomic(checkpointPath, checkpoint);
    throw error;
  }
}

checkpoint.finishedAt = new Date().toISOString();
await writeJsonAtomic(checkpointPath, checkpoint);
await writeJsonAtomic(path.join(outputDirectory, 'manifest.json'), {
  schemaVersion: 1,
  datasetId: checkpoint.datasetId,
  generatedAt: checkpoint.generatedAt,
  solved: true,
  realtimeSolver: false,
  partial: requested.length !== sourceCheckpoint.requestedFlops,
  completedFlops: checkpoint.completed.length,
  totalCanonicalFlops: sourceCheckpoint.totalCanonicalFlops,
  totalCanonicalTurnHistories: sourceCheckpoint.totalCanonicalTurnHistories,
  nodeCount: tree.nodeCount,
  reports: checkpoint.completed
});
console.log(JSON.stringify({
  event: 'turn-aggregate-finished',
  outputDirectory,
  completed: checkpoint.completed.length,
  failures: checkpoint.failures.length
}));
