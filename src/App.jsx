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

  return (
    <div className="page">
      <header>
        <div>
          <p className="eyebrow">GG Zoom · 100bb</p>
          <h1>Preflop Range Lab</h1>
          <p className="subtext">快速查看 GTO 基准并根据对手画像自动调整</p>
        </div>
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
              <h2>{payload.base.meta.position} · {payload.base.meta.actionTree}</h2>
              <p>{payload.base.meta.game} · {payload.base.meta.stack}</p>
              <p>对手：{payload.profile?.label ?? '未指定'}</p>
            </div>
            <div className="mode-switch">
              <button
                type="button"
                className={viewMode === 'base' ? 'active' : ''}
                onClick={() => setViewMode('base')}
              >
                纯 GTO
              </button>
              <button
                type="button"
                className={viewMode === 'adjusted' ? 'active' : ''}
                onClick={() => setViewMode('adjusted')}
              >
                已调整
              </button>
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
    </div>
  );
}

export default App;
