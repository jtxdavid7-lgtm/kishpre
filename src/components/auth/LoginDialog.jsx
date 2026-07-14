import { useEffect, useId, useRef, useState } from 'react';
import './LoginDialog.css';

const PHONE_PATTERN = /^1[3-9]\d{9}$/;
const CODE_PATTERN = /^\d{6}$/;

const digitsOnly = (value, maxLength) => value.replace(/\D/g, '').slice(0, maxLength);
const toChinaE164 = (phone) => `+86${phone}`;

function withTimeout(promise, milliseconds = 30000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = window.setTimeout(() => {
      const error = new Error('请求超时，请检查网络后重试。');
      error.code = 'auth/timeout';
      reject(error);
    }, milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => window.clearTimeout(timer));
}

function errorMessage(error) {
  if (error?.code === 'auth/unavailable') return error.message;
  if (error?.status === 429 || error?.code === 'resource_exhausted') {
    return error?.retryAfter ? `操作太频繁，请在 ${error.retryAfter} 秒后重试。` : '操作太频繁，请稍后再试。';
  }
  if (error?.code === 'RATE_LIMITED') return '验证码请求过于频繁，请稍后再试。';
  if (error?.code === 'CAPTCHA_REQUIRED') return '当前请求需要安全验证，请稍后重试或更换网络。';
  if (error?.code === 'invalid_argument') return '请检查手机号或验证码。';
  return error?.message || '登录失败，请稍后再试。';
}

export function LoginDialog({
  open,
  available = false,
  unavailableReason = '',
  onClose,
  onSendCode,
  onVerifyCode,
  onSuccess,
  termsHref = '#terms',
  privacyHref = '#privacy'
}) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef(null);
  const phoneInputRef = useRef(null);
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [challengeId, setChallengeId] = useState(null);
  const [codeSent, setCodeSent] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return undefined;
    setPhone('');
    setCode('');
    setAgreed(false);
    setChallengeId(null);
    setCodeSent(false);
    setCountdown(0);
    setSending(false);
    setVerifying(false);
    setError('');

    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const frame = window.requestAnimationFrame(() => phoneInputRef.current?.focus());

    return () => {
      window.cancelAnimationFrame(frame);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus?.();
    };
  }, [open]);

  useEffect(() => {
    if (!open || countdown <= 0) return undefined;
    const timer = window.setInterval(() => {
      setCountdown((value) => Math.max(0, value - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [countdown, open]);

  if (!open) return null;

  const phoneValid = PHONE_PATTERN.test(phone);
  const codeValid = CODE_PATTERN.test(code);
  const busy = sending || verifying;

  const handleSendCode = async () => {
    if (!available || !phoneValid || !agreed || sending || countdown > 0) return;
    setSending(true);
    setError('');
    try {
      const result = await withTimeout(onSendCode?.({ phone: toChinaE164(phone) }));
      setChallengeId(result?.challengeId ?? null);
      setCodeSent(true);
      setCountdown(60);
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setSending(false);
    }
  };

  const handleVerify = async (event) => {
    event.preventDefault();
    if (!available || !phoneValid || !codeValid || !codeSent || !agreed || verifying) return;
    setVerifying(true);
    setError('');
    try {
      const result = await withTimeout(onVerifyCode?.({
        phone: toChinaE164(phone),
        code,
        challengeId
      }));
      await onSuccess?.(result);
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setVerifying(false);
    }
  };

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

  return (
    <div
      className="login-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose?.();
      }}
    >
      <section
        ref={dialogRef}
        className="login-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        onKeyDown={handleDialogKeyDown}
      >
        <header className="login-dialog-header">
          <div>
            <span>KISH2NOTE ACCOUNT</span>
            <h2 id={titleId}>登录 Kish2Note</h2>
          </div>
          <button type="button" className="login-dialog-close" aria-label="关闭登录" onClick={onClose} disabled={busy}>×</button>
        </header>

        <p id={descriptionId} className="login-dialog-intro">
          使用中国大陆手机号登录。登录只建立账户，不会上传任何牌谱；保存牌谱时会再次请你确认。
        </p>

        {!available && (
          <div className="login-dialog-notice" role="status">
            <strong>登录功能正在配置</strong>
            <span>{unavailableReason || '当前仍可继续使用本地牌谱分析。'}</span>
          </div>
        )}

        <form className="login-dialog-form" onSubmit={handleVerify}>
          <label className="login-dialog-field">
            <span>手机号</span>
            <div className="login-dialog-phone">
              <i aria-hidden="true">+86</i>
              <input
                ref={phoneInputRef}
                type="tel"
                inputMode="numeric"
                autoComplete="tel-national"
                placeholder="138 0000 0000"
                value={phone}
                maxLength={11}
                disabled={!available || codeSent || busy}
                onChange={(event) => setPhone(digitsOnly(event.target.value, 11))}
                aria-invalid={Boolean(phone) && !phoneValid}
              />
              {codeSent && (
                <button
                  type="button"
                  className="login-dialog-edit"
                  onClick={() => {
                    setCodeSent(false);
                    setCode('');
                    setChallengeId(null);
                    setCountdown(0);
                    setError('');
                  }}
                  disabled={busy}
                >修改</button>
              )}
            </div>
          </label>

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
                disabled={!available || !codeSent || verifying}
                onChange={(event) => setCode(digitsOnly(event.target.value, 6))}
              />
              <button
                type="button"
                onClick={handleSendCode}
                disabled={!available || !phoneValid || !agreed || sending || countdown > 0}
              >
                {sending ? '发送中…' : countdown > 0 ? `${countdown}s` : codeSent ? '重新发送' : '获取验证码'}
              </button>
            </div>
          </label>

          <label className="login-dialog-consent">
            <input
              type="checkbox"
              checked={agreed}
              disabled={!available || codeSent || busy}
              onChange={(event) => setAgreed(event.target.checked)}
            />
            <span>
              我已阅读并同意 <a href={termsHref} target="_blank" rel="noreferrer">《用户协议》</a> 和{' '}
              <a href={privacyHref} target="_blank" rel="noreferrer">《隐私政策》</a>
            </span>
          </label>

          {error && <div className="login-dialog-error" role="alert">{error}</div>}
          {codeSent && !error && <div className="login-dialog-sent" role="status" aria-live="polite">验证码已发送，请在 5 分钟内完成登录。</div>}

          <button
            type="submit"
            className="login-dialog-submit"
            disabled={!available || !phoneValid || !codeSent || !codeValid || !agreed || verifying}
          >
            {verifying ? '登录中…' : '登录 / 注册'}
          </button>
        </form>

        <footer>未注册的手机号将在验证成功后自动创建账户。</footer>
      </section>
    </div>
  );
}
