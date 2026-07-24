import fs from 'node:fs/promises';
import path from 'node:path';
import {
  buildFlopAggregateReport
} from './lib/flop-aggregate-report.mjs';

const inputDirectory = path.resolve(
  process.env.GTO_FLOP_BATCH_INPUT ?? 'F:/kish-gto/flop-batch-v1'
);
const outputDirectory = path.resolve(
  process.env.GTO_FLOP_REPORT_OUTPUT ??
    'public/data/gto/gg-rnc-6max-100bb-drop-1p5bb-flop-aggregate-v1'
);
const allowPartial = process.argv.includes('--allow-partial');
const maximumFlopsArgument = process.argv.find((argument) => argument.startsWith('--limit='));
const maximumFlops = maximumFlopsArgument
  ? Number.parseInt(maximumFlopsArgument.slice('--limit='.length), 10)
  : 0;

const report = await buildFlopAggregateReport({
  inputDirectory,
  allowPartial,
  maximumFlops
});
await fs.mkdir(outputDirectory, { recursive: true });

const manifestNodes = [];
let totalNodeBytes = 0;
for (const node of report.nodes) {
  const filename = `node-${String(node.id).padStart(3, '0')}.json`;
  const payload = JSON.stringify(node);
  const targetPath = path.join(outputDirectory, filename);
  const temporaryPath = `${targetPath}.tmp`;
  await fs.writeFile(temporaryPath, payload, 'utf8');
  await fs.rename(temporaryPath, targetPath);
  totalNodeBytes += Buffer.byteLength(payload);
  manifestNodes.push({
    id: node.id,
    key: node.key,
    actor: node.actor,
    pot: node.pot,
    spr: node.spr,
    actions: node.actions,
    aggregate: node.aggregate,
    filename
  });
}

const manifest = {
  ...report,
  nodes: manifestNodes
};
const manifestPath = path.join(outputDirectory, 'manifest.json');
const temporaryManifestPath = `${manifestPath}.tmp`;
await fs.writeFile(temporaryManifestPath, JSON.stringify(manifest), 'utf8');
await fs.rename(temporaryManifestPath, manifestPath);

console.log(JSON.stringify({
  outputDirectory,
  partial: report.partial,
  completedFlops: report.completedFlops,
  totalCanonicalFlops: report.totalCanonicalFlops,
  concreteFlopWeight: report.concreteFlopWeight,
  nodes: report.nodeCount,
  manifestBytes: Buffer.byteLength(JSON.stringify(manifest)),
  totalNodeBytes
}, null, 2));
