import { useEffect, useId, useRef } from 'react';

export function ArchiveConsentDialog({
  open,
  handCount = 0,
  authenticated = false,
  previouslyAccepted = false,
  hasSavedCopies = false,
  saving = false,
  busy = false,
  error = '',
  onAccept,
  onLocalOnly,
  onDeleteCopies,
  onClose
}) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef(null);

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

  const recognizedHandCount = Math.max(0, Number(handCount) || 0);

  const handleKeyDown = (event) => {
    if (event.key === 'Escape' && onClose && !busy) {
      event.preventDefault();
      onClose();
      return;
    }

    if (event.key !== 'Tab') return;
    const focusable = dialogRef.current?.querySelectorAll(
      'a[href], button:not(:disabled), [tabindex]:not([tabindex="-1"])'
    );
    if (!focusable?.length) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className="archive-consent-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose?.();
      }}
    >
      <section
        ref={dialogRef}
        className="archive-consent-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <header className="archive-consent-header">
          <div>
            <span>K2note DATA CONTRIBUTION</span>
            <h2 id={titleId}>保存牌谱副本并继续分析</h2>
          </div>
          {onClose && (
            <button
              type="button"
              className="archive-consent-close"
              aria-label={previouslyAccepted ? '关闭设置' : '关闭；本次仅在本地分析'}
              disabled={busy}
              onClick={onClose}
            >×</button>
          )}
        </header>

        <div className="archive-consent-summary" aria-label="本次牌谱摘要">
          <div>
            <span>本次已识别</span>
            <strong>{recognizedHandCount.toLocaleString()} 手牌</strong>
          </div>
          <div>
            <span>保存身份</span>
            <strong>{authenticated ? '当前登录账号' : '匿名设备身份'}</strong>
          </div>
        </div>

        <p id={descriptionId} className="archive-consent-lead">
          如果你选择同意，K2note 会把本次及之后新导入的已识别 GGPoker 原始牌谱副本默认保存到云端，其中可能包含玩家名、行动、输赢等内容，用于长期数据分析和改进产品。
        </p>

        <div className="archive-consent-details">
          <strong>保存范围与用途</strong>
          <ul>
            <li>只保存已识别的 GGPoker 牌谱，不上传本地文件名或未识别内容。</li>
            <li>运营分析副本与登录用户的个人牌谱库用途分开，互不替代。</li>
            <li>
              {authenticated
                ? '本次副本会关联当前账号，用于上述运营分析用途。'
                : '无需注册；同意后会创建匿名设备身份，用于归档这份副本。'}
            </li>
            <li>你可以随时切回仅本地分析，也可以删除本设备此前保存的运营分析副本。</li>
          </ul>
        </div>

        <div className="archive-consent-choice-note">
          <i aria-hidden="true" />
          <span>是否保存由你决定。选择仅在本地分析，不影响本次牌谱解析和报告。</span>
        </div>

        <p className="archive-consent-privacy">
          继续前请阅读<a href="/?page=privacy" target="_blank" rel="noreferrer">《隐私政策》</a>，了解数据处理与你的权利。
        </p>

        {error && <div className="archive-consent-error" role="alert">{error}</div>}

        {hasSavedCopies && onDeleteCopies && (
          <button
            type="button"
            className="archive-consent-delete"
            disabled={busy}
            onClick={onDeleteCopies}
          >{busy ? '正在删除副本…' : saving ? '停止待传并删除本设备副本' : '关闭并删除本设备已保存的副本'}</button>
        )}

        <footer className="archive-consent-actions">
          <button type="button" className="archive-consent-local" disabled={busy} onClick={onLocalOnly}>
            仅在本地分析
          </button>
          <button
            type="button"
            className="archive-consent-accept"
            disabled={recognizedHandCount === 0 || saving || busy}
            onClick={onAccept}
          >
            {saving ? '正在建立安全续传任务…' : '同意并开启默认保存'}
          </button>
        </footer>
      </section>
    </div>
  );
}
