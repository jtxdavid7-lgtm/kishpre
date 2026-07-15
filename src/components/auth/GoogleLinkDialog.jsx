import { useEffect, useId, useRef, useState } from 'react';
import './LoginDialog.css';

const CODE_PATTERN = /^\d{6}$/;
const digitsOnly = (value) => value.replace(/\D/g, '').slice(0, 6);

export function GoogleLinkDialog({
  open,
  phoneLabel,
  onClose,
  onSendCode,
  onVerifyAndLink,
  termsHref = '/?page=terms',
  privacyHref = '/?page=privacy'
}) {
  const titleId = useId();
  const dialogRef = useRef(null);
  const [agreed, setAgreed] = useState(false);
  const [challengeId, setChallengeId] = useState('');
  const [code, setCode] = useState('');
  const [countdown, setCountdown] = useState(0);
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return undefined;
    setAgreed(false);
    setChallengeId('');
    setCode('');
    setCountdown(0);
    setSending(false);
    setVerifying(false);
    setError('');
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

  useEffect(() => {
    if (!open || countdown <= 0) return undefined;
    const timer = window.setInterval(() => setCountdown((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [countdown, open]);

  if (!open) return null;
  const busy = sending || verifying;

  const handleDialogKeyDown = (event) => {
    if (event.key === 'Escape' && !busy) {
      event.preventDefault();
      onClose?.();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...(dialogRef.current?.querySelectorAll(
      'button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
    ) ?? [])].filter((element) => element.offsetParent !== null);
    if (!focusable.length) {
      event.preventDefault();
      dialogRef.current?.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const sendCode = async () => {
    if (!agreed || busy || countdown > 0) return;
    setSending(true);
    setError('');
    try {
      const result = await onSendCode?.();
      setChallengeId(result?.challengeId ?? '');
      setCountdown(60);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '验证码发送失败，请重试。');
    } finally {
      setSending(false);
    }
  };

  const verifyAndLink = async (event) => {
    event.preventDefault();
    if (!agreed || !challengeId || !CODE_PATTERN.test(code) || busy) return;
    setVerifying(true);
    setError('');
    try {
      await onVerifyAndLink?.({ challengeId, code });
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '身份验证失败，请重试。');
      setVerifying(false);
    }
  };

  return (
    <div className="login-dialog-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onClose?.();
    }}>
      <section
        ref={dialogRef}
        className="login-dialog google-link-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={handleDialogKeyDown}
      >
        <header className="login-dialog-header">
          <div><span>ACCOUNT SECURITY</span><h2 id={titleId}>关联 Google 账号</h2></div>
          <button type="button" className="login-dialog-close" aria-label="关闭关联窗口" onClick={onClose} disabled={busy}>×</button>
        </header>

        <p className="login-dialog-intro">关联后，你可以用手机号或 Google 登录同一个 K2note 账号，原来的牌谱库和数据归属不会改变。</p>
        <div className="google-link-security-note">
          <strong>先确认是你本人</strong>
          <span>验证码将发送到当前账户绑定的手机号 {phoneLabel}。验证成功后才会前往 Google。</span>
        </div>

        <label className="login-dialog-consent">
          <input type="checkbox" checked={agreed} disabled={busy} onChange={(event) => setAgreed(event.target.checked)} />
          <span>
            我同意关联 Google，并知悉 K2note 将处理 Google 返回的账号标识、邮箱、昵称和头像（以授权内容为准）；我已阅读
            <a href={termsHref} target="_blank" rel="noreferrer">《用户协议》</a>和
            <a href={privacyHref} target="_blank" rel="noreferrer">《隐私政策》</a>
          </span>
        </label>

        <form className="google-link-form" onSubmit={verifyAndLink}>
          <button type="button" className="google-link-send" onClick={sendCode} disabled={!agreed || busy || countdown > 0}>
            {sending ? '发送中…' : countdown > 0 ? `${countdown}s 后可重发` : challengeId ? '重新发送验证码' : '发送验证码'}
          </button>
          <label className="login-dialog-field">
            <span>短信验证码</span>
            <div className="login-dialog-code">
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="6 位验证码"
                value={code}
                maxLength={6}
                disabled={!challengeId || busy}
                onChange={(event) => setCode(digitsOnly(event.target.value))}
              />
            </div>
          </label>
          <button type="submit" className="login-dialog-submit" disabled={!agreed || !challengeId || !CODE_PATTERN.test(code) || busy}>
            {verifying ? '验证并前往 Google…' : '验证并关联 Google'}
          </button>
        </form>

        {error && <div className="login-dialog-error" role="alert">{error}</div>}
        <footer><span>请使用尚未绑定其他 K2note 账户的 Google 账号。不同账户不会按邮箱自动合并。</span></footer>
      </section>
    </div>
  );
}
