import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../auth/AuthProvider.jsx';
import {
  loadCloudLibraryHands,
  loadCloudLibraryIndex
} from '../lib/cloudLibrary.js';
import {
  acceptOperatorArchivePreference,
  archiveImportedHands,
  disableOperatorArchivePreference,
  getOperatorArchivePreference,
  resolveOperatorArchiveConsent
} from '../lib/operatorArchive.js';
import { summarizeHeroResults } from '../lib/handHistoryAnalyzer.js';
import { DatasetFilterPanel } from './DatasetFilterPanel.jsx';
import './PersonalAnalysisWorkspace.css';

const EMPTY_FILTERS = Object.freeze({
  timePreset: 'all',
  dateFrom: '',
  dateTo: '',
  stakes: Object.freeze([]),
  gameTypes: Object.freeze([])
});

function emptyFilters() {
  return { ...EMPTY_FILTERS, stakes: [], gameTypes: [] };
}

function localDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function addLocalDays(value, amount) {
  const [year, month, day] = String(value).split('-').map(Number);
  if (!year || !month || !day) return value;
  const next = new Date(year, month - 1, day);
  next.setDate(next.getDate() + amount);
  return localDateKey(next);
}

function filterDateRange(filters, now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const preset = filters.timePreset || 'all';
  if (preset === 'custom') return { from: filters.dateFrom || '', to: filters.dateTo || '' };
  if (preset === 'today') {
    const value = localDateKey(today);
    return { from: value, to: value };
  }
  if (preset === 'week') {
    const monday = new Date(today);
    const weekday = monday.getDay() || 7;
    monday.setDate(monday.getDate() - weekday + 1);
    return { from: localDateKey(monday), to: localDateKey(today) };
  }
  if (preset === 'month') {
    return { from: localDateKey(new Date(today.getFullYear(), today.getMonth(), 1)), to: localDateKey(today) };
  }
  if (preset === 'last30') {
    const start = new Date(today);
    start.setDate(start.getDate() - 29);
    return { from: localDateKey(start), to: localDateKey(today) };
  }
  return { from: '', to: '' };
}

function cloudFilters(filters) {
  const range = filterDateRange(filters);
  return {
    ...filters,
    from: range.from ? `${range.from}T00:00:00+08:00` : '',
    to: range.to ? `${addLocalDays(range.to, 1)}T00:00:00+08:00` : ''
  };
}

function percentage(value, digits = 1) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toFixed(digits)}%` : '—';
}

function signed(value, digits = 1, suffix = '') {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return `${number > 0 ? '+' : ''}${number.toFixed(digits)}${suffix}`;
}

function metricTone(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number === 0) return '';
  return number > 0 ? 'positive' : 'negative';
}

function gameTypeLabel(item) {
  if (item?.label) return item.label;
  const [variant, structure, tableType, players] = String(item?.key || '').split(':');
  return [variant, structure, tableType, players && players !== 'unknown' ? `${players}人桌` : '']
    .filter((value) => value && value !== 'unknown')
    .join(' · ') || '未知游戏类型';
}

function archiveStatusText(result) {
  if (!result) return '';
  if (result.totalCount === 0) return '当前筛选没有可分析的牌谱。';
  if (result.status === 'completed') return `贡献副本已完成去重同步，共处理 ${result.totalCount.toLocaleString()} 手牌。`;
  return `已建立安全续传任务：完成 ${Number(result.completedCount || 0).toLocaleString()}，待传 ${Number(result.queuedCount || 0).toLocaleString()} 手牌。`;
}

const DATA_GROUPS = [
  {
    title: '翻前结构',
    desc: '先展示真实频率；目标区间和诊断规则将在后续版本接入。',
    metrics: [
      ['VPIP', 'vpip'], ['PFR', 'pfr'], ['3Bet', 'threeBet'], ['Squeeze', 'squeeze'],
      ['4Bet', 'fourBet'], ['Fold to 3Bet', 'foldToThreeBet']
    ]
  },
  {
    title: '翻后表现',
    desc: '按街道拆分持续下注、面对持续下注和主动下注频率。',
    metrics: [
      ['Flop CBet', 'postflop.flop.cbet'], ['Flop FvCB', 'postflop.flop.foldToCbet'],
      ['Turn CBet', 'postflop.turn.cbet'], ['River CBet', 'postflop.river.cbet'],
      ['Flop Donk', 'postflop.flop.donk'], ['Flop Check-Raise', 'postflop.flop.checkRaise']
    ]
  },
  {
    title: '摊牌与底池',
    desc: '用到达摊牌、摊牌胜率和看翻牌后获胜率观察结果结构。',
    metrics: [['WWSF', 'wwsf'], ['WTSD', 'wtsd'], ['W$SD', 'wsd']]
  }
];

function valueAt(object, path) {
  return path.split('.').reduce((value, key) => value?.[key], object);
}

export function PersonalAnalysisWorkspace() {
  const { authStatus, isAuthenticated, openLogin } = useAuth();
  const [loadState, setLoadState] = useState('idle');
  const [library, setLibrary] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [filters, setFilters] = useState(() => emptyFilters());
  const [consent, setConsent] = useState(null);
  const [consentChoice, setConsentChoice] = useState(() => getOperatorArchivePreference());
  const [consentChecked, setConsentChecked] = useState(false);
  const [consentBusy, setConsentBusy] = useState(false);
  const [analysisState, setAnalysisState] = useState('idle');
  const [analysisHands, setAnalysisHands] = useState([]);
  const [analysisMessage, setAnalysisMessage] = useState('');
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState('overview');

  useEffect(() => {
    if (!isAuthenticated) {
      setLibrary(null);
      setSessions([]);
      setConsent(null);
      setLoadState('idle');
      return undefined;
    }

    let active = true;
    setLoadState('loading');
    setError('');
    Promise.all([
      loadCloudLibraryIndex(),
      resolveOperatorArchiveConsent().catch(() => null)
    ]).then(([index, currentConsent]) => {
      if (!active) return;
      setLibrary(index.library);
      setSessions(index.sessions);
      setConsent(currentConsent);
      setConsentChoice(currentConsent ? 'accepted' : getOperatorArchivePreference());
      setLoadState('ready');
    }).catch((requestError) => {
      if (!active) return;
      setError(requestError instanceof Error ? requestError.message : '无法读取个人牌谱库。');
      setLoadState('error');
    });
    return () => { active = false; };
  }, [isAuthenticated]);

  const totalHands = useMemo(
    () => sessions.reduce((sum, session) => sum + Number(session.handCount || 0), 0),
    [sessions]
  );
  const stakeOptions = useMemo(() => {
    const counts = new Map();
    sessions.forEach((session) => (session.summary?.stakes || []).forEach((item) => {
      const value = item?.label;
      if (value) counts.set(value, (counts.get(value) || 0) + Number(item.count || 0));
    }));
    return [...counts.entries()].map(([value, count]) => ({ value, label: value, count }));
  }, [sessions]);
  const gameTypeOptions = useMemo(() => {
    const values = new Map();
    sessions.forEach((session) => (session.summary?.gameTypes || []).forEach((item) => {
      if (!item?.key || item.analysisSupported === false) return;
      const current = values.get(item.key);
      if (current) current.count += Number(item.count || 0);
      else values.set(item.key, { value: item.key, label: gameTypeLabel(item), count: Number(item.count || 0) });
    }));
    return [...values.values()];
  }, [sessions]);
  const summary = useMemo(() => summarizeHeroResults(analysisHands), [analysisHands]);
  const accessGranted = Boolean(isAuthenticated && consent && consentChoice === 'accepted');

  const acceptAccess = async () => {
    if (!consentChecked || consentBusy) return;
    setConsentBusy(true);
    setError('');
    try {
      const nextConsent = await acceptOperatorArchivePreference();
      setConsent(nextConsent);
      setConsentChoice('accepted');
      setConsentChecked(false);
      setAnalysisMessage('高级分析权限已开启。选择样本后，K2note 会先建立去重续传任务，再生成报告。');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '无法开启高级分析权限。');
    } finally {
      setConsentBusy(false);
    }
  };

  const revokeAccess = async () => {
    if (consentBusy) return;
    if (!window.confirm('停止贡献后，高级数据分析与漏洞分析会立即锁定；免登录 Session 基础分析不受影响。确定继续吗？')) return;
    setConsentBusy(true);
    setError('');
    try {
      await disableOperatorArchivePreference();
      setConsent(null);
      setConsentChoice('local-only');
      setAnalysisHands([]);
      setAnalysisState('idle');
      setAnalysisMessage('已停止贡献，高级分析已锁定。');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '停止高级分析权限失败。');
    } finally {
      setConsentBusy(false);
    }
  };

  const runAnalysis = async () => {
    if (!library || !accessGranted || analysisState === 'loading') return;
    setAnalysisState('loading');
    setAnalysisHands([]);
    setError('');
    setAnalysisMessage('正在读取所选个人牌谱…');
    try {
      const currentConsent = await resolveOperatorArchiveConsent();
      if (!currentConsent) {
        setConsent(null);
        setConsentChoice(null);
        throw new Error('贡献授权已失效，请重新确认后再使用高级分析。');
      }
      const result = await loadCloudLibraryHands({ libraryId: library.id, filters: cloudFilters(filters) });
      if (!result.hands.length) {
        setAnalysisState('empty');
        setAnalysisMessage('当前筛选没有牌谱，请调整时间、级别或游戏类型。');
        return;
      }
      setAnalysisMessage(`正在为 ${result.hands.length.toLocaleString()} 手牌建立贡献副本…`);
      const archiveResult = await archiveImportedHands({
        hands: result.hands,
        consent: currentConsent,
        onProgress: ({ message }) => message && setAnalysisMessage(message)
      });
      if (archiveResult.status === 'cancelled') throw new Error('贡献副本任务已取消，高级分析未解锁。');
      setAnalysisHands(result.hands);
      setAnalysisState('ready');
      setAnalysisMessage(archiveStatusText(archiveResult));
    } catch (requestError) {
      setAnalysisState('error');
      setError(requestError instanceof Error ? requestError.message : '高级分析准备失败。');
    }
  };

  if (authStatus === 'loading') {
    return <section className="personal-analysis-state"><i aria-hidden="true" /><h2>正在确认登录状态…</h2></section>;
  }

  if (!isAuthenticated) {
    return (
      <section className="personal-analysis-gate personal-analysis-gate--guest">
        <div className="personal-analysis-lock" aria-hidden="true">K2</div>
        <p className="eyebrow">K2note MEMBER ANALYTICS</p>
        <h1>登录后分析你的长期牌谱</h1>
        <p>免登录用户仍可分析当前 Session；长期数据分析、漏洞分析和个性化建议只面向登录并同意贡献牌谱副本的用户。</p>
        <div className="personal-analysis-requirements">
          <span><i>1</i><strong>登录 K2note</strong><small>手机号或 Google</small></span>
          <span><i>2</i><strong>使用个人牌谱库</strong><small>只读取你的数据</small></span>
          <span><i>3</i><strong>贡献牌谱副本</strong><small>免费高级分析的条件</small></span>
        </div>
        <div className="personal-analysis-gate-actions">
          <button type="button" className="primary" onClick={() => openLogin({ returnTo: '/?tool=insights' })}>登录 / 注册并继续</button>
          <button type="button" className="secondary" onClick={() => window.location.assign('?tool=history')}>仅分析当前 Session</button>
        </div>
      </section>
    );
  }

  if (loadState === 'loading') {
    return <section className="personal-analysis-state"><i aria-hidden="true" /><h2>正在读取你的个人牌谱库…</h2></section>;
  }

  return (
    <div className="personal-analysis-workspace">
      <header className="personal-analysis-hero">
        <div>
          <p className="eyebrow">K2note PERSONAL INTELLIGENCE</p>
          <h1>个人数据分析工作台</h1>
          <p>从你的长期牌谱库选择样本，先完成贡献副本的去重同步，再生成个人数据与漏洞报告。</p>
        </div>
        <div className="personal-analysis-access-strip" aria-label="高级分析访问条件">
          <span className="complete"><i>✓</i>已登录</span>
          <span className={library && totalHands > 0 ? 'complete' : ''}><i>{library && totalHands > 0 ? '✓' : '2'}</i>个人牌谱库</span>
          <span className={accessGranted ? 'complete' : ''}><i>{accessGranted ? '✓' : '3'}</i>贡献授权</span>
        </div>
      </header>

      {error && <div className="personal-analysis-error" role="alert">{error}</div>}

      {!accessGranted && (
        <section className="personal-analysis-gate personal-analysis-gate--consent">
          <div>
            <p className="eyebrow">FREE ACCESS CONDITION</p>
            <h2>免费使用高级分析，需要贡献所分析的牌谱</h2>
            <p>K2note 会把你在高级分析中选择的已识别 GG 原始牌谱建立运营分析副本，用于玩家池研究、统计口径校验和改进产品。个人牌谱库与运营副本仍分别存储。</p>
          </div>
          <div className="personal-analysis-consent-scope">
            <strong>本次授权包含</strong>
            <ul>
              <li>所选牌谱可能包含玩家名、行动、底牌、公共牌和输赢。</li>
              <li>服务器按牌谱内容去重；重复分析不会制造重复牌谱。</li>
              <li>停止贡献后，高级分析会锁定，但 Session 基础分析继续免费可用。</li>
              <li>可按现有副本删除机制撤回并删除本设备贡献的数据。</li>
            </ul>
          </div>
          <label className="personal-analysis-consent-check">
            <input type="checkbox" checked={consentChecked} onChange={(event) => setConsentChecked(event.target.checked)} />
            <span>我已阅读<a href="/?page=privacy" target="_blank" rel="noreferrer">《隐私政策》</a>，同意将高级分析所使用的牌谱贡献给 K2note。</span>
          </label>
          <div className="personal-analysis-gate-actions">
            <button type="button" className="primary" disabled={!consentChecked || consentBusy} onClick={acceptAccess}>{consentBusy ? '正在开启…' : '同意条件并开启高级分析'}</button>
            <button type="button" className="secondary" onClick={() => window.location.assign('?tool=history')}>返回 Session 基础分析</button>
          </div>
        </section>
      )}

      {accessGranted && totalHands === 0 && (
        <section className="personal-analysis-state personal-analysis-state--empty">
          <span aria-hidden="true">＋</span>
          <h2>个人牌谱库还是空的</h2>
          <p>先导入并保存一批 GG 牌谱，之后即可在这里选择长期样本。</p>
          <button type="button" className="primary" onClick={() => window.location.assign('?tool=history')}>导入第一个 Session</button>
        </section>
      )}

      {accessGranted && totalHands > 0 && (
        <>
          <section className="personal-analysis-selector">
            <header>
              <div><span>01 · DATASET</span><h2>选择分析样本</h2></div>
              <button type="button" className="personal-analysis-revoke" disabled={consentBusy} onClick={revokeAccess}>停止贡献并锁定高级分析</button>
            </header>
            <DatasetFilterPanel
              filters={filters}
              onChange={setFilters}
              onClear={() => setFilters(emptyFilters())}
              stakeOptions={stakeOptions}
              gameTypeOptions={gameTypeOptions}
              filteredCount={analysisState === 'ready' ? analysisHands.length : null}
              totalCount={totalHands}
              title="筛选个人牌谱库"
              disabled={analysisState === 'loading'}
            />
            <div className="personal-analysis-runbar">
              <p><strong>{library?.name || '我的牌谱'}</strong><span>共 {totalHands.toLocaleString()} 手牌 · 点击后先去重贡献，再生成报告</span></p>
              <button type="button" className="primary" disabled={analysisState === 'loading'} onClick={runAnalysis}>{analysisState === 'loading' ? '正在同步并分析…' : '同步所选牌谱并分析'}</button>
            </div>
            {analysisMessage && <div className={`personal-analysis-progress personal-analysis-progress--${analysisState}`}><i aria-hidden="true" /><span>{analysisMessage}</span></div>}
          </section>

          {analysisState === 'ready' && (
            <section className="personal-analysis-report">
              <header className="personal-analysis-report-heading">
                <div><span>02 · REPORT</span><h2>{analysisHands.length.toLocaleString()} 手牌分析结果</h2></div>
                <div className="personal-analysis-tabs" role="tablist" aria-label="个人分析报告">
                  <button type="button" className={activeTab === 'overview' ? 'active' : ''} onClick={() => setActiveTab('overview')}>总览</button>
                  <button type="button" className={activeTab === 'data' ? 'active' : ''} onClick={() => setActiveTab('data')}>数据分析</button>
                  <button type="button" className={activeTab === 'leaks' ? 'active' : ''} onClick={() => setActiveTab('leaks')}>漏洞分析</button>
                </div>
              </header>

              {activeTab === 'overview' && (
                <>
                  <div className="personal-analysis-kpis">
                    <article><span>样本</span><strong>{summary.totalHands.toLocaleString()}</strong><small>手牌</small></article>
                    <article><span>累计输赢</span><strong className={metricTone(summary.totalProfitBB)}>{signed(summary.totalProfitBB, 1, ' BB')}</strong><small>水后结果</small></article>
                    <article><span>百手盈利</span><strong className={metricTone(summary.bbPer100)}>{signed(summary.bbPer100, 2)}</strong><small>BB / 100</small></article>
                    <article><span>VPIP / PFR</span><strong>{percentage(summary.vpip, 1)} <i>/</i> {percentage(summary.pfr, 1)}</strong><small>翻前结构</small></article>
                    <article><span>3Bet</span><strong>{percentage(summary.threeBet, 1)}</strong><small>{summary.facingThreeBet.toLocaleString()} 次机会</small></article>
                    <article><span>WWSF</span><strong>{percentage(summary.wwsf, 1)}</strong><small>{summary.sawFlopCount.toLocaleString()} 次看翻牌</small></article>
                  </div>
                  <div className="personal-analysis-roadmap">
                    <article><span>已接入</span><h3>长期数据汇总</h3><p>当前样本的盈利、核心频率、位置和级别数据已经使用真实牌谱计算。</p></article>
                    <article><span>下一步</span><h3>诊断规则引擎</h3><p>为每项指标增加样本门槛、合理区间、偏差程度和解释文本。</p></article>
                    <article><span>下一步</span><h3>行动线漏洞排序</h3><p>按损失、频率偏差、样本可信度和可改进空间生成优先级。</p></article>
                  </div>
                </>
              )}

              {activeTab === 'data' && (
                <div className="personal-analysis-data-groups">
                  {DATA_GROUPS.map((group) => (
                    <article key={group.title}>
                      <header><div><span>LIVE DATA</span><h3>{group.title}</h3></div><small>诊断规则开发中</small></header>
                      <p>{group.desc}</p>
                      <div>{group.metrics.map(([label, path]) => <span key={path}><small>{label}</small><strong>{percentage(valueAt(summary, path), 1)}</strong></span>)}</div>
                    </article>
                  ))}
                </div>
              )}

              {activeTab === 'leaks' && (
                <div className="personal-analysis-leak-shells">
                  <article><i>01</i><span>样本可信度</span><h3>判断哪些数据值得下结论</h3><p>将结合机会次数、手数和置信区间，避免用小样本误判打法。</p><strong>接口已预留 · 规则待接入</strong></article>
                  <article><i>02</i><span>翻前漏洞</span><h3>寻找频率偏差最大的节点</h3><p>计划覆盖位置、面对动作、3Bet/4Bet、偷盲和盲注防守。</p><strong>接口已预留 · 规则待接入</strong></article>
                  <article><i>03</i><span>翻后漏洞</span><h3>拆解行动线与下注尺度</h3><p>计划按街道、位置、牌面、底池类型和行动顺序定位问题。</p><strong>接口已预留 · 规则待接入</strong></article>
                  <article><i>04</i><span>优先改进</span><h3>把问题转成复盘清单</h3><p>最终将按预估损失、可信度和可执行性输出优先级。</p><strong>接口已预留 · 规则待接入</strong></article>
                </div>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}
