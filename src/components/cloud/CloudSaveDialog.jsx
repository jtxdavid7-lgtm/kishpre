import { useEffect, useId, useRef, useState } from 'react';
import './CloudSaveDialog.css';

export function CloudSaveDialog({
  open,
  handCount = 0,
  hero = '',
  saving = false,
  progress = null,
  error = '',
  enableAutoSave = false,
  libraryName = '我的牌谱',
  onClose,
  onConfirm
}) {
  const titleId = useId();
  const dialogRef = useRef(null);
  const [confirmed, setConfirmed] = useState(false);
  const [sessionName, setSessionName] = useState('');

  useEffect(() => {
    if (!open) return undefined;
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const frame = window.requestAnimationFrame(() => dialogRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  const progressLabel = progress?.message || (progress?.total
    ? `正在保存 ${Math.min(progress.done ?? 0, progress.total).toLocaleString()} / ${progress.total.toLocaleString()} 手牌…`
    : '正在建立你的云端 session…');

  return (
    <div className="cloud-save-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !saving && onClose?.()}>
      <section
        ref={dialogRef}
        className="cloud-save-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header>
          <div><span>K2note CLOUD LIBRARY</span><h2 id={titleId}>{enableAutoSave ? '开启牌谱自动保存' : `保存到${libraryName}`}</h2></div>
          <button type="button" aria-label="关闭保存确认" disabled={saving} onClick={onClose}>×</button>
        </header>

        <div className="cloud-save-summary">
          <div><span>本次牌谱</span><strong>{handCount.toLocaleString()} 手牌</strong></div>
          <div><span>Hero</span><strong>{hero || '尚未选择'}</strong></div>
        </div>

        <label className="cloud-save-name">
          <span>Session 名称（可选）</span>
          <input
            type="text"
            maxLength={120}
            value={sessionName}
            disabled={saving}
            placeholder="例如：7 月 15 日晚场"
            onChange={(event) => setSessionName(event.target.value)}
          />
        </label>

        <div className="cloud-save-explainer">
          <strong>确认后会同步什么？</strong>
          <ul>
            <li>这 {handCount.toLocaleString()} 手牌的 GG 原始文本，便于以后重新解析和播放。</li>
            <li>牌局时间、盲注、玩家名、底牌、公共牌、行动、输赢及统计摘要。</li>
            <li>不会上传本地文件名，也不会上传未识别为受支持牌谱的内容。</li>
            {enableAutoSave && <li>本次确认后，登录状态下之后导入的受支持牌谱会自动存入“{libraryName}”；你可以随时关闭。</li>}
          </ul>
        </div>

        <label className="cloud-save-consent">
          <input type="checkbox" checked={confirmed} disabled={saving} onChange={(event) => setConfirmed(event.target.checked)} />
          <span>我确认将上述牌谱保存到“{libraryName}”{enableAutoSave ? '，并开启后续导入自动保存' : ''}，同意按<a href="/?page=privacy" target="_blank" rel="noreferrer">《隐私政策》</a>处理这些数据。</span>
        </label>

        {saving && <div className="cloud-save-progress" role="status"><i aria-hidden="true" />{progressLabel}</div>}
        {error && <div className="cloud-save-error" role="alert">{error}</div>}

        <footer>
          <button type="button" className="secondary" disabled={saving} onClick={onClose}>暂不保存</button>
          <button
            type="button"
            className="primary"
            disabled={!confirmed || !handCount || !hero || saving}
            onClick={() => onConfirm?.({ sessionName: sessionName.trim() })}
          >{saving ? '保存中…' : enableAutoSave ? '确认并开启' : '确认并保存'}</button>
        </footer>
      </section>
    </div>
  );
}
