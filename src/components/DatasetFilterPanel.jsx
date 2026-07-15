import { useId, useState } from 'react';

const DATASET_TIME_PRESETS = Object.freeze([
  { value: 'all', label: '全部' },
  { value: 'today', label: '今天' },
  { value: 'week', label: '本周' },
  { value: 'month', label: '本月' },
  { value: 'last30', label: '近 30 天' },
  { value: 'custom', label: '自定义' }
]);

const EMPTY_DATASET_FILTERS = Object.freeze({
  timePreset: 'all',
  dateFrom: '',
  dateTo: '',
  stakes: Object.freeze([]),
  gameTypes: Object.freeze([])
});

function normalizeOption(option) {
  if (typeof option === 'string' || typeof option === 'number') {
    return { value: option, label: String(option) };
  }
  return option;
}

function formatCount(value) {
  if (value === null || value === undefined) return '—';
  const count = Number(value);
  return Number.isFinite(count) ? Math.max(0, count).toLocaleString('zh-CN') : '0';
}

function MultiSelectChips({ allLabel, emptyLabel, options, selected, onToggle, onClear, disabled }) {
  const normalizedOptions = options.map(normalizeOption).filter((option) => option?.value != null);
  const selectedValues = Array.isArray(selected) ? selected : [];

  return (
    <div className="dataset-filter-chips">
      <button
        type="button"
        className={!selectedValues.length ? 'active' : ''}
        aria-pressed={!selectedValues.length}
        disabled={disabled}
        onClick={onClear}
      >
        {allLabel}
      </button>
      {normalizedOptions.map((option) => {
        const active = selectedValues.includes(option.value);
        return (
          <button
            key={String(option.value)}
            type="button"
            className={active ? 'active' : ''}
            aria-pressed={active}
            disabled={disabled || option.disabled}
            onClick={() => onToggle(option.value)}
          >
            <span>{option.label}</span>
            {Number.isFinite(Number(option.count)) && <small>{formatCount(option.count)}</small>}
          </button>
        );
      })}
      {!normalizedOptions.length && <span className="dataset-filter-empty">{emptyLabel}</span>}
    </div>
  );
}

export function DatasetFilterPanel({
  filters = EMPTY_DATASET_FILTERS,
  onChange,
  onClear,
  stakeOptions = [],
  gameTypeOptions = [],
  filteredCount = 0,
  totalCount = 0,
  disabled = false,
  title = '筛选牌谱',
  className = ''
}) {
  const [expanded, setExpanded] = useState(false);
  const bodyId = useId();
  const timePreset = filters.timePreset || 'all';
  const stakes = Array.isArray(filters.stakes) ? filters.stakes : [];
  const gameTypes = Array.isArray(filters.gameTypes) ? filters.gameTypes : [];
  const dateFrom = filters.dateFrom || '';
  const dateTo = filters.dateTo || '';
  const activeCount = (timePreset !== 'all' ? 1 : 0) + stakes.length + gameTypes.length;
  const countPending = filteredCount === null || filteredCount === undefined;

  const update = (patch) => {
    onChange?.({ ...filters, ...patch });
  };

  const toggleValue = (key, value) => {
    const current = Array.isArray(filters[key]) ? filters[key] : [];
    update({
      [key]: current.includes(value)
        ? current.filter((item) => item !== value)
        : [...current, value]
    });
  };

  const clearAll = () => {
    if (onClear) {
      onClear();
      return;
    }
    onChange?.({
      ...filters,
      timePreset: 'all',
      dateFrom: '',
      dateTo: '',
      stakes: [],
      gameTypes: []
    });
  };

  const selectTimePreset = (value) => {
    update(value === 'custom'
      ? { timePreset: value }
      : { timePreset: value, dateFrom: '', dateTo: '' });
  };

  return (
    <section className={`dataset-filter-panel${expanded ? ' is-expanded' : ' is-collapsed'}${className ? ` ${className}` : ''}`} aria-label={title}>
      <header className="dataset-filter-header">
        <div>
          <span className="dataset-filter-kicker">DATASET FILTER</span>
          <strong>{title}</strong>
          {activeCount > 0 && <em>{activeCount} 项条件</em>}
        </div>
        <div className="dataset-filter-result" aria-live="polite">
          <span>{countPending ? '应用后精确计算' : '当前结果'}</span>
          {!countPending && <strong>{formatCount(filteredCount)}</strong>}
          <small>{countPending ? `${formatCount(totalCount)} 手牌可筛选` : `/ ${formatCount(totalCount)} 手牌`}</small>
        </div>
        <div className="dataset-filter-actions">
          {activeCount > 0 && (
            <button type="button" className="dataset-filter-clear" disabled={disabled} onClick={clearAll}>
              清除全部
            </button>
          )}
          <button
            type="button"
            className="dataset-filter-toggle"
            aria-expanded={expanded}
            aria-controls={bodyId}
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? '收起筛选' : '展开筛选'}
            <i aria-hidden="true">⌄</i>
          </button>
        </div>
      </header>

      <div id={bodyId} className="dataset-filter-body">
        <fieldset className="dataset-filter-group dataset-filter-group--time" disabled={disabled}>
          <legend>时间</legend>
          <div className="dataset-filter-chips dataset-filter-time-presets">
            {DATASET_TIME_PRESETS.map((preset) => (
              <button
                key={preset.value}
                type="button"
                className={timePreset === preset.value ? 'active' : ''}
                aria-pressed={timePreset === preset.value}
                onClick={() => selectTimePreset(preset.value)}
              >
                {preset.label}
              </button>
            ))}
          </div>
          {timePreset === 'custom' && (
            <div className="dataset-filter-dates">
              <label>
                <span>开始日期</span>
                <input
                  type="date"
                  value={dateFrom}
                  max={dateTo || undefined}
                  onChange={(event) => update({ timePreset: 'custom', dateFrom: event.target.value })}
                />
              </label>
              <i aria-hidden="true">至</i>
              <label>
                <span>结束日期</span>
                <input
                  type="date"
                  value={dateTo}
                  min={dateFrom || undefined}
                  onChange={(event) => update({ timePreset: 'custom', dateTo: event.target.value })}
                />
              </label>
            </div>
          )}
        </fieldset>

        <fieldset className="dataset-filter-group" disabled={disabled}>
          <legend>级别</legend>
          <MultiSelectChips
            allLabel="全部级别"
            emptyLabel="暂无可选级别"
            options={stakeOptions}
            selected={stakes}
            disabled={disabled}
            onToggle={(value) => toggleValue('stakes', value)}
            onClear={() => update({ stakes: [] })}
          />
        </fieldset>

        <fieldset className="dataset-filter-group" disabled={disabled}>
          <legend>游戏类型</legend>
          <MultiSelectChips
            allLabel="全部类型"
            emptyLabel="暂无可选类型"
            options={gameTypeOptions}
            selected={gameTypes}
            disabled={disabled}
            onToggle={(value) => toggleValue('gameTypes', value)}
            onClear={() => update({ gameTypes: [] })}
          />
        </fieldset>
      </div>
    </section>
  );
}
