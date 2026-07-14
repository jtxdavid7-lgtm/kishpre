import { useEffect, useMemo, useRef, useState } from 'react';
import { RangeMatrix } from './components/RangeMatrix.jsx';
import { RangeEditor } from './components/RangeEditor.jsx';
import { BASE_RANGES } from './data/base';
import { PROFILES } from './data/profiles';
import { getRangePayload } from './lib/rangeEngine';
import { simulateEquity } from './lib/equityEngine';
import JSZip from 'jszip';
import { Archive } from 'libarchive.js';
import {
  POSITIONS,
  evaluateHandValue,
  exportSummaryCsv,
  parseGgHand,
  splitHandHistories,
  summarizeHeroResults
} from './lib/handHistoryAnalyzer';
import './App.css';

const sceneOptions = Object.values(BASE_RANGES).map((range) => ({
  value: range.key,
  label: `${range.meta.position} · ${range.meta.actionTree}`
}));

const profileOptions = Object.values(PROFILES).map((profile) => ({
  value: profile.key,
  label: profile.label
}));

const SUIT_ICON = { s: '♠', h: '♥', d: '♦', c: '♣' };
const PICKER_RANKS = ['A','K','Q','J','T','9','8','7','6','5','4','3','2'];
const PICKER_SUITS = ['s', 'h', 'c', 'd'];
Archive.init({
  workerUrl: `${import.meta.env.BASE_URL}libarchive.js/dist/worker-bundle.js`
});

const FEATURE_BLUEPRINT = [
  { key: 'reports', action: 'history' },
  { key: 'equity', action: 'equity' },
  { key: 'variance', action: 'variance' },
  { key: 'rng', action: 'download' },
  { key: 'range', action: 'range' }
];
const RNG_DOWNLOAD_PATH = '/downloads/kish-rng-win-x64-0.1.1.zip';
const PERCENTILE_POINTS = [
  { key: 'p05', label: '5% 最差', z: -1.6448536269514722 },
  { key: 'p25', label: '25% 偏低', z: -0.674489750196082 },
  { key: 'p50', label: '50% 中位', z: 0 },
  { key: 'p75', label: '75% 偏高', z: 0.674489750196082 },
  { key: 'p95', label: '95% 最好', z: 1.6448536269514722 }
];

const HOMEPAGE_COPY = {
  zh: {
    hero: {
      eyebrow: '欢迎来到',
      title: 'kishpoker',
      desc: '一个围绕精确决策打造的扑克实验室：牌谱统计、胜率计算以及更多模块将在此聚合。',
      primaryCta: '打开牌谱统计',
      secondaryCta: '胜率计算工具',
      varianceCta: '波动计算器'
    },
    section: {
      title: '工具入口',
      subtitle: '点击打开对应模块'
    },
    features: {
      range: {
        label: 'Range Lab · 施工中',
        title: '实时范围实验室',
        desc: '范围编辑和对手画像功能仍在完善中。'
      },
      equity: {
        label: '胜率计算工具',
        title: '德州计算器',
        desc: '手牌 + 公共牌一键估算。'
      },
      variance: {
        label: 'Variance',
        title: '波动计算器',
        desc: '估算在指定手数下的收益分布、破产概率与极端下行。'
      },
      rng: {
        label: '随机数插件',
        title: '牌桌随机数助手',
        desc: '下载 Windows 插件，在直播或桌边一键生成随机数。'
      },
      reports: {
        label: '牌谱统计',
        title: 'GG 手牌数据报表',
        desc: '导入 GGPoker 手牌历史，查看盈亏、资金曲线、翻前和摊牌数据。'
      }
    },
    actions: {
      range: '进入',
      equity: '进入',
      variance: '进入',
      history: '进入',
      download: '下载'
    }
  },
  en: {
    hero: {
      eyebrow: 'Welcome to',
      title: 'kishpoker',
      desc: 'A poker lab built around precise decisions—hand-history reports, equity sims, and more modules coming soon.',
      primaryCta: 'Open Hand History',
      secondaryCta: 'Run Equity Calculator',
      varianceCta: 'Variance Calculator'
    },
    section: {
      title: 'Toolbox',
      subtitle: 'Pick a module to launch'
    },
    features: {
      range: {
        label: 'Range Lab · WIP',
        title: 'Real-time Range Lab',
        desc: 'Range editing and opponent profiling are still under construction.'
      },
      equity: {
        label: 'Equity Calculator',
        title: 'Hold’em odds tool',
        desc: 'Select hole cards or ranges plus the board and simulate equities instantly.'
      },
      variance: {
        label: 'Variance',
        title: 'Variance calculator',
        desc: 'Project expected value, sigma bands, and risk of ruin for a given sample size.'
      },
      rng: {
        label: 'RNG Plugin',
        title: 'Table-side RNG helper',
        desc: 'Download the Windows helper to generate quick random numbers mid-session.'
      },
      reports: {
        label: 'Hand History',
        title: 'GG hand-history reports',
        desc: 'Import GGPoker hand histories and review profit, curves, preflop, and showdown stats.'
      }
    },
    actions: {
      range: 'Launch',
      equity: 'Launch',
      variance: 'Launch',
      history: 'Launch',
      download: 'Download'
    }
  }
};
const LANGUAGE_LABELS = { zh: '简体中文', en: 'English' };
const emptyHand = () => Array(2).fill(null);
const boardTemplate = () => Array(5).fill(null);
const TOTAL_COMBOS = 1326;

const erf = (x) => {
  const sign = Math.sign(x);
  const absX = Math.abs(x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * absX);
  const expComponent = Math.exp(-absX * absX);
  const poly = (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t;
  return sign * (1 - poly * expComponent);
};

const normalCdf = (x) => 0.5 * (1 + erf(x / Math.SQRT2));

const combosForLabel = (label = '') => {
  if (label.length === 2) return 6; // pocket pairs
  if (label.endsWith('s')) return 4; // suited combos
  return 12; // offsuit combos
};

const summarizeRange = (range = {}) => {
  const entries = Object.entries(range);
  const comboWeight = entries.reduce((sum, [label, value]) => (
    sum + combosForLabel(label) * (value?.weight ?? 0)
  ), 0);
  const coverage = comboWeight / TOTAL_COMBOS;
  return {
    cells: entries.length,
    combos: comboWeight,
    coverage
  };
};

const ARCHIVE_EXTENSIONS = [
  '.zip',
  '.rar',
  '.7z',
  '.tar',
  '.tar.gz',
  '.tgz',
  '.tar.bz2',
  '.tbz2',
  '.tar.xz',
  '.txz',
  '.gz',
  '.bz2',
  '.xz'
];

async function readZipTexts(fileName, data, depth = 0) {
  if (depth > 2) return [];
  const zip = await JSZip.loadAsync(data);
  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  const chunks = [];
  for (const entry of entries) {
    const lower = entry.name.toLowerCase();
    if (lower.endsWith('.txt')) {
      chunks.push({
        name: `${fileName}/${entry.name}`,
        text: await entry.async('string')
      });
    } else {
      const nested = await entry.async('arraybuffer');
      if (!isArchivePayload(entry.name, nested)) continue;
      const nestedFile = new File([nested], entry.name);
      chunks.push(...await readArchiveTexts(`${fileName}/${entry.name}`, nestedFile, nested, depth + 1));
    }
  }
  return chunks;
}

function flattenArchiveFiles(tree, path = '') {
  const files = [];
  for (const [name, value] of Object.entries(tree ?? {})) {
    if (value instanceof File) {
      files.push({ file: value, name: `${path}${name}` });
    } else if (value && typeof value === 'object') {
      files.push(...flattenArchiveFiles(value, `${path}${name}/`));
    }
  }
  return files;
}

async function readGenericArchiveTexts(fileName, file, depth = 0) {
  if (depth > 2) return [];
  const archive = await Archive.open(file);
  try {
    if (await archive.hasEncryptedData()) {
      throw new Error(`${fileName} 是加密压缩包，暂时不能解析。`);
    }
    const extracted = await archive.extractFiles();
    const entries = flattenArchiveFiles(extracted);
    const chunks = [];
    for (const entry of entries) {
      const entryName = `${fileName}/${entry.name}`;
      const data = await entry.file.arrayBuffer();
      const lower = entryName.toLowerCase();
      if (lower.endsWith('.txt')) {
        chunks.push({
          name: entryName,
          text: new TextDecoder('utf-8').decode(data)
        });
      } else if (isArchivePayload(entryName, data)) {
        chunks.push(...await readArchiveTexts(entryName, entry.file, data, depth + 1));
      }
    }
    return chunks;
  } finally {
    await archive.close();
  }
}

function isZipPayload(name, data) {
  const lower = name.toLowerCase();
  const bytes = new Uint8Array(data, 0, Math.min(4, data.byteLength));
  return lower.endsWith('.zip') || (bytes[0] === 0x50 && bytes[1] === 0x4b);
}

function isArchivePayload(name, data) {
  const lower = name.toLowerCase();
  const bytes = new Uint8Array(data, 0, Math.min(264, data.byteLength));
  const hasArchiveExtension = ARCHIVE_EXTENSIONS.some((extension) => lower.endsWith(extension));
  const isRar = bytes[0] === 0x52 && bytes[1] === 0x61 && bytes[2] === 0x72 && bytes[3] === 0x21;
  const isSevenZip = bytes[0] === 0x37 && bytes[1] === 0x7a && bytes[2] === 0xbc && bytes[3] === 0xaf;
  const isGzip = bytes[0] === 0x1f && bytes[1] === 0x8b;
  const isBzip = bytes[0] === 0x42 && bytes[1] === 0x5a && bytes[2] === 0x68;
  const isXz = bytes[0] === 0xfd && bytes[1] === 0x37 && bytes[2] === 0x7a && bytes[3] === 0x58 && bytes[4] === 0x5a;
  const isTar = bytes.length > 262
    && bytes[257] === 0x75
    && bytes[258] === 0x73
    && bytes[259] === 0x74
    && bytes[260] === 0x61
    && bytes[261] === 0x72;
  return hasArchiveExtension || isZipPayload(name, data) || isRar || isSevenZip || isGzip || isBzip || isXz || isTar;
}

async function readArchiveTexts(name, file, data, depth = 0) {
  if (isZipPayload(name, data)) return readZipTexts(name, data, depth);
  return readGenericArchiveTexts(name, file, depth);
}

async function readHistoryFiles(fileList) {
  const files = Array.from(fileList ?? []);
  const chunks = [];
  for (const file of files) {
    const name = file.relativePath || file.webkitRelativePath || file.name;
    const data = await file.arrayBuffer();
    if (isArchivePayload(name, data)) {
      chunks.push(...await readArchiveTexts(name, file, data));
    } else if (name.toLowerCase().endsWith('.txt')) {
      chunks.push({ name, text: new TextDecoder('utf-8').decode(data) });
    } else {
      chunks.push({ name, text: new TextDecoder('utf-8').decode(data) });
    }
  }
  return chunks;
}

function yieldToBrowser() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function parseHistoryChunks(chunks, batchSize = 500) {
  const parsed = [];
  for (const chunk of chunks) {
    const rawHands = splitHandHistories(chunk.text);
    for (let index = 0; index < rawHands.length; index += batchSize) {
      const batch = rawHands.slice(index, index + batchSize);
      parsed.push(...batch.map(parseGgHand));
      await yieldToBrowser();
    }
  }
  return parsed;
}

function fileFromEntry(entry, path = '') {
  return new Promise((resolve, reject) => {
    entry.file((file) => {
      Object.defineProperty(file, 'relativePath', {
        value: `${path}${file.name}`,
        configurable: true
      });
      resolve(file);
    }, reject);
  });
}

function readDirectoryEntries(reader) {
  return new Promise((resolve, reject) => {
    reader.readEntries(resolve, reject);
  });
}

async function filesFromEntry(entry, path = '') {
  if (entry.isFile) return [await fileFromEntry(entry, path)];
  if (!entry.isDirectory) return [];

  const reader = entry.createReader();
  const files = [];
  let entries = await readDirectoryEntries(reader);
  while (entries.length) {
    const nested = await Promise.all(entries.map((item) => filesFromEntry(item, `${path}${entry.name}/`)));
    files.push(...nested.flat());
    entries = await readDirectoryEntries(reader);
  }
  return files;
}

async function filesFromDataTransfer(dataTransfer) {
  const items = Array.from(dataTransfer.items ?? []);
  const entries = items
    .map((item) => (typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null))
    .filter(Boolean);

  if (!entries.length) return Array.from(dataTransfer.files ?? []);

  const files = await Promise.all(entries.map((entry) => filesFromEntry(entry)));
  return files.flat();
}

function handDateValue(hand) {
  const match = String(hand.date ?? '').match(/^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return 0;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  return Date.UTC(year, month - 1, day, hour, minute, second);
}

function sortHandsByTime(hands) {
  return [...hands].sort((a, b) => (
    handDateValue(a) - handDateValue(b)
    || String(a.id).localeCompare(String(b.id))
  ));
}

function rankedPlayers(hands) {
  const counts = new Map();
  const auto = new Map();
  for (const hand of hands) {
    for (const name of hand.players.keys()) counts.set(name, (counts.get(name) ?? 0) + 1);
    for (const name of hand.heroCandidates) auto.set(name, (auto.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count, auto: auto.get(name) ?? 0 }))
    .sort((a, b) => b.auto - a.auto || b.count - a.count || a.name.localeCompare(b.name));
}

function downloadText(filename, content, type = 'text/csv;charset=utf-8') {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function RangeLabView() {
  const [sceneKey, setSceneKey] = useState(sceneOptions[0]?.value ?? 'BTN_open_100bb');
  const [profileKey, setProfileKey] = useState(profileOptions[0]?.value ?? 'tag');
  const [viewMode, setViewMode] = useState('adjusted');
  const [activeCell, setActiveCell] = useState(null);

  const payload = useMemo(
    () => getRangePayload({ sceneKey, profileKey }),
    [sceneKey, profileKey]
  );

  const currentMatrix = viewMode === 'adjusted'
    ? payload?.matrices?.adjusted
    : payload?.matrices?.base;

  return (
    <div className="site">
      <nav className="top-nav">
        <div className="brand">KISHPOKER · Range Lab</div>
        <div className="cta-row">
          <button type="button" className="secondary" onClick={() => window.location.assign('/')}>主页</button>
          <button type="button" className="secondary" onClick={() => window.location.assign('?tool=equity')}>胜率计算</button>
          <button type="button" className="secondary" onClick={() => window.location.assign('?tool=variance')}>波动计算</button>
        </div>
      </nav>

      <section className="range-panel" style={{ marginTop: 0 }}>
        <header>
          <p className="eyebrow">GG Zoom · 100bb</p>
          <h2>Preflop Range Lab</h2>
          <p className="subtext">快速查看 GTO 基准并根据对手画像自动调整</p>
        </header>

        <section className="controls">
          <label>
            <span>场景</span>
            <select value={sceneKey} onChange={(e) => setSceneKey(e.target.value)}>
              {sceneOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>

          <label>
            <span>对手画像</span>
            <select value={profileKey} onChange={(e) => setProfileKey(e.target.value)}>
              {profileOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
        </section>

        {payload?.exists ? (
          <>
            <section className="meta">
              <div>
                <h3>{payload.base.meta.position} · {payload.base.meta.actionTree}</h3>
                <p>{payload.base.meta.game} · {payload.base.meta.stack}</p>
                <p>对手：{payload.profile?.label ?? '未指定'}</p>
              </div>
              <div className="mode-switch">
                <button
                  type="button"
                  className={viewMode === 'base' ? 'active' : ''}
                  onClick={() => setViewMode('base')}
                >纯 GTO</button>
                <button
                  type="button"
                  className={viewMode === 'adjusted' ? 'active' : ''}
                  onClick={() => setViewMode('adjusted')}
                >已调整</button>
              </div>
            </section>

            <section className="matrix-block">
              <RangeMatrix
                matrix={currentMatrix}
                onSelect={(cell) => setActiveCell(cell)}
              />

              {activeCell && (
                <div className="detail">
                  <p>{activeCell.label}</p>
                  <p>{activeCell.action} · {(activeCell.freq * 100).toFixed(0)}%</p>
                </div>
              )}
            </section>

            {payload.matchedRules.length > 0 && (
              <section className="rules">
                <h3>触发的调整</h3>
                {payload.matchedRules.map((rule) => (
                  <article key={rule.id}>
                    <strong>{rule.label}</strong>
                    <p>{rule.note}</p>
                  </article>
                ))}
              </section>
            )}
          </>
        ) : (
          <div className="error">{payload?.message ?? '暂无数据'}</div>
        )}
      </section>
    </div>
  );
}

function EquityView() {
  const createPlayer = (id, label) => ({
    id,
    label,
    mode: 'hand',
    cards: emptyHand(),
    range: {}
  });
  const defaultPlayers = () => [createPlayer('hero', 'Hero'), createPlayer('villain-1', '玩家2')];

  const [players, setPlayers] = useState(() => defaultPlayers());
  const [boardCards, setBoardCards] = useState(() => boardTemplate());
  const [pickerTarget, setPickerTarget] = useState(null);
  const [rangeEditorTarget, setRangeEditorTarget] = useState(null);
  const [result, setResult] = useState(null);
  const [status, setStatus] = useState('idle');
  const counterRef = useRef(2);

  const takenCards = useMemo(() => new Set([
    ...boardCards,
    ...players.flatMap((player) => (player.mode === 'hand' ? player.cards : []))
  ].filter(Boolean)), [boardCards, players]);

  const openRangeEditor = (playerId) => setRangeEditorTarget({ playerId, sessionId: Date.now() });

  const applyRangeToPlayer = (playerId, nextRange) => {
    setPlayers((prev) => prev.map((player) => (
      player.id === playerId
        ? { ...player, range: nextRange }
        : player
    )));
    setResult(null);
    setStatus('idle');
  };

  const setPlayerMode = (playerId, mode) => {
    setPlayers((prev) => prev.map((player) => (
      player.id === playerId
        ? { ...player, mode }
        : player
    )));
    setResult(null);
    setStatus('idle');
  };

  const iterations = 5000;

  const openPicker = (target) => {
    const currentValue = target.type === 'board'
      ? boardCards[target.index]
      : players.find((player) => player.id === target.playerId)?.cards[target.index];
    setPickerTarget({ ...target, currentValue });
  };

  const updatePlayerCard = (playerId, slotIndex, value) => {
    setPlayers((prev) => prev.map((player) => (
      player.id === playerId
        ? { ...player, cards: player.cards.map((card, idx) => (idx === slotIndex ? value : card)) }
        : player
    )));
  };

  const updateBoardCard = (index, value) => {
    setBoardCards((prev) => {
      const next = [...prev];
      next[index] = value;
      return next;
    });
  };

  const handlePick = (card) => {
    if (!pickerTarget) return;
    if (takenCards.has(card) && card !== pickerTarget.currentValue) return;

    if (pickerTarget.type === 'board') {
      updateBoardCard(pickerTarget.index, card);
    } else {
      updatePlayerCard(pickerTarget.playerId, pickerTarget.index, card);
    }
    setPickerTarget(null);
  };

  const clearSlot = (target) => {
    if (target.type === 'board') {
      updateBoardCard(target.index, null);
    } else {
      updatePlayerCard(target.playerId, target.index, null);
    }
    setResult(null);
  };

  const addPlayer = () => {
    if (players.length >= 6) return;
    counterRef.current += 1;
    setPlayers((prev) => ([
      ...prev,
      createPlayer(`villain-${counterRef.current}`, `玩家${prev.length + 1}`)
    ]));
  };

  const removePlayer = (playerId) => {
    if (players.length <= 2) return;
    setPlayers((prev) => prev.filter((player) => player.id !== playerId));
    setResult(null);
  };

  const resetAll = () => {
    counterRef.current = 2;
    setPlayers(defaultPlayers());
    setBoardCards(boardTemplate());
    setResult(null);
    setStatus('idle');
    setPickerTarget(null);
  };

  const runSimulation = () => {
    if (players.length < 2) {
      setStatus('need-players');
      return;
    }
    if (players.some((player) => player.mode === 'hand' && player.cards.filter(Boolean).length !== 2)) {
      setStatus('need-cards');
      return;
    }
    if (players.some((player) => player.mode === 'range' && Object.keys(player.range || {}).length === 0)) {
      setStatus('need-range');
      return;
    }
    setStatus('running');
    setResult(null);
    setTimeout(() => {
      const sim = simulateEquity({
        players: players.map((player, idx) => ({
          id: player.id,
          label: idx === 0 ? 'Hero' : player.label,
          mode: player.mode,
          cards: player.cards,
          range: player.range
        })),
        boardCards,
        iterations
      });
      setResult(sim);
      setStatus(sim.status === 'ok' ? 'done' : sim.status);
    }, 20);
  };

  const heroEquity = result?.players?.[0]?.equity ?? 0;
  const currentRangePlayer = rangeEditorTarget
    ? players.find((player) => player.id === rangeEditorTarget.playerId)
    : null;
  const flopComplete = boardCards.slice(0, 3).every(Boolean);
  const turnComplete = Boolean(boardCards[3]);

  return (
    <div className="site">
      <nav className="top-nav">
        <div className="brand">KISHPOKER · 胜率计算</div>
        <div className="cta-row">
          <button type="button" className="secondary" onClick={() => window.location.assign('/')}>主页</button>
          <button type="button" className="secondary" onClick={() => window.location.assign('?tool=range')}>Range Lab</button>
          <button type="button" className="secondary" onClick={() => window.location.assign('?tool=variance')}>波动计算</button>
        </div>
      </nav>

      <section className="range-panel" style={{ marginTop: 0 }}>
        <header>
          <p className="eyebrow">德州计算器</p>
          <h2>胜率计算工具</h2>
          <p className="subtext">为每位玩家指定手牌，或切换到「范围」用矩阵编辑器点选组合。</p>
        </header>

        {result?.status === 'ok' && (
          <div className="result-stack">
            <div className="hero-summary">
              <p>Hero 胜率</p>
              <strong>{(heroEquity * 100).toFixed(1)}%</strong>
            </div>
            <div className="equity-table">
              {result.players.map((player) => (
                <div key={player.id}>
                  <p>{player.label}</p>
                  <strong>{(player.equity * 100).toFixed(1)}%</strong>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="board-section">
          <h4>公共牌</h4>
          <div className="card-slots board-cards">
            {boardCards.map((card, idx) => {
              const locked = !card && ((idx >= 3 && !flopComplete) || (idx === 4 && !turnComplete));
              const classes = ['card-slot', 'board-slot'];
              if (!card) classes.push('empty');
              if (locked) classes.push('locked');
              const rank = card ? card[0] : '--';
              const suit = card ? card[1] : null;
              if (card && suit) {
                classes.push('filled', `suit-${suit}`);
              }
              return (
                <button
                  key={`board-${idx}`}
                  type="button"
                  className={classes.join(' ')}
                  onClick={() => {
                    if (locked) return;
                    openPicker({ type: 'board', index: idx });
                  }}
                  disabled={locked}
                  title={locked ? (idx >= 3 && !flopComplete ? '请先选好前3张' : '请先选好转牌') : undefined}
                >
                  <span className="card-face">
                    <span className="card-rank">{rank}</span>
                    <span className="card-pip">{suit ? SUIT_ICON[suit] : ''}</span>
                  </span>
                  {card && (
                    <span
                      className="slot-clear"
                      onClick={(e) => {
                        e.stopPropagation();
                        clearSlot({ type: 'board', index: idx });
                      }}
                    >×</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        <div className="players-grid">
          {players.map((player, idx) => {
            const summary = summarizeRange(player.range);
            return (
              <div key={player.id} className="player-card">
                <div className="player-header">
                  <div>
                    <h4>{idx === 0 ? 'Hero' : player.label}</h4>
                    <div className="mode-switch compact">
                      <button
                        type="button"
                        className={player.mode === 'hand' ? 'active' : ''}
                        onClick={() => setPlayerMode(player.id, 'hand')}
                      >手牌</button>
                      <button
                        type="button"
                        className={player.mode === 'range' ? 'active' : ''}
                        onClick={() => setPlayerMode(player.id, 'range')}
                      >范围</button>
                    </div>
                  </div>
                  {idx > 0 && players.length > 2 && (
                    <button type="button" onClick={() => removePlayer(player.id)}>移除</button>
                  )}
                </div>

                {player.mode === 'hand' ? (
                  <div className="card-slots player-hand">
                    {player.cards.map((card, slotIdx) => {
                      const classes = ['card-slot', 'player-slot'];
                      if (!card) {
                        classes.push('empty');
                      } else if (card[1]) {
                        classes.push('filled', `suit-${card[1]}`);
                      }
                      const rank = card ? card[0] : '--';
                      const suitGlyph = card ? SUIT_ICON[card[1]] : '';
                      return (
                        <button
                          key={`${player.id}-${slotIdx}`}
                          type="button"
                          className={classes.join(' ')}
                          onClick={() => openPicker({ type: 'player', playerId: player.id, index: slotIdx })}
                        >
                          <span className="card-face">
                            <span className="card-rank">{rank}</span>
                            <span className="card-pip">{suitGlyph}</span>
                          </span>
                          {card && (
                            <span
                              className="slot-clear"
                              onClick={(e) => {
                                e.stopPropagation();
                                clearSlot({ type: 'player', playerId: player.id, index: slotIdx });
                              }}
                            >×</span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div className="range-summary">
                    <p>
                      {summary.cells > 0
                        ? `覆盖 ${(summary.coverage * 100).toFixed(1)}% · ${summary.cells} 格`
                        : '未选择范围'}
                    </p>
                    <button type="button" onClick={() => openRangeEditor(player.id)}>编辑范围</button>
                  </div>
                )}
              </div>
            );
          })}
          {players.length < 6 && (
            <button type="button" className="add-player" onClick={addPlayer}>+ 添加对手</button>
          )}
        </div>

        <div className="equity-actions">
          <button type="button" className="primary" onClick={runSimulation}>开始计算</button>
          <button type="button" className="secondary" onClick={resetAll}>清空</button>
          <span className="status-text">
            {status === 'running' && '正在模拟...'}
            {status === 'need-cards' && '请先为所有玩家填好两张手牌'}
            {status === 'need-players' && '至少需要 2 位玩家'}
            {status === 'need-range' && '范围模式需要至少选择一个组合'}
            {status === 'range-conflict' && '所选范围互相阻断，无法生成有效组合'}
            {status === 'invalid' && '组合或公共牌冲突，请检查选择'}
            {status === 'done' && `已完成 ${result?.iterations ?? iterations} 次模拟`}
          </span>
        </div>

      </section>

      <CardPickerModal
        open={Boolean(pickerTarget)}
        currentValue={pickerTarget?.currentValue ?? null}
        takenCards={takenCards}
        onClose={() => setPickerTarget(null)}
        onSelect={handlePick}
        title="选择牌"
      />

      <RangeEditor
        key={rangeEditorTarget?.sessionId ?? 'range-editor'}
        open={Boolean(rangeEditorTarget)}
        title={`${currentRangePlayer?.label ?? '玩家'} · 范围`}
        range={currentRangePlayer?.range ?? {}}
        onClose={() => setRangeEditorTarget(null)}
        onChange={(nextRange) => {
          if (rangeEditorTarget?.playerId) {
            applyRangeToPlayer(rangeEditorTarget.playerId, nextRange);
          }
        }}
      />
    </div>
  );
}

function CardPickerModal({ open, onClose, onSelect, takenCards, currentValue, title }) {
  if (!open) return null;
  return (
    <div className="picker-backdrop">
      <div className="picker-panel">
        <div className="picker-head">
          <strong>{title}</strong>
          <button type="button" onClick={onClose}>×</button>
        </div>
        <div className="card-grid modal-grid">
          {PICKER_SUITS.flatMap((suit) => (
            PICKER_RANKS.map((rank) => {
              const card = `${rank}${suit}`;
              const disabled = takenCards.has(card) && card !== currentValue;
              const suitGlyph = SUIT_ICON[suit] ?? '';
              const suitClass = `suit-${suit}`;
              return (
                <button
                  key={card}
                  type="button"
                  className={`card-button ${suitClass} ${disabled ? 'disabled' : ''}`}
                  disabled={disabled}
                  onClick={() => onSelect(card)}
                  aria-label={`${rank}${suit}`}
                >
                  <span className="card-rank">{rank}</span>
                  <span className="card-pip">{suitGlyph}</span>
                </button>
              );
            })
          ))}
        </div>
      </div>
    </div>
  );
}

function VarianceView() {
  const [winrate, setWinrate] = useState(5);
  const [stdev, setStdev] = useState(80);
  const [hands, setHands] = useState(50000);
  const [bankroll, setBankroll] = useState(1000);
  const [bbValue, setBbValue] = useState(10);
  const [currencySymbol, setCurrencySymbol] = useState('¥');

  const parseNumber = (value, fallback = 0) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  const symbol = currencySymbol?.trim() || '¥';

  const analysis = useMemo(() => {
    const safeHands = Math.max(parseNumber(hands, 0), 0);
    const safeWinrate = parseNumber(winrate, 0);
    const safeStd = Math.max(Math.abs(parseNumber(stdev, 0)), 0);
    const safeBankroll = Math.max(parseNumber(bankroll, 0), 0);
    const safeBbValue = Math.max(parseNumber(bbValue, 0), 0);

    const blocks = safeHands / 100;
    const expectedBb = safeWinrate * blocks;
    const sigmaBb = safeStd * Math.sqrt(blocks);
    const expectedCurrency = expectedBb * safeBbValue;
    const sigmaCurrency = sigmaBb * safeBbValue;

    const probabilityDown = sigmaBb > 0
      ? normalCdf(-expectedBb / sigmaBb)
      : expectedBb < 0 ? 1 : 0;

    const ruinProbability = sigmaBb > 0
      ? normalCdf((-safeBankroll - expectedBb) / sigmaBb)
      : expectedBb <= -safeBankroll ? 1 : 0;

    const buildBand = (multiplier) => {
      const lowerBb = expectedBb - multiplier * sigmaBb;
      const upperBb = expectedBb + multiplier * sigmaBb;
      return {
        lowerBb,
        upperBb,
        lowerCurrency: lowerBb * safeBbValue,
        upperCurrency: upperBb * safeBbValue
      };
    };

    const percentiles = PERCENTILE_POINTS.map((row) => {
      const bbPoint = expectedBb + row.z * sigmaBb;
      return {
        ...row,
        bb: bbPoint,
        currency: bbPoint * safeBbValue
      };
    });

    return {
      expectedBb,
      sigmaBb,
      expectedCurrency,
      sigmaCurrency,
      probabilityDown,
      ruinProbability,
      percentiles,
      hands: safeHands,
      winrate: safeWinrate,
      stdev: safeStd,
      bankroll: safeBankroll,
      bbValue: safeBbValue,
      band1: buildBand(1),
      band2: buildBand(2)
    };
  }, [hands, winrate, stdev, bankroll, bbValue]);

  const formatNumber = (value, digits = 0) => {
    if (!Number.isFinite(value)) return '—';
    return value.toLocaleString('en-US', {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits
    });
  };

  const formatBb = (value, digits = 0) => {
    if (!Number.isFinite(value)) return '—';
    const sign = value > 0 ? '+' : value < 0 ? '−' : '';
    const absValue = Math.abs(value);
    const formatted = absValue.toLocaleString('en-US', {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits
    });
    return sign ? `${sign}${formatted} bb` : `0 bb`;
  };

  const formatCurrency = (value, digits = 0, options = {}) => {
    if (!Number.isFinite(value)) return '—';
    const { signed = true } = options;
    const absValue = Math.abs(value);
    const formatted = absValue.toLocaleString('en-US', {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits
    });
    const sign = value > 0 ? (signed ? '+' : '') : value < 0 ? '−' : '';
    return sign ? `${sign}${symbol}${formatted}` : `${symbol}${formatted}`;
  };

  const formatPercent = (value) => {
    if (!Number.isFinite(value)) return '—';
    return `${(value * 100).toFixed(1)}%`;
  };

  const formatRange = (lower, upper, formatter) => `${formatter(lower)} ~ ${formatter(upper)}`;

  return (
    <div className="site">
      <nav className="top-nav">
        <div className="brand">KISHPOKER · 波动计算</div>
        <div className="cta-row">
          <button type="button" className="secondary" onClick={() => window.location.assign('/')}>主页</button>
          <button type="button" className="secondary" onClick={() => window.location.assign('?tool=range')}>Range Lab</button>
          <button type="button" className="secondary" onClick={() => window.location.assign('?tool=equity')}>胜率计算</button>
        </div>
      </nav>

      <section className="range-panel" style={{ marginTop: 0 }}>
        <header>
          <p className="eyebrow">Variance</p>
          <h2>德州扑克波动 & 下行风险</h2>
          <p className="subtext">参考 Primedope 计算逻辑，利用胜率与标准差估算指定手数下的收益分布与破产概率。</p>
        </header>

        <div className="controls variance-inputs">
          <label>
            <span>胜率 (bb / 100)</span>
            <input type="number" step="0.1" value={winrate} onChange={(e) => setWinrate(parseNumber(e.target.value, 0))} />
            <span className="input-note">常见范围 2~8 bb/100</span>
          </label>
          <label>
            <span>标准差 (bb / 100)</span>
            <input type="number" step="1" value={stdev} onChange={(e) => setStdev(parseNumber(e.target.value, 0))} />
            <span className="input-note">现金桌常见 70~120 bb/100</span>
          </label>
          <label>
            <span>样本手数</span>
            <input type="number" step="100" value={hands} onChange={(e) => setHands(parseNumber(e.target.value, 0))} />
            <span className="input-note">以 100 手牌为一个区块</span>
          </label>
          <label>
            <span>银行滚仓 (bb)</span>
            <input type="number" step="10" value={bankroll} onChange={(e) => setBankroll(parseNumber(e.target.value, 0))} />
            <span className="input-note">用大盲衡量的可承受下行</span>
          </label>
          <label>
            <span>大盲面值</span>
            <input type="number" step="1" value={bbValue} onChange={(e) => setBbValue(parseNumber(e.target.value, 0))} />
            <span className="input-note">换算货币：单个大盲的金额</span>
          </label>
          <label>
            <span>货币符号</span>
            <input type="text" maxLength={3} value={currencySymbol} onChange={(e) => setCurrencySymbol(e.target.value)} />
            <span className="input-note">例如 ¥ / ￥ / $</span>
          </label>
        </div>

        <section className="variance-summary">
          <div>
            <p>样本</p>
            <strong>{formatNumber(analysis.hands, 0)} 手牌</strong>
            <span className="input-note">胜率 {formatNumber(analysis.winrate, 1)} · σ {formatNumber(analysis.stdev, 0)} bb/100</span>
          </div>
          <div>
            <p>期望收益</p>
            <strong>{formatBb(analysis.expectedBb)}</strong>
            <span className="input-note">≈ {formatCurrency(analysis.expectedCurrency)}</span>
          </div>
          <div>
            <p>亏损概率</p>
            <strong>{formatPercent(analysis.probabilityDown)}</strong>
            <span className="input-note">结果 &lt; 0 bb</span>
          </div>
        </section>

        <section className="variance-grid">
          <article className="variance-card">
            <p>1σ 区间</p>
            <strong>{formatRange(analysis.band1.lowerBb, analysis.band1.upperBb, formatBb)}</strong>
            <span>≈ {formatRange(analysis.band1.lowerCurrency, analysis.band1.upperCurrency, formatCurrency)}</span>
          </article>
          <article className="variance-card">
            <p>2σ 区间</p>
            <strong>{formatRange(analysis.band2.lowerBb, analysis.band2.upperBb, formatBb)}</strong>
            <span>≈ {formatRange(analysis.band2.lowerCurrency, analysis.band2.upperCurrency, formatCurrency)}</span>
          </article>
          <article className="variance-card">
            <p>破产概率</p>
            <strong>{formatPercent(analysis.ruinProbability)}</strong>
            <span>结果 ≤ -{formatNumber(analysis.bankroll, 0)} bb</span>
          </article>
          <article className="variance-card">
            <p>货币标准差</p>
            <strong>±{formatCurrency(analysis.sigmaCurrency, 0, { signed: false })}</strong>
            <span>每个 σ ≈ {formatBb(analysis.sigmaBb)}</span>
          </article>
        </section>

        <section className="variance-table">
          <h4>分位数估算</h4>
          <table>
            <thead>
              <tr>
                <th>分位</th>
                <th>bb</th>
                <th>货币</th>
              </tr>
            </thead>
            <tbody>
              {analysis.percentiles.map((row) => (
                <tr key={row.key}>
                  <td>{row.label}</td>
                  <td>{formatBb(row.bb)}</td>
                  <td>{formatCurrency(row.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="variance-footnote">假设收益满足近似正态分布（Primedope 同款模型）。</p>
        </section>
      </section>
    </div>
  );
}

function formatNumber(value, digits = 1) {
  if (!Number.isFinite(value)) return '-';
  return value.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
}

function formatMoney(value, digits = 2) {
  if (!Number.isFinite(value)) return '-';
  return value.toFixed(digits);
}

function formatPercent(value, digits = 1) {
  if (!Number.isFinite(value)) return '-';
  return `${formatNumber(value, digits)}%`;
}

function statTone(value) {
  if (!Number.isFinite(value) || value === 0) return '';
  return value >= 0 ? 'win' : 'loss';
}

function wwsfTone(value) {
  if (!Number.isFinite(value)) return '';
  if (value > 52) return 'win';
  if (value < 48) return 'loss';
  return '';
}

function stakeLabel(stakes) {
  const bb = Number(String(stakes).split('/')[1]?.replace('$', ''));
  return bb ? `NL${Math.round(bb * 100)}` : stakes;
}

function niceStep(value) {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exponent = Math.floor(Math.log10(value));
  const base = 10 ** exponent;
  const fraction = value / base;
  if (fraction <= 1) return base;
  if (fraction <= 2) return 2 * base;
  if (fraction <= 5) return 5 * base;
  return 10 * base;
}

function handTickStep(hands) {
  if (hands <= 1000) return 100;
  if (hands <= 10000) return 1000;
  if (hands <= 100000) return 10000;
  return niceStep(hands / 8);
}

function buildRangeTicks(minValue, maxValue, step) {
  const start = Math.floor(minValue / step) * step;
  const end = Math.ceil(maxValue / step) * step;
  const ticks = [];
  for (let tick = start; tick <= end + step * 0.001; tick += step) {
    ticks.push(Math.abs(tick) < step * 0.001 ? 0 : tick);
  }
  return ticks;
}

const HISTORY_CURVE_LINES = [
  { key: 'beforeRakeBB', label: '水前实际盈利', color: '#22c55e' },
  { key: 'evBB', label: '水前 EV', color: '#facc15' },
  { key: 'profitBB', label: '水后盈利', color: '#a78bfa' },
  { key: 'nonShowdownBB', label: '非摊牌', color: '#ef4444' },
  { key: 'showdownBB', label: '摊牌', color: '#38bdf8' }
];
const DEFAULT_VISIBLE_CURVE_LINES = ['beforeRakeBB', 'evBB', 'profitBB'];
const MAX_RENDERED_CURVE_POINTS = 1800;

function sampleCurveData(data, maxPoints = MAX_RENDERED_CURVE_POINTS) {
  if (data.length <= maxPoints) return data;
  const step = Math.ceil((data.length - 1) / (maxPoints - 1));
  const sampled = [];
  for (let index = 0; index < data.length; index += step) {
    sampled.push(data[index]);
  }
  const last = data[data.length - 1];
  if (sampled[sampled.length - 1] !== last) sampled.push(last);
  return sampled;
}

function curveValueRange(data, lines) {
  let min = 0;
  let max = 0;
  for (const point of data) {
    for (const line of lines) {
      const value = point[line.key] ?? 0;
      if (value < min) min = value;
      if (value > max) max = value;
    }
  }
  return { min, max };
}

function HistoryCurve({ data = [] }) {
  const [hoveredPoint, setHoveredPoint] = useState(null);
  const [visibleLineKeys, setVisibleLineKeys] = useState(() => new Set(DEFAULT_VISIBLE_CURVE_LINES));
  const sampledData = useMemo(() => sampleCurveData(data), [data]);
  if (data.length < 2) {
    return <div className="history-empty-chart">上传牌谱后生成资金曲线</div>;
  }
  const width = 760;
  const height = 300;
  const padLeft = 46;
  const padRight = 126;
  const padTop = 24;
  const padBottom = 48;
  const visibleLines = HISTORY_CURVE_LINES.filter((line) => visibleLineKeys.has(line.key));
  const { min: rawMinY, max: rawMaxY } = curveValueRange(data, visibleLines);
  const yStep = niceStep(Math.max(1, rawMaxY - rawMinY) / 4);
  const minY = Math.floor(rawMinY / yStep) * yStep;
  const maxY = Math.max(yStep, Math.ceil(rawMaxY / yStep) * yStep);
  const span = maxY - minY || 1;
  const x = (index) => padLeft + (index / (data.length - 1)) * (width - padLeft - padRight);
  const pointX = (point) => x(Math.max(0, (point.hand ?? 1) - 1));
  const y = (value) => height - padBottom - ((value - minY) / span) * (height - padTop - padBottom);
  const zeroY = y(0);
  const hands = data.length;
  const xStep = handTickStep(hands);
  const xTicks = [0];
  for (let tick = xStep; tick < hands; tick += xStep) xTicks.push(tick);
  const yTicks = buildRangeTicks(minY, maxY, yStep).reverse();
  const hoverIndex = hoveredPoint?.index ?? null;
  const hoverData = hoverIndex == null ? null : data[hoverIndex];

  const toggleLine = (key) => {
    setVisibleLineKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        if (next.size === 1) return current;
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const updateHover = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const svgX = ((event.clientX - rect.left) / rect.width) * width;
    const rawIndex = ((svgX - padLeft) / (width - padLeft - padRight)) * (hands - 1);
    const index = Math.max(0, Math.min(hands - 1, Math.round(rawIndex)));
    setHoveredPoint({
      index,
      clientX: event.clientX,
      clientY: event.clientY
    });
  };

  return (
    <div className="history-curve-wrap">
      <svg
        className="history-curve"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="资金曲线"
        onMouseMove={updateHover}
        onMouseLeave={() => setHoveredPoint(null)}
      >
        {yTicks.map((tick) => (
          <g key={tick.toFixed(3)}>
            <line x1={padLeft} y1={y(tick)} x2={width - padRight} y2={y(tick)} className="history-grid-line" />
            <text x={padLeft - 8} y={y(tick) + 4} textAnchor="end" className="history-axis-label">
              {formatNumber(tick, 0)}
            </text>
          </g>
        ))}
        {xTicks.map((tick) => (
          <text key={tick} x={x(tick === 0 ? 0 : tick - 1)} y={height - 14} textAnchor="middle" className="history-axis-label">
            {tick}
          </text>
        ))}
        <line x1={padLeft} y1={zeroY} x2={width - padRight} y2={zeroY} className="history-zero-line" />
        {visibleLines.map((line, lineIndex) => {
          const path = sampledData
            .map((point, index) => `${index === 0 ? 'M' : 'L'} ${pointX(point).toFixed(1)} ${y(point[line.key] ?? 0).toFixed(1)}`)
            .join(' ');
          const last = data[data.length - 1]?.[line.key] ?? 0;
          const bbPer100 = hands ? (last / hands) * 100 : 0;
          const centerOffset = (visibleLines.length - 1) / 2;
          const labelY = Math.min(height - 42, Math.max(18, y(last) + (lineIndex - centerOffset) * 11));
          return (
            <g key={line.key}>
              <path d={path} className="history-profit-line" style={{ stroke: line.color }} />
              <circle cx={x(data.length - 1)} cy={y(last)} r="2.8" className="history-profit-dot" style={{ fill: line.color }} />
              <text
                x={width - padRight + 8}
                y={labelY}
                className="history-line-end-label"
                style={{ fill: line.color }}
              >
                {formatNumber(bbPer100, 2)} BB/100
              </text>
            </g>
          );
        })}
        {hoverData && (
          <g>
            <line x1={x(hoverIndex)} y1={padTop} x2={x(hoverIndex)} y2={height - padBottom} className="history-hover-line" />
            {visibleLines.map((line) => (
              <circle
                key={line.key}
                cx={x(hoverIndex)}
                cy={y(hoverData[line.key] ?? 0)}
                r="3.2"
                className="history-hover-dot"
                style={{ fill: line.color }}
              />
            ))}
          </g>
        )}
        <text x={padLeft} y={13} className="history-axis-title">盈利 (BB)</text>
        <text x={(width + padLeft - padRight) / 2} y={height - 2} textAnchor="middle" className="history-axis-title">手数</text>
      </svg>
      <div className="history-curve-footer">
        <div className="history-curve-legend">
          {HISTORY_CURVE_LINES.map((line) => (
            <button
              key={line.key}
              type="button"
              className={visibleLineKeys.has(line.key) ? 'active' : ''}
              onClick={() => toggleLine(line.key)}
              aria-pressed={visibleLineKeys.has(line.key)}
            >
              <i style={{ background: line.color }} />{line.label}
            </button>
          ))}
        </div>
      </div>
      {hoverData && (
        <div
          className="history-curve-tooltip"
          style={{ left: hoveredPoint.clientX + 12, top: hoveredPoint.clientY + 12 }}
        >
          <strong>第 {hoverData.hand.toLocaleString()} 手</strong>
          {visibleLines.map((line) => {
            const total = hoverData[line.key] ?? 0;
            const bbPer100 = hoverData.hand ? (total / hoverData.hand) * 100 : 0;
            return (
              <span key={line.key} style={{ color: line.color }}>
                {line.label}: {formatNumber(total, 1)} BB / {formatNumber(bbPer100, 2)} bb/100
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

function HistoryStatCard({ label, value, tone, size }) {
  const className = [
    'history-stat-card',
    tone ? `history-stat-card--${tone}` : '',
    size ? `history-stat-card--${size}` : ''
  ].filter(Boolean).join(' ');
  return (
    <article className={className}>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function HistoryFilterGroup({ label, options, value, onChange }) {
  return (
    <div className="history-filter-group">
      <span>{label}</span>
      <div>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            className={value === option.value ? 'active' : ''}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function HistoryDetailSection({ title, items }) {
  return (
    <section className="history-detail-section">
      <h3>{title}</h3>
      <div className="history-detail-grid">
        {items.map((item) => (
          <article key={`${title}-${item.label}`} className="history-detail-card">
            <strong className={item.tone ? `history-detail-card--${item.tone}` : ''}>{item.value}</strong>
            <span>{item.label}</span>
          </article>
        ))}
      </div>
    </section>
  );
}

const HISTORY_PAGE_SIZES = [10, 25, 50, 100];
const FILTER_RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const STARTING_HAND_RANKS = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];
const HISTORY_SORT_COLUMNS = [
  { key: 'date', label: '时间' },
  { key: 'id', label: '牌局号码' },
  { key: 'cards', label: '底牌' },
  { key: 'handValue', label: '牌局价值' },
  { key: 'winner', label: '赢家' },
  { key: 'pot', label: '底池' },
  { key: 'profit', label: '输赢' }
];

function PlayingCards({ cards = [], compact = false, hidden = false }) {
  if (!cards.length && !hidden) return <span className="history-card-empty">—</span>;
  const visibleCards = hidden ? ['back', 'back'] : cards;
  return (
    <span className={`history-playing-cards${compact ? ' history-playing-cards--compact' : ''}`}>
      {visibleCards.map((card, index) => {
        if (card === 'back') return <i key={`back-${index}`} className="history-playing-card history-playing-card--back" />;
        const rank = card[0] === 'T' ? '10' : card[0];
        const suit = card[1];
        return (
          <i key={`${card}-${index}`} className={`history-playing-card history-playing-card--${suit}`}>
            <b>{rank}</b><span>{SUIT_ICON[suit]}</span>
          </i>
        );
      })}
    </span>
  );
}

function normalizedRanks(cards = []) {
  const order = '23456789TJQKA';
  return cards.map((card) => card[0]).sort((a, b) => order.indexOf(b) - order.indexOf(a)).join('');
}

function matchesHoleFilter(cards, filter) {
  const selectedRanks = filter.ranks.filter(Boolean);
  if (!selectedRanks.length && !filter.suitedOnly) return true;
  if (cards.length !== 2) return false;
  const cardRanks = cards.map((card) => card[0]);
  const [first, second] = filter.ranks;
  const rankMatch = first && second
    ? (cardRanks[0] === first && cardRanks[1] === second) || (cardRanks[0] === second && cardRanks[1] === first)
    : !first || cardRanks.includes(first)
      ? !second || cardRanks.includes(second)
      : false;
  const suitedMatch = !filter.suitedOnly || cards[0][1] === cards[1][1];
  return rankMatch && suitedMatch;
}

function matchesBoardFilter(board, filter) {
  const flopFilters = filter.slice(0, 3).filter(Boolean);
  const flop = board.slice(0, 3);
  if (!flopFilters.every((card) => flop.includes(card))) return false;
  if (filter[3] && board[3] !== filter[3]) return false;
  if (filter[4] && board[4] !== filter[4]) return false;
  return true;
}

function historyAmount(value, bb, unit, signed = false) {
  const amount = unit === 'bb' ? value / bb : value;
  const prefix = signed && amount > 0 ? '+' : '';
  return `${prefix}${formatNumber(amount, 2)} ${unit === 'bb' ? 'BB' : '$'}`;
}

function historyWinnerLabel(winners = []) {
  return winners.map((winner) => winner.name).join('、') || '—';
}

function startingHandKey(cards = []) {
  if (cards.length !== 2) return '';
  const [firstCard, secondCard] = cards;
  const firstRank = firstCard?.[0];
  const secondRank = secondCard?.[0];
  const firstIndex = STARTING_HAND_RANKS.indexOf(firstRank);
  const secondIndex = STARTING_HAND_RANKS.indexOf(secondRank);
  if (firstIndex < 0 || secondIndex < 0) return '';
  if (firstRank === secondRank) return `${firstRank}${secondRank}`;
  const [highRank, lowRank] = firstIndex < secondIndex
    ? [firstRank, secondRank]
    : [secondRank, firstRank];
  return `${highRank}${lowRank}${firstCard[1] === secondCard[1] ? 's' : 'o'}`;
}

function matrixHandKey(rowIndex, columnIndex) {
  const rowRank = STARTING_HAND_RANKS[rowIndex];
  const columnRank = STARTING_HAND_RANKS[columnIndex];
  if (rowIndex === columnIndex) return `${rowRank}${columnRank}`;
  return rowIndex < columnIndex
    ? `${rowRank}${columnRank}s`
    : `${columnRank}${rowRank}o`;
}

function matrixAmount(value, unit) {
  if (!Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  const digits = unit === 'bb' ? 1 : 2;
  const amount = formatNumber(Math.abs(value), digits);
  return unit === 'bb' ? `${sign}${amount} BB` : `${sign}$${amount}`;
}

function HoleCardReport({ results }) {
  const [unit, setUnit] = useState('bb');
  const statsByHand = useMemo(() => {
    const grouped = new Map();
    results.forEach((result) => {
      const key = startingHandKey(result.cards);
      if (!key) return;
      const current = grouped.get(key) ?? { hands: 0, profit: 0, profitBB: 0 };
      current.hands += 1;
      current.profit += result.profit;
      current.profitBB += result.profitBB;
      grouped.set(key, current);
    });
    return grouped;
  }, [results]);
  const cells = useMemo(() => STARTING_HAND_RANKS.flatMap((_, rowIndex) => (
    STARTING_HAND_RANKS.map((__, columnIndex) => {
      const key = matrixHandKey(rowIndex, columnIndex);
      return { key, rowIndex, columnIndex, stats: statsByHand.get(key) };
    })
  )), [statsByHand]);
  const maxAbsoluteValue = useMemo(() => Math.max(0, ...cells.map(({ stats }) => (
    Math.abs(unit === 'bb' ? stats?.profitBB ?? 0 : stats?.profit ?? 0)
  ))), [cells, unit]);
  const totalValue = results.reduce((sum, result) => sum + (unit === 'bb' ? result.profitBB : result.profit), 0);

  return (
    <section className="hole-card-report">
      <header className="hole-card-report-head">
        <div>
          <span>底牌分析</span>
          <strong>169 种起手牌盈亏</strong>
          <p>按当前级别与位置筛选统计，每格显示累计输赢、该牌型百手输赢和样本数。</p>
        </div>
        <div className="hole-card-report-actions">
          <div className="history-unit-toggle" aria-label="底牌盈亏单位">
            <button type="button" aria-pressed={unit === 'bb'} className={unit === 'bb' ? 'active' : ''} onClick={() => setUnit('bb')}>BB</button>
            <button type="button" aria-pressed={unit === 'money'} className={unit === 'money' ? 'active' : ''} onClick={() => setUnit('money')}>$</button>
          </div>
          <strong className={totalValue > 0 ? 'win' : totalValue < 0 ? 'loss' : ''}>{matrixAmount(totalValue, unit)}</strong>
          <span>{results.length.toLocaleString()} 手牌 · {statsByHand.size} 种底牌</span>
        </div>
      </header>

      <div className="hole-card-report-legend" aria-label="底牌盈亏图例">
        <span><i className="win" />盈利</span>
        <span><i className="neutral" />持平</span>
        <span><i className="loss" />亏损</span>
        <span><i className="empty" />无样本</span>
        <em>右上：同花 · 左下：非同花 · 对角线：对子</em>
      </div>

      <div className="hole-card-matrix-scroll">
        <div className="hole-card-matrix" role="grid" aria-label="起手牌盈亏矩阵">
          {STARTING_HAND_RANKS.map((rank, rowIndex) => (
            <div className="hole-card-matrix-row" role="row" key={rank}>
              {cells.slice(rowIndex * STARTING_HAND_RANKS.length, (rowIndex + 1) * STARTING_HAND_RANKS.length).map(({ key, columnIndex, stats }) => {
                const value = unit === 'bb' ? stats?.profitBB : stats?.profit;
                const perHundred = stats ? (value / stats.hands) * 100 : null;
                const tone = !stats ? 'empty' : value > 0 ? 'win' : value < 0 ? 'loss' : 'neutral';
                const strength = stats && maxAbsoluteValue
                  ? 0.34 + (Math.sqrt(Math.abs(value) / maxAbsoluteValue) * 0.5)
                  : 0;
                const type = rowIndex === columnIndex ? 'pair' : rowIndex < columnIndex ? 'suited' : 'offsuit';
                return (
                  <div
                    key={key}
                    role="gridcell"
                    className={`hole-card-matrix-cell hole-card-matrix-cell--${tone} hole-card-matrix-cell--${type}`}
                    style={{ '--hole-card-strength': strength }}
                    aria-label={`${key}，${stats ? `${stats.hands} 手牌，累计 ${matrixAmount(value, unit)}，百手 ${matrixAmount(perHundred, unit)}` : '无样本'}`}
                  >
                    <b>{key}</b>
                    <strong>{stats ? matrixAmount(value, unit) : '—'}</strong>
                    <span>{stats ? `百手 ${matrixAmount(perHundred, unit)}` : '百手 —'}</span>
                    <small>{stats ? `${stats.hands.toLocaleString()} 手` : '无样本'}</small>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function actionLabel(action) {
  const amount = action.amount ? ` $${formatNumber(action.amount, 2)}` : '';
  const labels = {
    post: '下盲注', fold: '弃牌', check: '过牌', call: '跟注', bet: '下注', raise: '加注',
    return: '退回', collect: '赢得底池'
  };
  return `${labels[action.type] ?? action.text}${amount}`;
}

function replayStartingStep(actions) {
  let step = 0;
  while (step < actions.length && actions[step].type === 'post') step += 1;
  return step;
}

const REPLAY_INVESTMENT_LABELS = {
  post: '盲注',
  call: '跟注',
  bet: '下注',
  raise: '加注'
};

function isReplayInvestment(action) {
  return Boolean(action?.amount > 0 && REPLAY_INVESTMENT_LABELS[action.type]);
}

function buildReplayState(actions, step) {
  const streetContributions = new Map();
  const stackChanges = new Map();
  const foldedPlayers = new Set();
  let street = 'preflop';
  let pot = 0;

  for (const action of actions.slice(0, step)) {
    if (action.street !== street) {
      street = action.street;
      streetContributions.clear();
    }
    const currentStackChange = stackChanges.get(action.player) ?? 0;
    if (['post', 'call', 'bet', 'raise'].includes(action.type)) {
      streetContributions.set(action.player, (streetContributions.get(action.player) ?? 0) + action.amount);
      stackChanges.set(action.player, currentStackChange - action.amount);
    } else if (action.type === 'return') {
      streetContributions.set(action.player, Math.max(0, (streetContributions.get(action.player) ?? 0) - action.amount));
      stackChanges.set(action.player, currentStackChange + action.amount);
    } else if (action.type === 'collect') {
      stackChanges.set(action.player, currentStackChange + action.amount);
    } else if (action.type === 'fold') {
      foldedPlayers.add(action.player);
    }
    pot = action.potAfter ?? pot;
  }

  return { street, pot, streetContributions, stackChanges, foldedPlayers };
}

function replayPosition(index, count, radiusX, radiusY, startAngle = -90) {
  const angle = (startAngle + (360 / Math.max(1, count)) * index) * (Math.PI / 180);
  return {
    left: 50 + Math.cos(angle) * radiusX,
    top: 50 + Math.sin(angle) * radiusY
  };
}

function ReplayChipStack({ compact = false }) {
  return (
    <i className={`history-chip-stack${compact ? ' history-chip-stack--compact' : ''}`} aria-hidden="true">
      <span /><span /><span />
    </i>
  );
}

const HAND_DETAIL_STREETS = [
  { key: 'blinds', label: '盲注（底注）' },
  { key: 'preflop', label: '翻牌前' },
  { key: 'flop', label: '翻牌' },
  { key: 'turn', label: '转牌' },
  { key: 'river', label: '河牌' }
];

function handDetailAmount(value, bb, unit) {
  if (!Number.isFinite(value)) return '—';
  const amount = unit === 'bb' ? value / bb : value;
  return unit === 'bb' ? `${formatNumber(amount, 2)} BB` : `$${formatNumber(amount, 2)}`;
}

function handDetailRaiseTarget(action) {
  const target = action.text?.match(/\bto \$(-?[\d,]+(?:\.\d+)?)/)?.[1];
  return target ? Number(target.replaceAll(',', '')) : null;
}

function handDetailActionLabel(action, hand, unit, position = '') {
  const labels = {
    fold: '弃牌', check: '过牌', call: '跟注', bet: '下注', raise: '加注',
    return: '退回未跟注', collect: '赢得底池'
  };
  if (action.type === 'post') {
    const postLabel = /ante/i.test(action.text)
      ? '底注'
      : /straddle/i.test(action.text)
        ? 'Straddle'
        : `${position ? `${position} ` : ''}盲注`;
    return `${postLabel} ${handDetailAmount(action.amount, hand.bb, unit)}`;
  }
  if (action.type === 'raise') {
    const target = handDetailRaiseTarget(action);
    return target
      ? `加注至 ${handDetailAmount(target, hand.bb, unit)}`
      : `加注 ${handDetailAmount(action.amount, hand.bb, unit)}`;
  }
  const label = labels[action.type] ?? action.text;
  return action.amount > 0 ? `${label} ${handDetailAmount(action.amount, hand.bb, unit)}` : label;
}

function buildHandDetailStreets(actions, board) {
  const grouped = new Map(HAND_DETAIL_STREETS.map(({ key }) => [key, []]));
  const showdownActions = [];
  let lastPlayedStreet = 'preflop';

  actions.forEach((action) => {
    if (action.street === 'showdown') {
      showdownActions.push(action);
      return;
    }
    const streetKey = action.street === 'preflop' && action.type === 'post' ? 'blinds' : action.street;
    if (!grouped.has(streetKey)) return;
    grouped.get(streetKey).push(action);
    if (streetKey !== 'blinds') lastPlayedStreet = streetKey;
  });
  const resultStreet = board.length >= 5 ? 'river' : board.length >= 4 ? 'turn' : board.length >= 3 ? 'flop' : lastPlayedStreet;
  grouped.get(resultStreet)?.push(...showdownActions);

  let carriedPot = 0;
  return HAND_DETAIL_STREETS.map((street) => {
    const streetActions = grouped.get(street.key) ?? [];
    const startingPot = carriedPot;
    if (streetActions.length) carriedPot = streetActions.at(-1).potAfter ?? carriedPot;
    const cards = street.key === 'flop'
      ? board.slice(0, 3)
      : street.key === 'turn'
        ? board.slice(3, 4)
        : street.key === 'river'
          ? board.slice(4, 5)
          : [];
    return { ...street, actions: streetActions, pot: street.key === 'blinds' ? carriedPot : startingPot, cards };
  });
}

function HistoryHandDetail({ hand, hero, initialUnit, onClose, onReplay }) {
  const [unit, setUnit] = useState(initialUnit);
  const stageScrollRef = useRef(null);
  const actions = useMemo(() => hand.actions ?? [], [hand.actions]);
  const finalState = useMemo(() => buildReplayState(actions, actions.length), [actions]);
  const streetColumns = useMemo(() => buildHandDetailStreets(actions, hand.board ?? []), [actions, hand.board]);
  const winners = useMemo(() => new Map(hand.winners.map((winner) => [winner.name, winner.amount])), [hand.winners]);
  const playerList = useMemo(() => {
    const bySeat = [...hand.players.entries()].sort((a, b) => a[1].seat - b[1].seat);
    const heroIndex = bySeat.findIndex(([name]) => name === hero);
    return heroIndex > 0 ? [...bySeat.slice(heroIndex), ...bySeat.slice(0, heroIndex)] : bySeat;
  }, [hand.players, hero]);
  const heroCards = hand.holeCards.get(hero) ?? [];
  const totalPot = hand.totalPot || finalState.pot;

  useEffect(() => {
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  useEffect(() => {
    const centerStage = () => {
      const stage = stageScrollRef.current;
      if (stage) stage.scrollLeft = Math.max(0, (stage.scrollWidth - stage.clientWidth) / 2);
    };
    const frame = window.requestAnimationFrame(centerStage);
    window.addEventListener('resize', centerStage);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', centerStage);
    };
  }, []);

  return (
    <div className="history-replay-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="history-hand-detail" role="dialog" aria-modal="true" aria-label={`牌局 ${hand.id} 牌谱详情`}>
        <header>
          <div className="history-hand-detail-title">
            <span>牌谱详情</span>
            <strong>{hand.stakes} · #{hand.id}</strong>
            <small>{hand.date}</small>
          </div>
          <div className="history-hand-detail-toolbar">
            <div className="history-unit-toggle" aria-label="牌谱金额单位">
              <button type="button" aria-pressed={unit === 'bb'} className={unit === 'bb' ? 'active' : ''} onClick={() => setUnit('bb')}>BB</button>
              <button type="button" aria-pressed={unit === 'money'} className={unit === 'money' ? 'active' : ''} onClick={() => setUnit('money')}>$</button>
            </div>
            <button type="button" className="history-hand-detail-replay" onClick={onReplay}>▶ 播放此手</button>
            <button type="button" className="history-replay-close" onClick={onClose} aria-label="关闭">×</button>
          </div>
        </header>

        <div className="history-hand-detail-body">
          <div className="history-hand-detail-stage-scroll" ref={stageScrollRef}>
            <div className="history-hand-detail-stage">
              <div className="history-hand-detail-table">
                <div className="history-hand-detail-board">
                  <small>最终牌面</small>
                  <PlayingCards cards={hand.board} />
                  <strong><ReplayChipStack compact />底池 {handDetailAmount(totalPot, hand.bb, unit)}</strong>
                  {!!heroCards.length && <em>{evaluateHandValue([...heroCards, ...hand.board])}</em>}
                </div>
                {playerList.map(([name, player], index) => {
                  const position = replayPosition(index, playerList.length, 43, 46, 90);
                  const knownCards = hand.holeCards.get(name) ?? [];
                  const finalStack = Math.max(0, player.stack + (finalState.stackChanges.get(name) ?? 0));
                  const folded = finalState.foldedPlayers.has(name);
                  const won = winners.get(name) ?? 0;
                  return (
                    <div
                      key={name}
                      className={`history-hand-detail-seat${name === hero ? ' hero' : ''}${won > 0 ? ' winner' : ''}${folded ? ' folded' : ''}`}
                      style={{ left: `${position.left}%`, top: `${position.top}%` }}
                    >
                      <div className="history-seat-cards">
                        {knownCards.length ? <PlayingCards cards={knownCards} compact /> : <PlayingCards hidden compact />}
                      </div>
                      <strong>{name}</strong>
                      <span>{player.position} · {handDetailAmount(finalStack, hand.bb, unit)}</span>
                      {won > 0 && <i>赢得 {handDetailAmount(won, hand.bb, unit)}</i>}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          <section className="history-hand-detail-timeline">
            <header>
              <div><span>完整行动</span><strong>按牌局街道展开</strong></div>
              <small>加注显示目标额；“行动后底池”为该动作完成后的底池。</small>
            </header>
            <div className="history-hand-detail-timeline-scroll">
              <div className="history-hand-detail-timeline-grid">
                {streetColumns.map((street) => (
                  <section className="history-hand-detail-street" key={street.key}>
                    <header>
                      <div><span>{street.label}</span><strong>底池 {handDetailAmount(street.pot, hand.bb, unit)}</strong></div>
                      {street.cards.length ? <PlayingCards cards={street.cards} compact /> : <small>{street.key === 'blinds' ? '强制投入' : '起手牌行动'}</small>}
                    </header>
                    <div className="history-hand-detail-actions">
                      {street.actions.map((action, index) => {
                        const player = hand.players.get(action.player);
                        const shownCards = action.type === 'collect' ? hand.holeCards.get(action.player) ?? [] : [];
                        return (
                          <article
                            key={`${street.key}-${index}-${action.player}`}
                            className={`history-hand-detail-action history-hand-detail-action--${action.type}`}
                            title={action.text}
                          >
                            <header>
                              <i>{action.player.slice(0, 1).toUpperCase()}</i>
                              <div><strong>{action.player}</strong><span>{player?.position || '—'}</span></div>
                            </header>
                            <p>{handDetailActionLabel(action, hand, unit, player?.position)}</p>
                            <small>行动后底池 {handDetailAmount(action.potAfter, hand.bb, unit)}</small>
                            {!!shownCards.length && (
                              <div className="history-hand-detail-result">
                                <PlayingCards cards={shownCards} compact />
                                <strong>{evaluateHandValue([...shownCards, ...hand.board])}</strong>
                              </div>
                            )}
                          </article>
                        );
                      })}
                      {!street.actions.length && <p className="history-hand-detail-empty">本街无行动</p>}
                    </div>
                  </section>
                ))}
              </div>
            </div>
          </section>
        </div>
      </section>
    </div>
  );
}

function HandReplay({ hand, hero, onClose }) {
  const actions = useMemo(() => hand.actions ?? [], [hand.actions]);
  const initialStep = replayStartingStep(actions);
  const [step, setStep] = useState(() => initialStep);
  const [playing, setPlaying] = useState(false);
  const replayState = useMemo(() => buildReplayState(actions, step), [actions, step]);
  const currentAction = step > 0 ? actions[step - 1] : null;
  const street = replayState.street;
  const boardCount = street === 'flop' ? 3 : street === 'turn' ? 4 : ['river', 'showdown'].includes(street) ? 5 : 0;
  const visibleBoard = hand.board.slice(0, boardCount);
  const playerList = [...hand.players.entries()].sort((a, b) => a[1].seat - b[1].seat);
  const showdown = street === 'showdown';

  useEffect(() => {
    if (!playing || step >= actions.length) return undefined;
    const timer = window.setTimeout(() => setStep((value) => {
      const next = Math.min(actions.length, value + 1);
      if (next >= actions.length) setPlaying(false);
      return next;
    }), 850);
    return () => window.clearTimeout(timer);
  }, [actions.length, playing, step]);

  useEffect(() => {
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  return (
    <div className="history-replay-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="history-replay" role="dialog" aria-modal="true" aria-label={`牌局 ${hand.id} 重播`}>
        <header>
          <div><span>牌谱播放器</span><strong>#{hand.id}</strong></div>
          <button type="button" className="history-replay-close" onClick={onClose} aria-label="关闭">×</button>
        </header>
        <div className="history-replay-layout">
          <div className="history-replay-table-wrap">
            <div className="history-poker-table">
              <div className="history-table-center">
                <small>{street === 'preflop' ? '翻牌前' : street === 'showdown' ? '摊牌' : street.toUpperCase()}</small>
                <PlayingCards cards={visibleBoard} />
                <strong>底池 {historyAmount(replayState.pot, hand.bb, 'bb')}</strong>
              </div>
              {playerList.map(([name], index) => {
                const contribution = replayState.streetContributions.get(name) ?? 0;
                if (contribution <= 0 || street === 'showdown') return null;
                const position = replayPosition(index, playerList.length, 28, 26);
                const currentInvestment = currentAction?.player === name && isReplayInvestment(currentAction);
                return (
                  <div
                    key={`bet-${name}`}
                    className={`history-table-bet${currentInvestment ? ' active' : ''}`}
                    style={{ left: `${position.left}%`, top: `${position.top}%` }}
                    aria-label={`${name} 当前街投入 ${historyAmount(contribution, hand.bb, 'bb')}`}
                  >
                    <ReplayChipStack />
                    <strong>{currentInvestment ? `${REPLAY_INVESTMENT_LABELS[currentAction.type]} · ` : ''}{historyAmount(contribution, hand.bb, 'bb')}</strong>
                  </div>
                );
              })}
              {playerList.map(([name, player], index) => {
                const position = replayPosition(index, playerList.length, 42, 39);
                const knownCards = hand.holeCards.get(name) ?? [];
                const showCards = name === hero || (showdown && knownCards.length);
                const remainingStack = Math.max(0, player.stack + (replayState.stackChanges.get(name) ?? 0));
                const folded = replayState.foldedPlayers.has(name);
                return (
                  <div
                    key={name}
                    className={`history-replay-seat${currentAction?.player === name ? ' active' : ''}${name === hero ? ' hero' : ''}${folded ? ' folded' : ''}`}
                    style={{ left: `${position.left}%`, top: `${position.top}%` }}
                  >
                    <div className="history-seat-cards">
                      {showCards ? <PlayingCards cards={knownCards} compact /> : <PlayingCards hidden compact />}
                    </div>
                    <strong>{name}</strong>
                    <div className="history-seat-meta">
                      <span>{player.position}</span>
                      <b><ReplayChipStack compact />{historyAmount(remainingStack, hand.bb, 'bb')}</b>
                    </div>
                    {currentAction?.player === name && !isReplayInvestment(currentAction) && <em>{actionLabel(currentAction)}</em>}
                  </div>
                );
              })}
            </div>
            <div className="history-replay-controls">
              <button type="button" onClick={() => { setPlaying(false); setStep(Math.max(initialStep, step - 1)); }} disabled={step <= initialStep}>上一步</button>
              <button type="button" className="primary" onClick={() => {
                if (step >= actions.length) setStep(initialStep);
                setPlaying((value) => !value);
              }}>{playing ? '暂停' : step >= actions.length ? '重新播放' : '播放'}</button>
              <button type="button" onClick={() => { setPlaying(false); setStep(Math.min(actions.length, step + 1)); }} disabled={step >= actions.length}>下一步</button>
              <span>{step} / {actions.length}</span>
            </div>
          </div>
          <aside className="history-action-log">
            <div className="history-replay-summary">
              <span>{hand.date}</span><span>{hand.stakes}</span>
              <PlayingCards cards={hand.holeCards.get(hero) ?? []} compact />
              <strong>{evaluateHandValue([...(hand.holeCards.get(hero) ?? []), ...hand.board])}</strong>
            </div>
            <ol>
              {actions.map((action, index) => (
                <li key={`${index}-${action.player}`} className={step === index + 1 ? 'active' : step > index + 1 ? 'past' : ''}>
                  <span>{action.player}</span><strong>{actionLabel(action)}</strong>
                </li>
              ))}
            </ol>
          </aside>
        </div>
      </section>
    </div>
  );
}

function FilterCardTile({ card, fallback = '?' }) {
  if (!card) return <i className="history-filter-card history-filter-card--empty">{fallback}</i>;
  const rank = card[0] === 'T' ? '10' : card[0];
  const suit = card[1];
  return (
    <i className={`history-filter-card history-filter-card--${suit}`}>
      <b>{rank}</b><span>{SUIT_ICON[suit]}</span>
    </i>
  );
}

function HistoryFilterModal({ title, className = '', onClose, onReset, onConfirm, confirmDisabled = false, children }) {
  useEffect(() => {
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  return (
    <div className="history-filter-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className={`history-filter-modal ${className}`} role="dialog" aria-modal="true" aria-label={title}>
        <header><h3>{title}</h3><button type="button" onClick={onClose} aria-label="关闭">×</button></header>
        <div className="history-filter-modal-body">{children}</div>
        <footer>
          <button type="button" className="secondary" onClick={onReset}>↶ 重置</button>
          <button type="button" className="primary" onClick={onConfirm} disabled={confirmDisabled}>确认</button>
        </footer>
      </section>
    </div>
  );
}

function HoleCardFilterModal({ initial, onClose, onApply }) {
  const [ranks, setRanks] = useState(() => [...initial.ranks]);
  const [suitedOnly, setSuitedOnly] = useState(initial.suitedOnly);
  const selectRank = (index, rank) => {
    setRanks((current) => {
      const next = [...current];
      next[index] = rank;
      if (next[0] && next[0] === next[1]) setSuitedOnly(false);
      return next;
    });
  };
  const pairSelected = Boolean(ranks[0] && ranks[0] === ranks[1]);

  return (
    <HistoryFilterModal
      title="选择底牌"
      className="history-hole-filter-modal"
      onClose={onClose}
      onReset={() => { setRanks([null, null]); setSuitedOnly(false); }}
      onConfirm={() => onApply({ ranks, suitedOnly: pairSelected ? false : suitedOnly })}
    >
      <p className="history-filter-instruction">两行分别代表两张底牌；问号表示任意点数。</p>
      <div className="history-rank-picker">
        {ranks.map((selected, rowIndex) => (
          <div className="history-rank-row" key={`hole-rank-${rowIndex}`}>
            <span>牌 {rowIndex + 1}</span>
            <button type="button" className={!selected ? 'active' : ''} onClick={() => selectRank(rowIndex, null)}>?</button>
            {FILTER_RANKS.map((rank) => (
              <button
                type="button"
                key={`${rowIndex}-${rank}`}
                className={selected === rank ? 'active' : ''}
                onClick={() => selectRank(rowIndex, rank)}
              >{rank}</button>
            ))}
          </div>
        ))}
      </div>
      <label className={`history-suited-toggle${pairSelected ? ' disabled' : ''}`}>
        <input
          type="checkbox"
          checked={suitedOnly && !pairSelected}
          disabled={pairSelected}
          onChange={(event) => setSuitedOnly(event.target.checked)}
        />
        <span>仅同花组合</span>
      </label>
    </HistoryFilterModal>
  );
}

function BoardCardFilterModal({ initial, onClose, onApply }) {
  const [cards, setCards] = useState(() => [...initial]);
  const [activeSlot, setActiveSlot] = useState(() => initial.findIndex((card) => !card) >= 0 ? initial.findIndex((card) => !card) : 0);
  const flopComplete = cards.slice(0, 3).every(Boolean);
  const turnComplete = Boolean(cards[3]);
  const flopCount = cards.slice(0, 3).filter(Boolean).length;
  const valid = (flopCount === 0 || flopCount === 3) && (!cards[3] || flopComplete) && (!cards[4] || turnComplete);
  const takenCards = new Set(cards.filter(Boolean));

  const slotUnlocked = (index) => index < 3 || (index === 3 ? flopComplete : flopComplete && turnComplete);
  const selectSlot = (index) => {
    if (slotUnlocked(index)) setActiveSlot(index);
  };
  const selectCard = (card) => {
    if (!slotUnlocked(activeSlot)) return;
    setCards((current) => {
      const next = [...current];
      next[activeSlot] = card;
      const nextEmpty = next.findIndex((value, index) => !value && (index < 3 || (index === 3 ? next.slice(0, 3).every(Boolean) : next.slice(0, 4).every(Boolean))));
      if (nextEmpty >= 0) setActiveSlot(nextEmpty);
      return next;
    });
  };
  const clearActiveCard = () => {
    setCards((current) => {
      const next = [...current];
      next[activeSlot] = null;
      if (activeSlot < 3) { next[3] = null; next[4] = null; }
      if (activeSlot === 3) next[4] = null;
      return next;
    });
  };

  return (
    <HistoryFilterModal
      title="选择公共牌"
      className="history-board-filter-modal"
      onClose={onClose}
      onReset={() => { setCards(Array(5).fill(null)); setActiveSlot(0); }}
      onConfirm={() => onApply(cards)}
      confirmDisabled={!valid}
    >
      <p className="history-filter-instruction">先选择三张翻牌，再选择转牌和河牌。点击上方牌位可返回修改。</p>
      <div className="history-board-streets">
        <div><span>翻牌</span><div>{[0, 1, 2].map((index) => (
          <button type="button" key={index} className={activeSlot === index ? 'active' : ''} onClick={() => selectSlot(index)}><FilterCardTile card={cards[index]} fallback="+" /></button>
        ))}</div></div>
        <div><span>转牌</span><div><button type="button" className={`${activeSlot === 3 ? 'active' : ''}${!flopComplete ? ' locked' : ''}`} disabled={!flopComplete} onClick={() => selectSlot(3)}><FilterCardTile card={cards[3]} fallback="+" /></button></div></div>
        <div><span>河牌</span><div><button type="button" className={`${activeSlot === 4 ? 'active' : ''}${!turnComplete ? ' locked' : ''}`} disabled={!turnComplete} onClick={() => selectSlot(4)}><FilterCardTile card={cards[4]} fallback="+" /></button></div></div>
      </div>
      <div className="history-board-picker-head">
        <strong>选择第 {activeSlot + 1} 张牌</strong>
        <button type="button" onClick={clearActiveCard} disabled={!cards[activeSlot]}>清除此张</button>
      </div>
      <div className="history-board-card-grid">
        {PICKER_SUITS.map((suit) => (
          <div key={suit}>
            <span className={`history-board-suit history-board-suit--${suit}`}>{SUIT_ICON[suit]}</span>
            {FILTER_RANKS.map((rank) => {
              const card = `${rank}${suit}`;
              const disabled = takenCards.has(card) && cards[activeSlot] !== card;
              return (
                <button
                  type="button"
                  key={card}
                  aria-label={card}
                  className={`history-board-card-button history-board-card-button--${suit}${cards[activeSlot] === card ? ' active' : ''}`}
                  disabled={disabled}
                  onClick={() => selectCard(card)}
                ><b>{rank === 'T' ? '10' : rank}</b><span>{SUIT_ICON[suit]}</span></button>
              );
            })}
          </div>
        ))}
      </div>
      {!valid && <p className="history-board-filter-error">请先选满三张翻牌。</p>}
    </HistoryFilterModal>
  );
}

function HistoryRecords({ results, hands, hero }) {
  const [holeFilter, setHoleFilter] = useState(() => ({ ranks: [null, null], suitedOnly: false }));
  const [boardFilter, setBoardFilter] = useState(() => Array(5).fill(null));
  const [filterModal, setFilterModal] = useState(null);
  const [unit, setUnit] = useState('bb');
  const [sort, setSort] = useState({ key: 'date', direction: 'desc' });
  const [pageSize, setPageSize] = useState(10);
  const [page, setPage] = useState(1);
  const [handViewer, setHandViewer] = useState(null);
  const handById = useMemo(() => new Map(hands.map((hand) => [hand.id, hand])), [hands]);

  const rows = useMemo(() => results.map((result) => ({ result, hand: handById.get(result.id) })).filter((row) => row.hand), [handById, results]);
  const filteredRows = useMemo(() => rows.filter(({ result, hand }) => (
    matchesHoleFilter(result.cards ?? [], holeFilter)
    && matchesBoardFilter(hand.board ?? [], boardFilter)
  )), [boardFilter, holeFilter, rows]);
  const sortedRows = useMemo(() => [...filteredRows].sort((a, b) => {
    const values = {
      date: [handDateValue(a.result), handDateValue(b.result)],
      id: [a.result.id, b.result.id],
      cards: [normalizedRanks(a.result.cards), normalizedRanks(b.result.cards)],
      handValue: [a.result.handValue, b.result.handValue],
      winner: [historyWinnerLabel(a.hand.winners), historyWinnerLabel(b.hand.winners)],
      pot: [a.hand.totalPot, b.hand.totalPot],
      profit: [a.result.profit, b.result.profit]
    }[sort.key];
    const comparison = typeof values[0] === 'number' ? values[0] - values[1] : String(values[0]).localeCompare(String(values[1]), 'zh-CN');
    return sort.direction === 'asc' ? comparison : -comparison;
  }), [filteredRows, sort]);
  const pageCount = Math.max(1, Math.ceil(sortedRows.length / pageSize));
  const safePage = Math.min(page, pageCount);
  const visibleRows = sortedRows.slice((safePage - 1) * pageSize, safePage * pageSize);

  const toggleSort = (key) => setSort((current) => (
    current.key === key
      ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
      : { key, direction: key === 'date' || ['pot', 'profit'].includes(key) ? 'desc' : 'asc' }
  ));
  const reset = () => {
    setHoleFilter({ ranks: [null, null], suitedOnly: false });
    setBoardFilter(Array(5).fill(null));
    setSort({ key: 'date', direction: 'desc' }); setPage(1);
  };
  const holeFilterActive = holeFilter.ranks.some(Boolean) || holeFilter.suitedOnly;
  const boardFilterActive = boardFilter.some(Boolean);

  return (
    <section className="history-records">
      <header className="history-records-head">
        <div><span>牌局历史</span><strong>{filteredRows.length.toLocaleString()} 手牌</strong></div>
        <div className="history-unit-toggle" aria-label="金额单位">
          <button type="button" aria-pressed={unit === 'bb'} className={unit === 'bb' ? 'active' : ''} onClick={() => setUnit('bb')}>BB</button>
          <button type="button" aria-pressed={unit === 'money'} className={unit === 'money' ? 'active' : ''} onClick={() => setUnit('money')}>$</button>
        </div>
      </header>
      <div className="history-record-filters">
        <label>
          <span>底牌</span>
          <button type="button" className={`history-card-filter-trigger${holeFilterActive ? ' active' : ''}`} onClick={() => setFilterModal('hole')}>
            <span className="history-hole-filter-preview">
              <i>{holeFilter.ranks[0] ?? '?'}</i><i>{holeFilter.ranks[1] ?? '?'}</i>
              {holeFilter.suitedOnly && <b>同花</b>}
            </span>
            <strong>{holeFilterActive ? '已选择' : '任何底牌'}</strong>
            <em>修改</em>
          </button>
        </label>
        <label>
          <span>公共牌</span>
          <button type="button" className={`history-card-filter-trigger history-board-filter-trigger${boardFilterActive ? ' active' : ''}`} onClick={() => setFilterModal('board')}>
            <span className="history-board-filter-preview">
              {boardFilter.map((card, index) => (
                <span key={index} className={index === 3 || index === 4 ? 'next-street' : ''}><FilterCardTile card={card} fallback="+" /></span>
              ))}
            </span>
            <strong>{boardFilterActive ? '已选择' : '选择翻牌 / 转牌 / 河牌'}</strong>
            <em>修改</em>
          </button>
        </label>
        <button type="button" className="secondary" onClick={reset}>重置</button>
      </div>
      <div className="history-record-table-wrap">
        <table className="history-record-table">
          <thead><tr>
            <th>重播</th>
            {HISTORY_SORT_COLUMNS.map((column) => (
              <th key={column.key}>
                <button type="button" onClick={() => toggleSort(column.key)}>
                  {column.label}<i>{sort.key === column.key ? (sort.direction === 'asc' ? '↑' : '↓') : '↕'}</i>
                </button>
              </th>
            ))}
          </tr></thead>
          <tbody>
            {visibleRows.map(({ result, hand }) => (
              <tr
                key={result.id}
                className="history-record-row"
                tabIndex={0}
                aria-label={`查看牌局 ${result.id} 的具体牌谱`}
                title="点击查看这手具体牌谱"
                onClick={() => setHandViewer({ mode: 'detail', hand })}
                onKeyDown={(event) => {
                  if (event.target !== event.currentTarget || !['Enter', ' '].includes(event.key)) return;
                  event.preventDefault();
                  setHandViewer({ mode: 'detail', hand });
                }}
              >
                <td><button type="button" className="history-replay-button" onClick={(event) => { event.stopPropagation(); setHandViewer({ mode: 'replay', hand }); }}>▶ 重播</button></td>
                <td><span className="history-record-date">{result.date.replace(/^\d{4}\//, '').replace(' ', ' · ')}</span></td>
                <td><code>{result.id}</code></td>
                <td><PlayingCards cards={result.cards} compact /></td>
                <td><strong>{result.handValue}</strong></td>
                <td>{historyWinnerLabel(hand.winners)}</td>
                <td>{historyAmount(hand.totalPot, hand.bb, unit)}</td>
                <td className={result.profit > 0 ? 'win' : result.profit < 0 ? 'loss' : ''}>{historyAmount(result.profit, hand.bb, unit, true)}</td>
              </tr>
            ))}
            {!visibleRows.length && <tr><td colSpan="8" className="history-record-empty">没有符合当前筛选条件的牌局</td></tr>}
          </tbody>
        </table>
      </div>
      <footer className="history-record-pagination">
        <label>每页 <select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }}>{HISTORY_PAGE_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}</select> 手</label>
        <span>第 {safePage} / {pageCount} 页</span>
        <div><button type="button" onClick={() => setPage(1)} disabled={safePage === 1}>首页</button><button type="button" onClick={() => setPage(safePage - 1)} disabled={safePage === 1}>上一页</button><button type="button" onClick={() => setPage(safePage + 1)} disabled={safePage === pageCount}>下一页</button><button type="button" onClick={() => setPage(pageCount)} disabled={safePage === pageCount}>末页</button></div>
      </footer>
      {handViewer?.mode === 'detail' && (
        <HistoryHandDetail
          hand={handViewer.hand}
          hero={hero}
          initialUnit={unit}
          onClose={() => setHandViewer(null)}
          onReplay={() => setHandViewer({ mode: 'replay', hand: handViewer.hand })}
        />
      )}
      {handViewer?.mode === 'replay' && <HandReplay hand={handViewer.hand} hero={hero} onClose={() => setHandViewer(null)} />}
      {filterModal === 'hole' && (
        <HoleCardFilterModal
          initial={holeFilter}
          onClose={() => setFilterModal(null)}
          onApply={(next) => { setHoleFilter(next); setPage(1); setFilterModal(null); }}
        />
      )}
      {filterModal === 'board' && (
        <BoardCardFilterModal
          initial={boardFilter}
          onClose={() => setFilterModal(null)}
          onApply={(next) => { setBoardFilter(next); setPage(1); setFilterModal(null); }}
        />
      )}
    </section>
  );
}

function HandHistoryView() {
  const fileInputRef = useRef(null);
  const folderInputRef = useRef(null);
  const [status, setStatus] = useState('idle');
  const [message, setMessage] = useState('');
  const [hands, setHands] = useState([]);
  const [fileMeta, setFileMeta] = useState(null);
  const [hero, setHero] = useState('');
  const [stakeFilter, setStakeFilter] = useState('all');
  const [positionFilter, setPositionFilter] = useState('all');
  const [holeCardFilter, setHoleCardFilter] = useState(() => ({ ranks: [null, null], suitedOnly: false }));
  const [holeCardFilterOpen, setHoleCardFilterOpen] = useState(false);
  const [startTp, setStartTp] = useState('0');
  const [endTp, setEndTp] = useState('0');
  const [historyTab, setHistoryTab] = useState('overview');

  const players = useMemo(() => rankedPlayers(hands), [hands]);
  const rawResults = useMemo(() => (
    hero ? hands.map((hand) => hand.getHeroResult(hero)).filter(Boolean) : []
  ), [hands, hero]);
  const stakeOptions = useMemo(() => [...new Set(rawResults.map((hand) => hand.stakes))].filter(Boolean), [rawResults]);
  const positionOptions = useMemo(() => (
    POSITIONS.filter((pos) => rawResults.some((hand) => hand.position === pos))
  ), [rawResults]);
  const stakeFilterOptions = useMemo(() => [
    { value: 'all', label: '全部' },
    ...stakeOptions.map((stake) => ({ value: stake, label: stakeLabel(stake) }))
  ], [stakeOptions]);
  const positionFilterOptions = useMemo(() => [
    { value: 'all', label: '全部' },
    ...positionOptions.map((position) => ({ value: position, label: position }))
  ], [positionOptions]);
  const filteredResults = useMemo(() => rawResults.filter((hand) => (
    (stakeFilter === 'all' || hand.stakes === stakeFilter)
    && (positionFilter === 'all' || hand.position === positionFilter)
    && matchesHoleFilter(hand.cards ?? [], holeCardFilter)
  )), [holeCardFilter, positionFilter, rawResults, stakeFilter]);
  const holeCardFilterActive = holeCardFilter.ranks.some(Boolean) || holeCardFilter.suitedOnly;
  const overallSummary = useMemo(() => summarizeHeroResults(rawResults), [rawResults]);
  const summary = useMemo(() => summarizeHeroResults(filteredResults), [filteredResults]);
  const mainStake = stakeOptions[0] ? stakeLabel(stakeOptions[0]) : '-';
  const tpDelta = Number(endTp) - Number(startTp);
  const expectedTp = overallSummary.gameRake * 100;
  const pvi = expectedTp ? (tpDelta / expectedTp) * 100 : 0;
  const flopStats = summary.postflop?.flop ?? {};
  const turnStats = summary.postflop?.turn ?? {};
  const riverStats = summary.postflop?.river ?? {};
  const detailSections = [
    {
      title: 'BASIC STATS',
      items: [
        { label: 'Hands', value: summary.totalHands.toLocaleString() },
        { label: 'Winnings', value: formatMoney(summary.totalProfit, 0), tone: statTone(summary.totalProfit) },
        { label: 'bb/100', value: formatNumber(summary.bbPer100, 1), tone: statTone(summary.bbPer100) },
        { label: 'VPIP', value: formatPercent(summary.vpip, 0) },
        { label: 'PFR', value: formatPercent(summary.pfr, 0) },
        { label: 'WWSF', value: formatPercent(summary.wwsf, 0), tone: wwsfTone(summary.wwsf) },
        { label: 'WTSD', value: formatPercent(summary.wtsd, 1) },
        { label: 'W$SD', value: formatPercent(summary.wsd, 1) }
      ]
    },
    {
      title: 'PREFLOP',
      items: [
        { label: '3Bet', value: formatPercent(summary.threeBet, 1) },
        { label: 'Squeeze', value: formatPercent(summary.squeeze, 1) },
        { label: '4Bet', value: formatPercent(summary.fourBet, 1) },
        { label: 'Fold to 3Bet', value: formatPercent(summary.foldToThreeBet, 1) },
        { label: 'Fold to 4Bet', value: formatPercent(summary.foldToFourBet, 1) },
        { label: 'Steal Total', value: formatPercent(summary.stealTotal, 1) },
        { label: 'Steal BTN', value: formatPercent(summary.stealBtn, 1) },
        { label: 'Steal SB', value: formatPercent(summary.stealSb, 1) }
      ]
    },
    {
      title: 'FLOP',
      items: [
        { label: 'CBet', value: formatPercent(flopStats.cbet, 1) },
        { label: 'CBet IP', value: formatPercent(flopStats.cbetIp, 1) },
        { label: 'CBet OOP', value: formatPercent(flopStats.cbetOop, 1) },
        { label: 'FvCB', value: formatPercent(flopStats.foldToCbet, 1) },
        { label: 'FvCB IP', value: formatPercent(flopStats.foldToCbetIp, 1) },
        { label: 'FvCB OOP', value: formatPercent(flopStats.foldToCbetOop, 1) },
        { label: 'Donk', value: formatPercent(flopStats.donk, 1) },
        { label: 'CheckC', value: formatPercent(flopStats.checkCall, 1) },
        { label: 'CheckR', value: formatPercent(flopStats.checkRaise, 1) }
      ]
    },
    {
      title: 'TURN',
      items: [
        { label: 'CBet', value: formatPercent(turnStats.cbet, 1) },
        { label: 'CBet IP', value: formatPercent(turnStats.cbetIp, 1) },
        { label: 'CBet OOP', value: formatPercent(turnStats.cbetOop, 1) },
        { label: 'FvCB', value: formatPercent(turnStats.foldToCbet, 1) },
        { label: 'FvCB IP', value: formatPercent(turnStats.foldToCbetIp, 1) },
        { label: 'FvCB OOP', value: formatPercent(turnStats.foldToCbetOop, 1) },
        { label: 'Donk', value: formatPercent(turnStats.donk, 1) },
        { label: 'CheckC', value: formatPercent(turnStats.checkCall, 1) },
        { label: 'CheckR', value: formatPercent(turnStats.checkRaise, 1) }
      ]
    },
    {
      title: 'RIVER',
      items: [
        { label: 'CBet', value: formatPercent(riverStats.cbet, 1) },
        { label: 'CBet IP', value: formatPercent(riverStats.cbetIp, 1) },
        { label: 'CBet OOP', value: formatPercent(riverStats.cbetOop, 1) },
        { label: 'FvCB', value: formatPercent(riverStats.foldToCbet, 1) },
        { label: 'FvCB IP', value: formatPercent(riverStats.foldToCbetIp, 1) },
        { label: 'FvCB OOP', value: formatPercent(riverStats.foldToCbetOop, 1) },
        { label: 'Donk', value: formatPercent(riverStats.donk, 1) },
        { label: 'CheckC', value: formatPercent(riverStats.checkCall, 1) },
        { label: 'CheckR', value: formatPercent(riverStats.checkRaise, 1) }
      ]
    }
  ];

  const handleFiles = async (files) => {
    setStatus('loading');
    setMessage('正在解析牌谱...');
    try {
      const chunks = await readHistoryFiles(files);
      const parsed = await parseHistoryChunks(chunks);
      const unique = new Map();
      for (const hand of parsed) unique.set(hand.id, hand);
      const nextHands = sortHandsByTime([...unique.values()]);
      const nextPlayers = rankedPlayers(nextHands);
      setHands(nextHands);
      setFileMeta({
        files: chunks.length,
        hands: nextHands.length,
        duplicates: parsed.length - nextHands.length
      });
      setHero(nextPlayers[0]?.name ?? '');
      setStakeFilter('all');
      setPositionFilter('all');
      setHoleCardFilter({ ranks: [null, null], suitedOnly: false });
      setHoleCardFilterOpen(false);
      setHistoryTab('overview');
      setStatus(nextHands.length ? 'ready' : 'empty');
      setMessage(nextHands.length ? '' : '没有识别到 GGPoker 手牌。');
    } catch (error) {
      setStatus('error');
      setMessage(error instanceof Error ? error.message : '解析失败');
    }
  };

  const exportCsv = () => {
    if (!filteredResults.length) return;
    downloadText(`kishpoker-${hero || 'hero'}-hands.csv`, exportSummaryCsv(filteredResults));
  };

  return (
    <div className="site site--history">
      <nav className="top-nav">
        <div className="brand">KISHPOKER · Hand History</div>
        <div className="cta-row">
          <button type="button" className="secondary" onClick={() => window.location.assign('/')}>主页</button>
          <button type="button" className="secondary" onClick={() => window.location.assign('?tool=range')}>Range Lab</button>
          <button type="button" className="secondary" onClick={() => window.location.assign('?tool=variance')}>波动计算</button>
        </div>
      </nav>

      <section className="range-panel history-panel" style={{ marginTop: 0 }}>
        <header>
          <p className="eyebrow">GGPoker · Local parser</p>
          <h2>牌谱统计</h2>
          <p className="subtext">上传 GG 手牌历史，浏览器本地解析，不上传服务器。第一版支持基础盈亏、资金曲线、VPIP/PFR/3Bet、级别和位置筛选。</p>
        </header>

        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            if (event.target.files?.length) handleFiles(event.target.files);
            event.target.value = '';
          }}
        />
        <input
          ref={folderInputRef}
          type="file"
          multiple
          hidden
          webkitdirectory=""
          onChange={(event) => {
            if (event.target.files?.length) handleFiles(event.target.files);
            event.target.value = '';
          }}
        />

        <section
          className="history-upload"
          onDragOver={(event) => {
            event.preventDefault();
          }}
          onDrop={async (event) => {
            event.preventDefault();
            const droppedFiles = await filesFromDataTransfer(event.dataTransfer);
            if (droppedFiles.length) handleFiles(droppedFiles);
          }}
        >
          <div>
            <strong>{status === 'loading' ? '正在解析...' : '拖入或选择牌谱文件'}</strong>
            <span>支持文件夹、多个压缩包、.txt、.zip、.rar、.7z、.tar、.gz 等格式。大文件会在你的电脑本地处理。</span>
          </div>
          <div className="history-upload-actions">
            <button type="button" className="primary" onClick={() => fileInputRef.current?.click()} disabled={status === 'loading'}>
              选择文件
            </button>
            <button type="button" className="secondary" onClick={() => folderInputRef.current?.click()} disabled={status === 'loading'}>
              选择文件夹
            </button>
          </div>
        </section>

        {message && <div className={`history-message history-message--${status}`}>{message}</div>}

        {hands.length > 0 && (
          <>
            <section className="history-controls">
              <label>
                <span>Hero</span>
                <select value={hero} onChange={(event) => setHero(event.target.value)}>
                  {players.map((player) => (
                    <option key={player.name} value={player.name}>
                      {player.name} · {player.count} hands{player.auto ? ' · auto' : ''}
                    </option>
                  ))}
                </select>
              </label>
              <button type="button" className="secondary" onClick={exportCsv} disabled={!filteredResults.length}>导出 CSV</button>
            </section>

            <section className="history-meta">
              <span>导入 {fileMeta?.files ?? 0} 个文本源</span>
              <span>识别 {fileMeta?.hands?.toLocaleString() ?? 0} 手牌</span>
              {!!fileMeta?.duplicates && <span>去重 {fileMeta.duplicates.toLocaleString()} 手牌</span>}
              <span>当前筛选 {filteredResults.length.toLocaleString()} 手牌</span>
            </section>

            <section className="history-analysis-layout">
              <aside className="history-side-panel">
                <section className="history-pvi-controls">
                  <label>
                    <span>起始 TP</span>
                    <input type="number" value={startTp} onChange={(event) => setStartTp(event.target.value)} />
                  </label>
                  <label>
                    <span>终止 TP</span>
                    <input type="number" value={endTp} onChange={(event) => setEndTp(event.target.value)} />
                  </label>
                </section>
                <HistoryFilterGroup
                  label="级别"
                  options={stakeFilterOptions}
                  value={stakeFilter}
                  onChange={setStakeFilter}
                />
                <HistoryFilterGroup
                  label="位置"
                  options={positionFilterOptions}
                  value={positionFilter}
                  onChange={setPositionFilter}
                />
                <section className="history-side-hole-filter">
                  <header>
                    <div><span>底牌</span><small>看线筛选</small></div>
                    {holeCardFilterActive && (
                      <button type="button" onClick={() => setHoleCardFilter({ ranks: [null, null], suitedOnly: false })}>清除</button>
                    )}
                  </header>
                  <button
                    type="button"
                    className={`history-card-filter-trigger history-side-hole-trigger${holeCardFilterActive ? ' active' : ''}`}
                    aria-label={holeCardFilterActive ? '修改全局底牌筛选' : '选择全局底牌筛选'}
                    onClick={() => setHoleCardFilterOpen(true)}
                  >
                    <span className="history-hole-filter-preview">
                      <i>{holeCardFilter.ranks[0] ?? '?'}</i><i>{holeCardFilter.ranks[1] ?? '?'}</i>
                      {holeCardFilter.suitedOnly && <b>同花</b>}
                    </span>
                    <strong>{holeCardFilterActive ? '已选择' : '任意底牌'}</strong>
                    <em>{holeCardFilterActive ? '修改' : '选择'}</em>
                  </button>
                  <p>选择后资金曲线和全部数据同步筛选，可与级别、位置叠加。</p>
                </section>
              </aside>

              <div className="history-analysis-main">
                <nav className="history-tabs" aria-label="牌谱统计视图">
                  <button
                    type="button"
                    className={historyTab === 'overview' ? 'active' : ''}
                    onClick={() => setHistoryTab('overview')}
                  >
                    数据总览
                  </button>
                  <button
                    type="button"
                    className={historyTab === 'details' ? 'active' : ''}
                    onClick={() => setHistoryTab('details')}
                  >
                    详细数据
                  </button>
                  <button
                    type="button"
                    className={historyTab === 'history' ? 'active' : ''}
                    onClick={() => setHistoryTab('history')}
                  >
                    历史记录
                  </button>
                  <button
                    type="button"
                    className={historyTab === 'holeCards' ? 'active' : ''}
                    onClick={() => setHistoryTab('holeCards')}
                  >
                    底牌
                  </button>
                </nav>

                {historyTab === 'overview' ? (
                  <>
                    <section className="history-stat-grid">
                      <div className="history-stat-row history-stat-row--basic">
                        <HistoryStatCard label="总手数" value={summary.totalHands.toLocaleString()} />
                        <HistoryStatCard label="常驻级别" value={mainStake} />
                        <HistoryStatCard label="PVI" value={formatPercent(pvi, 2)} />
                      </div>
                      <div className="history-stat-row history-stat-row--profit">
                        <HistoryStatCard label="水后 $" value={formatMoney(summary.totalProfit)} tone={statTone(summary.totalProfit)} />
                        <HistoryStatCard label="水前 $" value={formatMoney(summary.beforeRakeProfit)} tone={statTone(summary.beforeRakeProfit)} />
                        <HistoryStatCard label="盈利 bb" value={formatNumber(summary.totalProfitBB, 1)} tone={statTone(summary.totalProfitBB)} />
                        <HistoryStatCard label="水后百手" value={formatNumber(summary.bbPer100, 2)} tone={statTone(summary.bbPer100)} />
                        <HistoryStatCard label="水前百手" value={formatNumber(summary.beforeRakeBBPer100, 2)} tone={statTone(summary.beforeRakeBBPer100)} />
                      </div>
                      <div className="history-stat-row history-stat-row--rake">
                        <HistoryStatCard label="总抽水" value={formatMoney(summary.totalRake)} />
                        <HistoryStatCard label="游戏抽水" value={formatMoney(summary.gameRake)} />
                        <HistoryStatCard label="JP抽水" value={formatMoney(summary.totalJackpot)} />
                        <HistoryStatCard label="总抽水百手" value={formatNumber(summary.rakeBBPer100, 2)} />
                        <HistoryStatCard label="抽水百手" value={formatNumber(summary.gameRakeBBPer100, 2)} />
                        <HistoryStatCard label="JP抽水百手" value={formatNumber(summary.jackpotRakeBBPer100, 2)} />
                      </div>
                      <div className="history-stat-row history-stat-row--preflop">
                        <HistoryStatCard label="VPIP" value={formatPercent(summary.vpip, 0)} />
                        <HistoryStatCard label="PFR" value={formatPercent(summary.pfr, 0)} />
                        <HistoryStatCard label="3Bet" value={formatPercent(summary.threeBet, 1)} />
                      </div>
                      <div className="history-stat-row history-stat-row--showdown">
                        <HistoryStatCard label="WTSD" value={formatPercent(summary.wtsd, 1)} size="large" />
                        <HistoryStatCard label="WWSF" value={formatPercent(summary.wwsf, 0)} tone={wwsfTone(summary.wwsf)} size="large" />
                        <HistoryStatCard label="W$SD" value={formatPercent(summary.wsd, 1)} size="large" />
                      </div>
                    </section>

                    <section className="history-chart-card">
                      <div className="history-chart-head">
                        <h3>资金曲线</h3>
                        <span>单位：bb</span>
                      </div>
                      <HistoryCurve data={summary.curve} />
                    </section>

                    <section className="history-breakdown">
                      <div>
                        <h4>位置分布</h4>
                        {summary.positions.map((item) => (
                          <p key={item.label}><span>{item.label}</span><strong>{item.count}</strong></p>
                        ))}
                      </div>
                      <div>
                        <h4>级别分布</h4>
                        {summary.stakes.map((item) => (
                          <p key={item.label}><span>{item.label}</span><strong>{item.count}</strong></p>
                        ))}
                      </div>
                    </section>
                  </>
                ) : historyTab === 'history' ? (
                  <HistoryRecords results={filteredResults} hands={hands} hero={hero} />
                ) : historyTab === 'holeCards' ? (
                  <HoleCardReport results={filteredResults} />
                ) : (
                  <section className="history-detail-stack">
                    {detailSections.map((section) => (
                      <HistoryDetailSection key={section.title} title={section.title} items={section.items} />
                    ))}
                    <p className="history-detail-note">标记为 “-” 的指标需要继续补解析口径，当前先保留详情页结构。</p>
                  </section>
                )}
              </div>
            </section>
          </>
        )}
        {holeCardFilterOpen && (
          <HoleCardFilterModal
            initial={holeCardFilter}
            onClose={() => setHoleCardFilterOpen(false)}
            onApply={(next) => { setHoleCardFilter(next); setHoleCardFilterOpen(false); }}
          />
        )}
      </section>
    </div>
  );
}


function HomeView() {
  const openRange = () => window.location.assign('?tool=range');
  const openEquity = () => window.location.assign('?tool=equity');
  const openVariance = () => window.location.assign('?tool=variance');
  const openHistory = () => window.location.assign('?tool=history');
  const downloadPlugin = () => {
    if (typeof window === 'undefined') return;
    window.open(RNG_DOWNLOAD_PATH, '_blank');
  };
  const [language, setLanguage] = useState(() => {
    if (typeof window === 'undefined') return 'zh';
    const params = new URLSearchParams(window.location.search);
    return params.get('lang') === 'en' ? 'en' : 'zh';
  });

  const copy = HOMEPAGE_COPY[language] ?? HOMEPAGE_COPY.zh;

  const handleLanguageChange = (next) => {
    setLanguage(next);
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      if (next === 'zh') {
        params.delete('lang');
      } else {
        params.set('lang', next);
      }
      const query = params.toString();
      const nextUrl = `${window.location.pathname}${query ? `?${query}` : ''}`;
      window.history.replaceState({}, '', nextUrl);
    }
  };

  const featureCards = FEATURE_BLUEPRINT.map((item) => {
    const meta = copy.features[item.key];
    const actionHandler = (() => {
      if (item.action === 'range') return openRange;
      if (item.action === 'equity') return openEquity;
      if (item.action === 'variance') return openVariance;
      if (item.action === 'history') return openHistory;
      if (item.action === 'download') return downloadPlugin;
      return null;
    })();
    return {
      key: item.key,
      ...meta,
      actionHandler,
      actionLabel: actionHandler ? copy.actions[item.action] : null
    };
  });

  return (
    <div className="site">
      <nav className="top-nav">
        <div className="brand">KISHPOKER</div>
        <div className="lang-switch">
          {Object.entries(LANGUAGE_LABELS).map(([code, label]) => (
            <button
              type="button"
              key={code}
              className={language === code ? 'active' : ''}
              onClick={() => handleLanguageChange(code)}
            >{label}</button>
          ))}
        </div>
      </nav>

      <header className="hero">
        <div>
          <p className="eyebrow">{copy.hero.eyebrow}</p>
          <h1>{copy.hero.title}</h1>
          <p>{copy.hero.desc}</p>
        </div>
        <div className="cta-row">
          <button type="button" className="primary" onClick={openHistory}>{copy.hero.primaryCta}</button>
          <button type="button" className="secondary" onClick={openEquity}>{copy.hero.secondaryCta}</button>
          <button type="button" className="secondary" onClick={openVariance}>{copy.hero.varianceCta ?? 'Variance calculator'}</button>
        </div>
      </header>

      <section>
        <div className="section-title">
          <h2>{copy.section.title}</h2>
          <span className="subtext">{copy.section.subtitle}</span>
        </div>
        <div className="feature-grid">
          {featureCards.map((feature) => (
            <article key={feature.key} className="feature-card">
              <span>{feature.label}</span>
              <h3>{feature.title}</h3>
              <p>{feature.desc}</p>
              {feature.actionHandler && (
                <button type="button" className="card-link" onClick={feature.actionHandler}>
                  {feature.actionLabel}
                </button>
              )}
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

function App() {
  const search = typeof window !== 'undefined' ? window.location.search : '';
  const params = new URLSearchParams(search);
  const tool = params.get('tool');

  if (tool === 'range') return <RangeLabView />;
  if (tool === 'equity') return <EquityView />;
  if (tool === 'variance') return <VarianceView />;
  if (tool === 'history') return <HandHistoryView />;
  return <HomeView />;
}

export default App;
