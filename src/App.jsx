import { useMemo, useState } from 'react';
import { RangeMatrix } from './components/RangeMatrix.jsx';
import { BASE_RANGES } from './data/base';
import { PROFILES } from './data/profiles';
import { getRangePayload } from './lib/rangeEngine';
import './App.css';

const sceneOptions = Object.values(BASE_RANGES).map((range) => ({
  value: range.key,
  label: `${range.meta.position} · ${range.meta.actionTree}`
}));

const profileOptions = Object.values(PROFILES).map((profile) => ({
  value: profile.key,
  label: profile.label
}));

const featureCards = [
  {
    label: 'Range Lab',
    title: '实时范围实验室',
    desc: '查看基准 GTO 范围并按照对手画像自动调整，定位 exploit 机会。'
  },
  {
    label: 'Reports',
    title: 'Hand History 工具',
    desc: '整理关键牌局、输出复盘报告。即将上线。'
  },
  {
    label: 'Community',
    title: 'Kish 俱乐部',
    desc: '和常驻成员一起讨论高压局面，分享策略灵感。'
  }
];

function App() {
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

  const scrollToRange = () => {
    document.querySelector('#range-lab')?.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <div className="site">
      <nav className="top-nav">
        <div className="brand">KISHPOKER</div>
        <ul>
          <li><a href="#range-lab">Range Lab</a></li>
          <li><a href="https://github.com/jtxdavid7-lgtm/kishpre" target="_blank" rel="noreferrer">GitHub</a></li>
        </ul>
      </nav>

      <header className="hero">
        <div>
          <p className="eyebrow">欢迎来到</p>
          <h1>kishpoker</h1>
          <p>一个围绕精确决策打造的扑克实验室：从 preflop 范围、对手画像到牌局复盘，所有工具都汇聚在同一个主页。</p>
        </div>
        <div className="cta-row">
          <button type="button" className="primary" onClick={scrollToRange}>打开范围实验室</button>
          <button
            type="button"
            className="secondary"
            onClick={() => window.open('https://www.kishpoker.cn', '_blank')}
          >访问线上站点</button>
        </div>
      </header>

      <section>
        <div className="section-title">
          <h2>工具入口</h2>
          <span className="subtext">持续扩展中</span>
        </div>
        <div className="feature-grid">
          {featureCards.map((feature) => (
            <article key={feature.label} className="feature-card">
              <span>{feature.label}</span>
              <h3>{feature.title}</h3>
              <p>{feature.desc}</p>
            </article>
          ))}
        </div>
      </section>

      <section id="range-lab" className="range-panel">
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

export default App;
