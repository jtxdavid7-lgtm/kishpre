import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const datasetDir = path.resolve(
  process.cwd(),
  'public/data/gto/gg-rnc-6max-100bb-drop-1p5bb-postflop-validation-v1'
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const manifest = JSON.parse(await fs.readFile(path.join(datasetDir, 'manifest.json'), 'utf8'));
assert(manifest.schemaVersion === 1, 'manifest schemaVersion 必须为 1');
assert(manifest.scope === 'validation', '验证数据包必须明确标记为 validation');
assert(manifest.realtimeSolver === false, '静态数据包不能标记为实时 solver');
assert(manifest.packs.length > 0, '至少需要一个翻后牌面数据包');

for (const pack of manifest.packs) {
  const index = JSON.parse(await fs.readFile(path.join(datasetDir, pack.index), 'utf8'));
  assert(index.schemaVersion === 1, `${pack.id}: index schemaVersion 必须为 1`);
  assert(index.postflopDecisionNodes === index.nodes.length, `${pack.id}: 决策节点总数不一致`);
  assert(index.rootId === 0, `${pack.id}: 根节点必须为 0`);
  assert(index.handLabels.length === 169, `${pack.id}: 起手牌标签必须为 169 个`);
  assert(JSON.stringify(index.board) === JSON.stringify(pack.board), `${pack.id}: 公共牌与 manifest 不一致`);

  const streetCounts = { 1: 0, 2: 0, 3: 0 };
  const chunkBuffers = await Promise.all(index.chunks.map(async (chunk, chunkId) => {
    const buffer = await fs.readFile(path.join(datasetDir, chunk.filename));
    assert(buffer.byteLength === chunk.byteLength, `${pack.id}: 数据块 ${chunkId} 长度不一致`);
    return buffer;
  }));

  for (const node of index.nodes) {
    assert(node.id >= 0 && index.nodes[node.id] === node, `${pack.id}: 节点 ID 必须连续`);
    assert([1, 2, 3].includes(node.street), `${pack.id}: 节点 ${node.id} 街道无效`);
    assert(node.board.length === node.street + 2, `${pack.id}: 节点 ${node.id} 公共牌数量无效`);
    assert(node.actions.length > 0, `${pack.id}: 节点 ${node.id} 没有行动`);
    streetCounts[node.street] += 1;

    const expectedBytes = 169 * (3 + node.actions.length * 2) * 4;
    assert(node.byteLength === expectedBytes, `${pack.id}: 节点 ${node.id} 二进制长度无效`);
    const chunk = chunkBuffers[node.chunk];
    assert(chunk && node.byteOffset + node.byteLength <= chunk.byteLength, `${pack.id}: 节点 ${node.id} 越过数据块边界`);

    if (node.parentId === null) {
      assert(node.id === index.rootId, `${pack.id}: 只有根节点可以没有父节点`);
    } else {
      const parent = index.nodes[node.parentId];
      assert(parent?.children.some((child) => child.nextId === node.id), `${pack.id}: 节点 ${node.id} 缺少父级链接`);
    }
    for (const child of node.children) {
      assert(node.actions.includes(child.label), `${pack.id}: 节点 ${node.id} 子行动不在行动列表中`);
      if (child.nextId === null) {
        assert(child.terminal === true, `${pack.id}: 节点 ${node.id} 空子节点必须为终局`);
      } else {
        assert(index.nodes[child.nextId]?.parentId === node.id, `${pack.id}: 节点 ${node.id} 子级反向链接无效`);
      }
    }

    const view = new DataView(chunk.buffer, chunk.byteOffset + node.byteOffset, node.byteLength);
    let offset = 0;
    for (const hand of index.handLabels) {
      const combinations = view.getFloat32(offset, true);
      const reach = view.getFloat32(offset + 4, true);
      const totalEv = view.getFloat32(offset + 8, true);
      offset += 12;
      assert(Number.isFinite(combinations) && combinations >= 0 && combinations <= 12, `${pack.id}: 节点 ${node.id} ${hand} 组合数无效`);
      assert(Number.isFinite(reach) && reach >= -1e-6 && reach <= 1 + 1e-6, `${pack.id}: 节点 ${node.id} ${hand} 到达权重无效`);
      assert(Number.isFinite(totalEv), `${pack.id}: 节点 ${node.id} ${hand} 总 EV 非有限数`);

      let frequencySum = 0;
      for (const action of node.actions) {
        const frequency = view.getFloat32(offset, true);
        const actionEv = view.getFloat32(offset + 4, true);
        offset += 8;
        assert(Number.isFinite(frequency) && frequency >= -1e-5 && frequency <= 1 + 1e-5, `${pack.id}: 节点 ${node.id} ${hand} ${action} 频率无效`);
        assert(Number.isFinite(actionEv), `${pack.id}: 节点 ${node.id} ${hand} ${action} EV 非有限数`);
        frequencySum += frequency;
      }
      if (reach > 1e-6) {
        assert(Math.abs(frequencySum - 1) < 0.005, `${pack.id}: 节点 ${node.id} ${hand} 频率未闭合 (${frequencySum})`);
      }
    }
    assert(offset === node.byteLength, `${pack.id}: 节点 ${node.id} 解码长度不一致`);
  }

  assert(JSON.stringify(streetCounts) === JSON.stringify(index.decisionsByStreet), `${pack.id}: 分街节点统计不一致`);
  assert(JSON.stringify(streetCounts) === JSON.stringify(pack.decisionsByStreet), `${pack.id}: manifest 分街统计不一致`);
  console.log(`${pack.id}: ${index.nodes.length} nodes verified (${streetCounts[1]} flop / ${streetCounts[2]} turn / ${streetCounts[3]} river)`);
}

console.log('Postflop static snapshot validation passed.');
