import fs from 'node:fs/promises';
import path from 'node:path';
import { GTO_FORMAL_CONFIG } from '../../src/data/gtoFormal.js';

const dataDirectory = path.resolve('public/data/gto/gg-rnc-6max-100bb-drop-1p5bb-v1');
const index = JSON.parse(await fs.readFile(path.join(dataDirectory, 'index.json'), 'utf8'));
const errors = [];

if (index.schemaVersion !== 3) errors.push(`索引版本为 ${index.schemaVersion}，应为 3`);
if (index.nodes.length !== GTO_FORMAL_CONFIG.preflopDecisionNodes) {
  errors.push(`翻前节点数为 ${index.nodes.length}，应为 ${GTO_FORMAL_CONFIG.preflopDecisionNodes}`);
}
if (index.handLabels.length !== 169) errors.push(`起手牌格数为 ${index.handLabels.length}，应为 169`);
if (index.rootId !== 0 || index.nodes[0]?.parentId !== null) errors.push('根节点定义不正确');

const buffers = await Promise.all(index.chunks.map(async (chunk) => {
  const buffer = await fs.readFile(path.join(dataDirectory, chunk.filename));
  if (buffer.length !== chunk.byteLength) errors.push(`${chunk.filename} 文件长度不匹配`);
  return buffer;
}));

const reachable = new Set();
const queue = [index.rootId];
while (queue.length) {
  const nodeId = queue.shift();
  if (reachable.has(nodeId)) continue;
  const node = index.nodes[nodeId];
  if (!node) {
    errors.push(`引用了不存在的节点 ${nodeId}`);
    continue;
  }
  reachable.add(nodeId);
  node.children.forEach((child) => {
    if (child.nextId !== null) queue.push(child.nextId);
  });
}
if (reachable.size !== index.nodes.length) errors.push(`可达节点 ${reachable.size} / ${index.nodes.length}`);

for (const node of index.nodes) {
  const expectedByteLength = index.handLabels.length * (2 + node.actions.length * 2) * 4;
  if (node.byteLength !== expectedByteLength) errors.push(`${node.id}: 数据长度 ${node.byteLength}，应为 ${expectedByteLength}`);
  if (!node.actions.length) errors.push(`${node.id}: 没有可选行动`);
  if (node.children.length !== node.actions.length) errors.push(`${node.id}: 行动与子分支数量不一致`);
  if (node.parentId !== null && !index.nodes[node.parentId]) errors.push(`${node.id}: 父节点不存在`);

  const buffer = buffers[node.chunk];
  const view = new DataView(buffer.buffer, buffer.byteOffset + node.byteOffset, node.byteLength);
  let offset = 0;
  for (const label of index.handLabels) {
    const reach = view.getFloat32(offset, true);
    const totalEv = view.getFloat32(offset + 4, true);
    offset += 8;
    let frequencyTotal = 0;
    if (!Number.isFinite(reach) || reach < -1e-6 || reach > 1 + 1e-6) errors.push(`${node.id}/${label}: 到达权重越界`);
    if (!Number.isFinite(totalEv)) errors.push(`${node.id}/${label}: 总 EV 非有限数值`);
    for (const action of node.actions) {
      const frequency = view.getFloat32(offset, true);
      const actionEv = view.getFloat32(offset + 4, true);
      offset += 8;
      frequencyTotal += frequency;
      if (!Number.isFinite(frequency) || frequency < -1e-6 || frequency > 1 + 1e-6) errors.push(`${node.id}/${label}/${action}: 频率越界`);
      if (!Number.isFinite(actionEv)) errors.push(`${node.id}/${label}/${action}: EV 非有限数值`);
    }
    if (reach > 1e-9 && Math.abs(frequencyTotal - 1) > 0.002) errors.push(`${node.id}/${label}: 频率和为 ${frequencyTotal}`);
  }
}

if (errors.length) {
  console.error(errors.slice(0, 100).join('\n'));
  if (errors.length > 100) console.error(`另有 ${errors.length - 100} 个错误未显示`);
  process.exitCode = 1;
} else {
  const binaryBytes = index.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  console.log(`${GTO_FORMAL_CONFIG.id}: ${index.nodes.length} 个完整翻前节点、${index.chunks.length} 个策略块通过校验（${binaryBytes} bytes）。`);
}
