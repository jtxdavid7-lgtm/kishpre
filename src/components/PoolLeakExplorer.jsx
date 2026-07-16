import { useMemo, useRef, useState, useEffect } from 'react';
import './PoolLeakExplorer.css';

const DATA_ROOT = '/data/pool-leaks/v1/';
const MANIFEST_URL = `${DATA_ROOT}manifest.json`;
const MAX_RESULTS = 500;

const ROLE_NAMES = Object.freeze({
  IA: 'IA｜有位置进攻方',
  OA: 'OA｜无位置进攻方',
  ID: 'ID｜有位置防守方',
  OD: 'OD｜无位置防守方'
});

const STREET_NAMES = Object.freeze({
  flop: '翻牌',
  turn: '转牌',
  river: '河牌'
});

const FAMILY_NAMES = Object.freeze({
  PFA_BET: '面对 PFA 下注（c-bet）',
  CHECK_RAISE: '面对 Check-Raise',
  RAISE: '面对 Raise',
  RERAISE: '面对再加注',
  DONK: '面对 Donk',
  PROBE: '面对 Probe',
  LEAD: '面对 Lead'
});

const FILTER_DEFAULTS = Object.freeze({
  level: 'FINE',
  pot: 'ALL',
  street: 'flop',
  board: 'ALL',
  role: 'ALL',
  family: 'PFA_BET',
  verdict: 'UNDER',
  minimumSample: 500,
  size: 'ALL',
  sort: 'conservative',
  search: ''
});

const MINIMUM_SAMPLE_OPTIONS = Object.freeze([500, 1000, 3000, 10000, 100]);
const EXTREME_SIZE_KEYS = new Set(['15_over_225', 'fb_06_over150']);
const jsonCache = new Map();
const numberFormatter = new Intl.NumberFormat('zh-CN');

function readJson(url, refresh = false) {
  if (refresh) jsonCache.delete(url);
  if (!jsonCache.has(url)) {
    const request = fetch(url, { credentials: 'same-origin' })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .catch((error) => {
        jsonCache.delete(url);
        throw error;
      });
    jsonCache.set(url, request);
  }
  return jsonCache.get(url);
}

function resolveDataUrl(fileEntry, fallback) {
  const value = typeof fileEntry === 'string'
    ? fileEntry
    : fileEntry?.path ?? fileEntry?.url ?? fileEntry?.file;
  const path = value || fallback;
  if (/^(?:https?:)?\/\//i.test(path) || path.startsWith('/')) return path;
  return `${DATA_ROOT}${String(path).replace(/^\.\//, '')}`;
}

function rowsFromPayload(payload) {
  const rawRows = Array.isArray(payload) ? payload : payload?.rows;
  if (!Array.isArray(rawRows)) return [];
  const fields = Array.isArray(payload?.rowFields) ? payload.rowFields : null;
  if (!fields || !rawRows.some(Array.isArray)) return rawRows;
  return rawRows.map((row) => (
    Array.isArray(row)
      ? Object.fromEntries(fields.map((field, index) => [field, row[index]]))
      : row
  ));
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function formatNumber(value) {
  return numberFormatter.format(Math.max(0, finiteNumber(value)));
}

function formatCompactNumber(value) {
  const number = finiteNumber(value);
  if (number >= 10_000) return `${(number / 10_000).toFixed(number >= 1_000_000 ? 0 : 1)}万`;
  return formatNumber(number);
}

function formatPercent(value, digits = 2) {
  return `${(finiteNumber(value) * 100).toFixed(digits)}%`;
}

function formatPercentagePoints(value) {
  const number = finiteNumber(value);
  return `${number >= 0 ? '+' : ''}${(number * 100).toFixed(2)}pp`;
}

function spotKey(row) {
  return [row?.b, row?.p, row?.s, row?.r, row?.a, row?.c, row?.h].join('|');
}

function confidenceFor(row, minimumSample) {
  const sample = finiteNumber(row?.n);
  if (sample < minimumSample) {
    return {
      label: '样本不足',
      tone: 'sparse',
      title: `样本 ${formatNumber(sample)}，低于当前 ${formatNumber(minimumSample)} 门槛`
    };
  }
  const low = finiteNumber(row?.lo);
  const high = finiteNumber(row?.hi);
  const halfWidth = Math.max(0, (high - low) / 2);
  const label = halfWidth <= 0.015 ? '高' : halfWidth <= 0.03 ? '中' : '低';
  return {
    label,
    tone: label === '高' ? 'high' : label === '中' ? 'medium' : 'low',
    title: `置信度${label}`
  };
}

function verdictFor(row, minimumSample) {
  if (finiteNumber(row?.n) < minimumSample) {
    return { key: 'SPARSE', label: '样本不足', tone: 'sparse' };
  }
  const defense = finiteNumber(row?.d);
  const mdf = finiteNumber(row?.m);
  const gap = Number.isFinite(Number(row?.g)) ? Number(row.g) : defense - mdf;
  if (finiteNumber(row?.hi) < mdf && gap <= -0.03) {
    return { key: 'UNDER', label: '防守不足', tone: 'under' };
  }
  if (finiteNumber(row?.lo) > mdf && gap >= 0.03) {
    return { key: 'OVER', label: '防守过度', tone: 'over' };
  }
  return { key: 'OK', label: '接近理论', tone: 'ok' };
}

function actionVerdict(row, minimumSample) {
  if (finiteNumber(row?.n) < minimumSample) {
    return { label: '样本不足', tone: 'sparse' };
  }
  if (EXTREME_SIZE_KEYS.has(row?.z)) {
    return { label: '极端/全下，谨慎', tone: 'sparse' };
  }
  const conservative = finiteNumber(row?.m) - finiteNumber(row?.hi);
  if (conservative >= 0.15 && finiteNumber(row?.n) >= 5000) {
    return { label: '强过度弃牌', tone: 'under' };
  }
  if (conservative >= 0.08) return { label: '明显多弃', tone: 'under' };
  if (conservative > 0) return { label: '轻度多弃', tone: 'under' };
  if (finiteNumber(row?.lo) > finiteNumber(row?.m)) {
    return { label: '对手过度防守', tone: 'over' };
  }
  return { label: '证据不足', tone: 'ok' };
}

function boardGroupFor(key) {
  const index = Number(String(key).slice(0, 2));
  if (index >= 1 && index <= 8) return 'A 高牌面';
  if (index >= 9 && index <= 16) return 'K/Q 高牌面';
  if (index >= 17 && index <= 25) return 'J/T 高牌面';
  if (index >= 26 && index <= 33) return '低牌牌面';
  return '特殊牌面';
}

function decodeRoute(route = '') {
  const streetNames = { F: '翻牌', T: '转牌', R: '河牌' };
  const actionNames = { X: '过牌', B: '下注', C: '跟注', R: '加注', F: '弃牌' };
  return String(route)
    .split(' / ')
    .map((part) => {
      const [street, actions = ''] = part.split(':');
      return `${streetNames[street] || street}：${[...actions].map((action) => actionNames[action] || action).join(' → ')}`;
    })
    .join('；');
}

function rowSizeLabel(row) {
  if (row?.l === 'ALL') return row?.b === 'ALL' ? '混合全部尺寸' : '该牌面全部尺寸';
  return row?.zl || row?.z || '未知尺寸';
}

function ratioLabel(row) {
  return ['CHECK_RAISE', 'RAISE', 'RERAISE'].includes(row?.a)
    ? '加注风险 R/P'
    : '下注尺寸 B/P';
}

function actualSizeRange(row) {
  return `${formatPercent(row?.min)}–${formatPercent(row?.max)}`;
}

function boardLabel(row, boardCatalog) {
  if (!row?.b || row.b === 'ALL') return '';
  return boardCatalog.find((board) => board.key === row.b)?.label || row.b;
}

function compareRows(sort, verdict) {
  return (left, right) => {
    if (sort === 'sample') return finiteNumber(right.n) - finiteNumber(left.n);
    if (sort === 'gap') {
      if (verdict === 'OVER') return finiteNumber(right.g) - finiteNumber(left.g);
      return finiteNumber(left.g) - finiteNumber(right.g);
    }
    if (verdict === 'OVER') {
      return (finiteNumber(right.lo) - finiteNumber(right.m))
        - (finiteNumber(left.lo) - finiteNumber(left.m));
    }
    if (verdict === 'ANY') {
      return Math.abs(finiteNumber(right.g)) - Math.abs(finiteNumber(left.g));
    }
    return (finiteNumber(right.m) - finiteNumber(right.hi))
      - (finiteNumber(left.m) - finiteNumber(left.hi))
      || finiteNumber(right.n) - finiteNumber(left.n);
  };
}

function resultMatches(row, filters, boardCatalog) {
  if (row?.l !== filters.level) return false;
  if (filters.board === 'ALL' ? row?.b !== 'ALL' : row?.b !== filters.board) return false;
  if (filters.pot !== 'ALL' && row?.p !== filters.pot) return false;
  if (filters.street !== 'ALL' && row?.s !== filters.street) return false;
  if (filters.role !== 'ALL' && row?.r !== filters.role) return false;
  if (filters.family !== 'ALL' && row?.a !== filters.family) return false;
  if (filters.level === 'FINE' && filters.size !== 'ALL' && row?.z !== filters.size) return false;
  if (!filters.search) return true;
  const searchTarget = [
    row?.c,
    row?.h,
    FAMILY_NAMES[row?.a],
    boardLabel(row, boardCatalog)
  ].filter(Boolean).join(' ').toLowerCase();
  return searchTarget.includes(filters.search.toLowerCase());
}

function matchesVerdict(row, filters) {
  if (filters.verdict === 'ANY') return true;
  return verdictFor(row, filters.minimumSample).key === filters.verdict;
}

function boardGroups(boardCatalog) {
  const groups = new Map();
  boardCatalog.forEach((board) => {
    const group = boardGroupFor(board.key);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(board);
  });
  return [...groups.entries()];
}

function fileEntry(manifest, key) {
  const files = manifest?.files;
  if (!files) return null;
  if (!Array.isArray(files)) return files[key] ?? null;
  return files.find((entry) => entry?.key === key || entry?.name === key || entry?.id === key) ?? null;
}

export function PoolLeakExplorer({ className = '' }) {
  const [manifest, setManifest] = useState(null);
  const [explorerPayload, setExplorerPayload] = useState(null);
  const [initialStatus, setInitialStatus] = useState('loading');
  const [initialError, setInitialError] = useState('');
  const [reloadVersion, setReloadVersion] = useState(0);
  const [boardPayload, setBoardPayload] = useState(null);
  const [boardStatus, setBoardStatus] = useState('idle');
  const [boardError, setBoardError] = useState('');
  const [filters, setFilters] = useState({ ...FILTER_DEFAULTS });
  const [selectedSpot, setSelectedSpot] = useState(null);
  const researchRef = useRef(null);

  useEffect(() => {
    let active = true;
    const refresh = reloadVersion > 0;
    (async () => {
      try {
        const nextManifest = await readJson(MANIFEST_URL, refresh);
        const explorerUrl = resolveDataUrl(fileEntry(nextManifest, 'explorer'), 'explorer.json');
        const nextExplorer = await readJson(explorerUrl, refresh);
        if (!active) return;
        setManifest(nextManifest);
        setExplorerPayload(nextExplorer);
        setInitialError('');
        setInitialStatus('ready');
      } catch (error) {
        if (!active) return;
        setInitialError(error instanceof Error ? error.message : String(error));
        setInitialStatus('error');
      }
    })();
    return () => {
      active = false;
    };
  }, [reloadVersion]);

  const baseRows = useMemo(() => rowsFromPayload(explorerPayload), [explorerPayload]);
  const boardRows = useMemo(() => rowsFromPayload(boardPayload), [boardPayload]);
  const boardCatalog = useMemo(() => {
    const source = Array.isArray(manifest?.boardClasses) && manifest.boardClasses.length
      ? manifest.boardClasses
      : Array.isArray(boardPayload?.boardClasses) ? boardPayload.boardClasses : [];
    return source
      .filter((board) => board?.key)
      .map((board) => ({
        key: board.key,
        label: board.label || board.key,
        observed: board.observed !== false
      }));
  }, [manifest, boardPayload]);

  const loadBoardData = async (refresh = false) => {
    if (boardStatus === 'loading') return;
    setBoardStatus('loading');
    setBoardError('');
    try {
      const boardUrl = resolveDataUrl(fileEntry(manifest, 'flopBoards'), 'flop-boards.json');
      const payload = await readJson(boardUrl, refresh);
      setBoardPayload(payload);
      setBoardStatus('ready');
    } catch (error) {
      setBoardError(error instanceof Error ? error.message : String(error));
      setBoardStatus('error');
    }
  };

  const activeRows = filters.board === 'ALL' ? baseRows : boardRows;

  const availableSizes = useMemo(() => {
    const labels = new Map();
    activeRows.forEach((row) => {
      if (row?.l !== 'FINE') return;
      if (filters.board === 'ALL' ? row?.b !== 'ALL' : row?.b !== filters.board) return;
      if (row?.z) labels.set(row.z, row.zl || row.z);
    });
    return [...labels.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, label]) => ({ key, label }));
  }, [activeRows, filters.board]);

  const dimensionRows = useMemo(() => (
    activeRows.filter((row) => resultMatches(row, filters, boardCatalog))
  ), [activeRows, filters, boardCatalog]);

  const qualifyingRows = useMemo(() => (
    dimensionRows
      .filter((row) => finiteNumber(row?.n) >= filters.minimumSample)
      .filter((row) => matchesVerdict(row, filters))
      .sort(compareRows(filters.sort, filters.verdict))
  ), [dimensionRows, filters]);

  const displayedRows = qualifyingRows.slice(0, MAX_RESULTS);
  const displayedSpotKeys = useMemo(() => new Set(displayedRows.map(spotKey)), [displayedRows]);
  const activeSelectedSpot = selectedSpot && displayedSpotKeys.has(selectedSpot)
    ? selectedSpot
    : displayedRows[0] ? spotKey(displayedRows[0]) : null;

  const selectedOverview = useMemo(() => {
    if (!activeSelectedSpot) return null;
    return activeRows.find((row) => row?.l === 'ALL' && spotKey(row) === activeSelectedSpot)
      || activeRows.find((row) => spotKey(row) === activeSelectedSpot)
      || null;
  }, [activeRows, activeSelectedSpot]);

  const researchRows = useMemo(() => {
    if (!activeSelectedSpot) return [];
    return activeRows
      .filter((row) => row?.l === 'FINE' && spotKey(row) === activeSelectedSpot)
      .sort((left, right) => String(left?.z).localeCompare(String(right?.z)));
  }, [activeRows, activeSelectedSpot]);

  const researchSummary = useMemo(() => {
    const eligible = researchRows.filter((row) => finiteNumber(row?.n) >= filters.minimumSample);
    const rankable = eligible.filter((row) => !EXTREME_SIZE_KEYS.has(row?.z));
    const credible = rankable.filter((row) => (
      finiteNumber(row?.m) - finiteNumber(row?.hi) > 0
      && finiteNumber(row?.m) - finiteNumber(row?.d) >= 0.03
    ));
    const best = credible
      .slice()
      .sort((left, right) => (
        (finiteNumber(right.m) - finiteNumber(right.hi))
        - (finiteNumber(left.m) - finiteNumber(left.hi))
        || finiteNumber(right.n) - finiteNumber(left.n)
      ))[0] || null;
    const volume = rankable.slice().sort((left, right) => finiteNumber(right.n) - finiteNumber(left.n))[0] || null;
    return { eligible, best, volume, reference: best || volume || eligible[0] || null };
  }, [researchRows, filters.minimumSample]);

  const sparseCount = dimensionRows.filter((row) => finiteNumber(row?.n) < filters.minimumSample).length;
  const highestSample = dimensionRows.reduce((highest, row) => Math.max(highest, finiteNumber(row?.n)), 0);
  const boardIsLoading = filters.board !== 'ALL' && boardStatus === 'loading';
  const boardHasError = filters.board !== 'ALL' && boardStatus === 'error';

  const updateFilter = (key, value) => {
    let nextValue = value;
    if (key === 'minimumSample') nextValue = Number(value);
    setSelectedSpot(null);
    setFilters((current) => {
      const next = { ...current, [key]: nextValue };
      if (key === 'board') {
        next.size = 'ALL';
        if (nextValue !== 'ALL') {
          next.street = 'flop';
          next.family = 'PFA_BET';
          if (next.role === 'IA' || next.role === 'OA') next.role = 'ALL';
        }
      }
      if (key === 'street' && ['turn', 'river'].includes(nextValue)) next.board = 'ALL';
      if (key === 'family' && !['ALL', 'PFA_BET'].includes(nextValue)) next.board = 'ALL';
      if (key === 'role' && next.board !== 'ALL' && ['IA', 'OA'].includes(nextValue)) next.role = 'ALL';
      if (key === 'level' && nextValue === 'ALL') next.size = 'ALL';
      return next;
    });
    if (key === 'board' && value !== 'ALL' && !boardPayload) loadBoardData();
  };

  const retryInitialLoad = () => {
    setInitialStatus('loading');
    setInitialError('');
    setReloadVersion((version) => version + 1);
  };

  const chooseSpot = (row) => {
    setSelectedSpot(spotKey(row));
    window.requestAnimationFrame(() => researchRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  if (initialStatus === 'loading') {
    return (
      <section className={`pool-leak-explorer${className ? ` ${className}` : ''}`} aria-busy="true">
        <div className="pool-leak-status">
          <span className="pool-leak-spinner" aria-hidden="true" />
          <div>
            <strong>正在读取玩家池汇总数据</strong>
            <p>只加载匿名统计，不会读取或上传你的牌谱。</p>
          </div>
        </div>
      </section>
    );
  }

  if (initialStatus === 'error') {
    return (
      <section className={`pool-leak-explorer${className ? ` ${className}` : ''}`}>
        <div className="pool-leak-status pool-leak-status--error" role="alert">
          <div>
            <strong>查询数据读取失败</strong>
            <p>请检查网络后重试。{initialError ? `（${initialError}）` : ''}</p>
          </div>
          <button type="button" onClick={retryInitialLoad}>重新读取</button>
        </div>
      </section>
    );
  }

  const summary = manifest?.summary || {};
  const selectedBoardLabel = boardCatalog.find((board) => board.key === filters.board)?.label;
  const sampleWarning = dimensionRows.length > 0 && highestSample < filters.minimumSample
    ? `该组合没有达到 ${formatNumber(filters.minimumSample)} 样本的节点；最高仅 ${formatNumber(highestSample)} 手，不能据此判断漏洞。`
    : sparseCount > 0
      ? `另有 ${formatNumber(sparseCount)} 个节点低于当前 ${formatNumber(filters.minimumSample)} 样本门槛，已隐藏。`
      : '';
  const priority = researchSummary.reference;
  const best = researchSummary.best;

  return (
    <main className={`pool-leak-explorer${className ? ` ${className}` : ''}`}>
      <header className="pool-leak-hero">
        <div>
          <span className="pool-leak-eyebrow">PLAYER POOL LEAKS</span>
          <h1>真实玩家池漏洞查询器</h1>
          <p>先定位可信 Spot，再查看各个尺寸到底多弃了多少。数据已经匿名汇总，查询时不需要上传牌谱。</p>
        </div>
        <div className="pool-leak-dataset-badges" aria-label="数据摘要">
          {summary.handsAnalyzed != null && <span><b>{formatCompactNumber(summary.handsAnalyzed)}</b> 手牌</span>}
          {summary.headsUpPressureResponses != null && <span><b>{formatCompactNumber(summary.headsUpPressureResponses)}</b> 次单挑响应</span>}
          <span><i aria-hidden="true" /> 静态匿名数据</span>
        </div>
      </header>

      <section className="pool-leak-panel pool-leak-filters" aria-labelledby="pool-leak-filter-title">
        <div className="pool-leak-section-heading">
          <div>
            <span>STEP 1</span>
            <h2 id="pool-leak-filter-title">选择要研究的节点</h2>
          </div>
          <button
            type="button"
            className="pool-leak-reset"
            onClick={() => {
              setSelectedSpot(null);
              setFilters({ ...FILTER_DEFAULTS });
            }}
          >
            恢复默认
          </button>
        </div>

        <div className="pool-leak-control-grid">
          <label>
            <span>查询粒度</span>
            <select value={filters.level} onChange={(event) => updateFilter('level', event.target.value)}>
              <option value="FINE">细分下注尺寸</option>
              <option value="ALL">Spot 汇总（混合尺寸）</option>
            </select>
          </label>
          <label>
            <span>底池类型</span>
            <select value={filters.pot} onChange={(event) => updateFilter('pot', event.target.value)}>
              <option value="ALL">全部底池</option>
              <option value="SRP">SRP｜单次加注池</option>
              <option value="3BP">3BP｜3-bet 底池</option>
              <option value="4BP">4BP｜4-bet 底池</option>
              <option value="5BP">5BP+｜5-bet 及以上</option>
            </select>
          </label>
          <label>
            <span>街道</span>
            <select
              value={filters.street}
              disabled={filters.board !== 'ALL'}
              onChange={(event) => updateFilter('street', event.target.value)}
            >
              <option value="ALL">全部街道</option>
              <option value="flop">Flop｜翻牌</option>
              <option value="turn">Turn｜转牌</option>
              <option value="river">River｜河牌</option>
            </select>
          </label>
          <label>
            <span>牌面（仅 Flop c-bet）</span>
            <select
              value={filters.board}
              disabled={['turn', 'river'].includes(filters.street) || !['ALL', 'PFA_BET'].includes(filters.family)}
              aria-describedby="pool-leak-board-help"
              onChange={(event) => updateFilter('board', event.target.value)}
            >
              <option value="ALL">全部牌面（不拆分）</option>
              {boardGroups(boardCatalog).map(([group, boards]) => (
                <optgroup key={group} label={group}>
                  {boards.map((board) => (
                    <option key={board.key} value={board.key} disabled={!board.observed}>
                      {board.label}{board.observed ? '' : '（未观测）'}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          <label>
            <span>响应角色</span>
            <select value={filters.role} onChange={(event) => updateFilter('role', event.target.value)}>
              <option value="ALL">全部角色</option>
              <option value="IA" disabled={filters.board !== 'ALL'}>{ROLE_NAMES.IA}</option>
              <option value="OA" disabled={filters.board !== 'ALL'}>{ROLE_NAMES.OA}</option>
              <option value="ID">{ROLE_NAMES.ID}</option>
              <option value="OD">{ROLE_NAMES.OD}</option>
            </select>
          </label>
          <label>
            <span>当前面对</span>
            <select
              value={filters.family}
              disabled={filters.board !== 'ALL'}
              onChange={(event) => updateFilter('family', event.target.value)}
            >
              <option value="ALL">全部压力类型</option>
              {Object.entries(FAMILY_NAMES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select>
          </label>
          <label>
            <span>结论</span>
            <select value={filters.verdict} onChange={(event) => updateFilter('verdict', event.target.value)}>
              <option value="UNDER">防守不足</option>
              <option value="OVER">防守过度</option>
              <option value="OK">接近理论</option>
              <option value="ANY">全部结论</option>
            </select>
          </label>
          <label>
            <span>最低样本</span>
            <select value={filters.minimumSample} onChange={(event) => updateFilter('minimumSample', event.target.value)}>
              {MINIMUM_SAMPLE_OPTIONS.map((sample) => (
                <option key={sample} value={sample}>
                  {formatNumber(sample)}{sample === 100 ? '（探索）' : ''}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>下注尺寸</span>
            <select
              value={availableSizes.some((size) => size.key === filters.size) ? filters.size : 'ALL'}
              disabled={filters.level === 'ALL' || boardIsLoading}
              onChange={(event) => updateFilter('size', event.target.value)}
            >
              <option value="ALL">全部尺寸</option>
              {availableSizes.map((size) => <option key={size.key} value={size.key}>{size.label}</option>)}
            </select>
          </label>
          <label>
            <span>排序</span>
            <select value={filters.sort} onChange={(event) => updateFilter('sort', event.target.value)}>
              <option value="conservative">可信漏洞优先</option>
              <option value="gap">原始 Gap</option>
              <option value="sample">样本量</option>
            </select>
          </label>
          <label className="pool-leak-search">
            <span>搜索 Line / 完整路径</span>
            <input
              type="search"
              value={filters.search}
              placeholder="例如 BXB、XR、F:XBC / T:XX / R:XB"
              onChange={(event) => updateFilter('search', event.target.value.trimStart())}
            />
          </label>
        </div>
        <p className="pool-leak-filter-help" id="pool-leak-board-help">
          选择具体牌面会自动锁定 Flop、PFA 首次 c-bet 和 ID/OD 防守节点。总防守率 = Call + Raise；MDF = P / (P + B)。
        </p>
      </section>

      {boardHasError && (
        <div className="pool-leak-inline-error" role="alert">
          <span>牌面拆分数据读取失败。{boardError ? `（${boardError}）` : ''}</span>
          <button type="button" onClick={() => loadBoardData(true)}>重试</button>
        </div>
      )}

      <section className="pool-leak-panel" aria-labelledby="pool-leak-results-title" aria-busy={boardIsLoading}>
        <div className="pool-leak-section-heading pool-leak-results-heading">
          <div>
            <span>STEP 2</span>
            <h2 id="pool-leak-results-title">查询结果</h2>
            <p aria-live="polite">
              {boardIsLoading
                ? `正在读取“${selectedBoardLabel || '所选牌面'}”的数据…`
                : `符合 ${formatNumber(qualifyingRows.length)} 个，显示前 ${formatNumber(displayedRows.length)} 个`}
            </p>
            {!boardIsLoading && sampleWarning && <p className="pool-leak-sample-warning">{sampleWarning}</p>}
          </div>
        </div>

        <div className="pool-leak-table-wrap pool-leak-results-table" tabIndex="0" aria-label="玩家池漏洞查询结果，可横向滚动">
          <table className="pool-leak-table">
            <caption className="pool-leak-sr-only">按当前条件筛选的玩家池防守数据</caption>
            <thead>
              <tr>
                <th scope="col">Spot</th>
                <th scope="col">完整路径</th>
                <th scope="col">尺寸</th>
                <th scope="col">样本</th>
                <th scope="col">Fold</th>
                <th scope="col">Call</th>
                <th scope="col">Raise</th>
                <th scope="col">总防守</th>
                <th scope="col">MDF</th>
                <th scope="col">Gap</th>
                <th scope="col">置信度</th>
                <th scope="col">结论</th>
              </tr>
            </thead>
            <tbody>
              {boardIsLoading && (
                <tr><td colSpan="12" className="pool-leak-empty"><span className="pool-leak-spinner" aria-hidden="true" /> 正在读取牌面拆分数据</td></tr>
              )}
              {!boardIsLoading && !boardHasError && displayedRows.length === 0 && (
                <tr>
                  <td colSpan="12" className="pool-leak-empty">
                    {dimensionRows.length === 0
                      ? '没有对应节点，请放宽筛选条件。'
                      : highestSample < filters.minimumSample
                        ? '当前组合只有小样本，不能输出漏洞结论。'
                        : '达到样本门槛的节点中，没有符合当前结论条件的结果。'}
                  </td>
                </tr>
              )}
              {!boardIsLoading && !boardHasError && displayedRows.map((row) => {
                const verdict = verdictFor(row, filters.minimumSample);
                const confidence = confidenceFor(row, filters.minimumSample);
                const gap = Number.isFinite(Number(row?.g)) ? Number(row.g) : finiteNumber(row?.d) - finiteNumber(row?.m);
                const selected = spotKey(row) === activeSelectedSpot;
                const board = boardLabel(row, boardCatalog);
                return (
                  <tr key={`${spotKey(row)}|${row?.l}|${row?.z}`} className={selected ? 'is-selected' : ''}>
                    <td>
                      <button
                        type="button"
                        className="pool-leak-spot-button"
                        aria-current={selected ? 'true' : undefined}
                        onClick={() => chooseSpot(row)}
                      >
                        <strong>{row?.p === '5BP' ? '5BP+' : row?.p} · {String(row?.s || '').toUpperCase()} · {row?.r} · {row?.c}</strong>
                        <span>{FAMILY_NAMES[row?.a] || row?.a}{board ? ` · ${board}` : ''}</span>
                      </button>
                    </td>
                    <td><code>{row?.h}</code><small>{decodeRoute(row?.h)}</small></td>
                    <td><strong>{rowSizeLabel(row)}</strong><small>{ratioLabel(row)} {actualSizeRange(row)}</small></td>
                    <td>{formatNumber(row?.n)}</td>
                    <td>{formatPercent(row?.f)}</td>
                    <td>{formatPercent(row?.ca)}</td>
                    <td>{formatPercent(row?.ra)}</td>
                    <td>{formatPercent(row?.d)}</td>
                    <td>{formatPercent(row?.m)}</td>
                    <td className={gap < 0 ? 'is-negative' : 'is-positive'}>{formatPercentagePoints(gap)}</td>
                    <td><span className={`pool-leak-confidence is-${confidence.tone}`} title={confidence.title}>{confidence.label}</span></td>
                    <td><span className={`pool-leak-verdict is-${verdict.tone}`}>{verdict.label}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section ref={researchRef} className="pool-leak-panel pool-leak-research" aria-labelledby="pool-leak-research-title">
        <div className="pool-leak-section-heading">
          <div>
            <span>STEP 3</span>
            <h2 id="pool-leak-research-title">具体尺寸研究</h2>
            <p>从上方选择一个 Spot，这里会拆开同一节点的全部下注尺寸。</p>
          </div>
        </div>

        {!selectedOverview || researchRows.length === 0 ? (
          <div className="pool-leak-empty pool-leak-empty--research">
            当前筛选没有达到样本门槛的 Spot。请降低样本门槛或放宽条件；小样本不会被用于漏洞结论。
          </div>
        ) : (
          <>
            <div className="pool-leak-spot-summary">
              <div>
                <span>{selectedOverview.p === '5BP' ? '5BP+' : selectedOverview.p} · {STREET_NAMES[selectedOverview.s] || selectedOverview.s}</span>
                <h3>{ROLE_NAMES[selectedOverview.r] || selectedOverview.r} · {selectedOverview.c}</h3>
                <p>
                  {FAMILY_NAMES[selectedOverview.a] || selectedOverview.a} · <code>{selectedOverview.h}</code>
                  {boardLabel(selectedOverview, boardCatalog) ? ` · ${boardLabel(selectedOverview, boardCatalog)}` : ''}
                </p>
              </div>
              <div className="pool-leak-route-copy">{decodeRoute(selectedOverview.h)}</div>
            </div>

            <div className={`pool-leak-action-callout${best ? ' has-signal' : ''}`}>
              {researchSummary.eligible.length === 0
                ? `当前最低样本为 ${formatNumber(filters.minimumSample)}，这个 Spot 没有细分尺寸达到门槛。下表仅供探索，不能据此选择利用尺寸。`
                : best
                  ? `${rowSizeLabel(best)} 的过度弃牌证据最强：对手实际弃牌 ${formatPercent(best.f)}，该尺寸的盈亏平衡弃牌率为 ${formatPercent(1 - finiteNumber(best.m))}，保守仍多弃 ${formatPercentagePoints(finiteNumber(best.m) - finiteNumber(best.hi))}。先在相同牌面和 SPR 下复核，再决定是否扩大诈唬。`
                  : '当前达标尺寸没有同时满足显著性和至少 3 个百分点差异的过度弃牌证据，不建议仅凭这组数据扩大诈唬。'}
            </div>

            <div className="pool-leak-metric-grid">
              <article>
                <span>{best ? '优先研究尺寸' : '最大样本参考尺寸'}</span>
                <strong>{priority ? rowSizeLabel(priority) : '—'}</strong>
                <small>{priority ? `${ratioLabel(priority)} ${actualSizeRange(priority)}` : ''}</small>
              </article>
              <article>
                <span>对手实际弃牌</span>
                <strong>{priority ? formatPercent(priority.f) : '—'}</strong>
                <small>{priority ? `盈亏平衡 ${formatPercent(1 - finiteNumber(priority.m))}` : ''}</small>
              </article>
              <article>
                <span>保守多弃</span>
                <strong className={best ? 'is-negative' : ''}>{best ? formatPercentagePoints(finiteNumber(best.m) - finiteNumber(best.hi)) : '—'}</strong>
                <small>{best ? `实际多弃 ${formatPercentagePoints(finiteNumber(best.m) - finiteNumber(best.d))}` : '暂无可信尺寸'}</small>
              </article>
              <article>
                <span>该尺寸样本</span>
                <strong>{priority ? formatNumber(priority.n) : '—'}</strong>
                <small>{priority ? `置信度${confidenceFor(priority, filters.minimumSample).label}` : ''}</small>
              </article>
            </div>

            <div className="pool-leak-table-wrap" tabIndex="0" aria-label="所选 Spot 的尺寸研究，可横向滚动">
              <table className="pool-leak-table pool-leak-size-table">
                <caption className="pool-leak-sr-only">所选 Spot 按下注尺寸拆分的防守数据</caption>
                <thead>
                  <tr>
                    <th scope="col">尺寸</th>
                    <th scope="col">样本</th>
                    <th scope="col">Fold</th>
                    <th scope="col">Call</th>
                    <th scope="col">Raise</th>
                    <th scope="col">总防守</th>
                    <th scope="col">MDF</th>
                    <th scope="col">Gap</th>
                    <th scope="col">保守多弃</th>
                    <th scope="col">置信度</th>
                    <th scope="col">判断</th>
                  </tr>
                </thead>
                <tbody>
                  {researchRows.map((row) => {
                    const gap = Number.isFinite(Number(row?.g)) ? Number(row.g) : finiteNumber(row?.d) - finiteNumber(row?.m);
                    const conservative = finiteNumber(row?.m) - finiteNumber(row?.hi);
                    const confidence = confidenceFor(row, filters.minimumSample);
                    const action = actionVerdict(row, filters.minimumSample);
                    return (
                      <tr
                        key={`${spotKey(row)}|${row?.z}`}
                        className={`${best?.z === row?.z ? 'is-priority ' : ''}${finiteNumber(row?.n) < filters.minimumSample ? 'is-sparse' : ''}`.trim()}
                      >
                        <td><strong>{rowSizeLabel(row)}</strong><small>{actualSizeRange(row)}</small></td>
                        <td>{formatNumber(row?.n)}</td>
                        <td>{formatPercent(row?.f)}</td>
                        <td>{formatPercent(row?.ca)}</td>
                        <td>{formatPercent(row?.ra)}</td>
                        <td>{formatPercent(row?.d)}</td>
                        <td>{formatPercent(row?.m)}</td>
                        <td className={gap < 0 ? 'is-negative' : 'is-positive'}>{formatPercentagePoints(gap)}</td>
                        <td className={conservative > 0 ? 'is-negative' : ''}>{conservative > 0 ? formatPercentagePoints(conservative) : '—'}</td>
                        <td><span className={`pool-leak-confidence is-${confidence.tone}`} title={confidence.title}>{confidence.label}</span></td>
                        <td><span className={`pool-leak-verdict is-${action.tone}`}>{action.label}</span></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="pool-leak-caution">
              这是同类历史牌局的相关性信号，不是理论最优尺寸。不同尺寸可能对应不同牌面、范围和 SPR；极端超池档常混有全下，默认不参与优先尺寸判断。
            </p>
          </>
        )}
      </section>
    </main>
  );
}
