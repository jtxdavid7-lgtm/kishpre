import { useEffect, useId, useRef, useState } from 'react';
import './LoginDialog.css';

const PHONE_PATTERN = /^1[3-9]\d{9}$/;
const CODE_PATTERN = /^\d{6}$/;
const PASSWORD_PATTERN = /^(?=.{8,64}$)(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).+$/;

const digitsOnly = (value, maxLength) => value.replace(/\D/g, '').slice(0, maxLength);
const toChinaE164 = (phone) => `+86${phone}`;

function errorMessage(error) {
  const code = String(error?.code ?? '').toLowerCase();
  const category = String(error?.category ?? '').toUpperCase();
  const message = String(error?.message ?? '');
  if (code === 'auth/unavailable') return error.message;
  if (error?.status === 429 || code === 'resource_exhausted' || category === 'RATE_LIMITED') {
    return error?.retryAfter ? `操作太频繁，请在 ${error.retryAfter} 秒后重试。` : '操作太频繁，请稍后再试。';
  }
  if (code === 'rate_limited') return '验证码请求过于频繁，请稍后再试。';
  if (code === 'captcha_required' || category === 'CAPTCHA_REQUIRED') return '当前请求需要安全验证，请稍后重试或更换网络。';
  if (code === 'auth/weak-password' || /weak_password|password_too_weak|密码强度/i.test(`${code} ${message}`)) {
    return '密码需为 8–64 位，并包含大小写字母、数字和特殊字符。';
  }
  if (
    category === 'INVALID_CREDENTIALS'
    || category === 'USER_NOT_FOUND'
    || /invalid_(password|credentials|username_or_password)|password_not_set|user.*not found/i.test(`${code} ${message}`)
  ) {
    return '手机号或密码错误。首次使用或忘记密码，请切换到“注册 / 重置密码”。';
  }
  if (/login_type_disabled|login_method_disabled|username.*password.*disabled|账号密码.*未开启/i.test(`${code} ${message}`)) {
    return '手机号密码登录尚未开启，请稍后再试。';
  }
  if (code === 'invalid_argument') return '请检查手机号、验证码或密码。';
  if (/provider.*(disabled|not found|not enabled)|身份源.*(未开启|不存在)/i.test(message)) {
    return 'Google 登录身份源尚未开启，请稍后再试。';
  }
  if (/already.*(linked|bound)|已经.*(关联|绑定)/i.test(message)) {
    return '这个 Google 账号已经关联到另一个 K2note 账户。';
  }
  if (/access_denied|cancel/i.test(message)) return '你已取消 Google 授权。';
  return error?.message || '登录失败，请稍后再试。';
}

export function LoginDialog({
  open,
  available = false,
  phoneAvailable = false,
  googleAvailable = false,
  googleDisabledReason = '',
  unavailableReason = '',
  onClose,
  onGoogleLogin,
  onPasswordLogin,
  onBeginPasswordSetup,
  onCompletePasswordSetup,
  termsHref = '#terms',
  privacyHref = '#privacy'
}) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef(null);
  const phoneInputRef = useRef(null);
  const [mode, setMode] = useState('password');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [code, setCode] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [challengeId, setChallengeId] = useState(null);
  const [codeSent, setCodeSent] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [sending, setSending] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return undefined;
    setMode('password');
    setPhone('');
    setPassword('');
    setConfirmPassword('');
    setCode('');
    setAgreed(false);
    setChallengeId(null);
    setCodeSent(false);
    setCountdown(0);
    setSending(false);
    setSubmitting(false);
    setGoogleLoading(false);
    setError('');

    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const frame = window.requestAnimationFrame(() => {
      const desktop = window.matchMedia?.('(min-width: 561px)').matches;
      if (desktop && !googleAvailable) phoneInputRef.current?.focus();
      else dialogRef.current?.focus();
    });

    return () => {
      window.cancelAnimationFrame(frame);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus?.();
    };
  }, [googleAvailable, open]);

  useEffect(() => {
    if (!open || countdown <= 0) return undefined;
    const timer = window.setInterval(() => {
      setCountdown((value) => Math.max(0, value - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [countdown, open]);

  if (!open) return null;

  const phoneValid = PHONE_PATTERN.test(phone);
  const passwordValid = PASSWORD_PATTERN.test(password);
  const passwordsMatch = password === confirmPassword;
  const codeValid = CODE_PATTERN.test(code);
  const busy = sending || submitting || googleLoading;

  const resetChallenge = () => {
    setCode('');
    setChallengeId(null);
    setCodeSent(false);
    setCountdown(0);
  };

  const switchMode = (nextMode) => {
    if (busy || nextMode === mode) return;
    setMode(nextMode);
    setError('');
    resetChallenge();
    if (nextMode === 'password') setConfirmPassword('');
    window.requestAnimationFrame(() => phoneInputRef.current?.focus());
  };

  const handleGoogleLogin = async () => {
    if (!googleAvailable || googleDisabledReason || !agreed || busy) return;
    setGoogleLoading(true);
    setError('');
    try {
      await onGoogleLogin?.();
    } catch (requestError) {
      setError(errorMessage(requestError));
      setGoogleLoading(false);
    }
  };

  const handlePasswordLogin = async (event) => {
    event.preventDefault();
    if (!phoneAvailable || !phoneValid || !password || !agreed || busy) return;
    setSubmitting(true);
    setError('');
    try {
      await onPasswordLogin?.({ phone: toChinaE164(phone), password });
    } catch (requestError) {
      setError(errorMessage(requestError));
      setSubmitting(false);
    }
  };

  const handleSendCode = async () => {
    if (
      !phoneAvailable
      || !phoneValid
      || !passwordValid
      || !passwordsMatch
      || !agreed
      || busy
      || countdown > 0
    ) return;
    setSending(true);
    setError('');
    try {
      const result = await onBeginPasswordSetup?.({
        phone: toChinaE164(phone),
        password
      });
      setChallengeId(result?.challengeId ?? null);
      setCodeSent(true);
      setCountdown(60);
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setSending(false);
    }
  };

  const handlePasswordSetup = async (event) => {
    event.preventDefault();
    if (
      !phoneAvailable
      || !phoneValid
      || !passwordValid
      || !passwordsMatch
      || !codeValid
      || !codeSent
      || !agreed
      || busy
    ) return;
    setSubmitting(true);
    setError('');
    try {
      await onCompletePasswordSetup?.({
        phone: toChinaE164(phone),
        password,
        code,
        challengeId
      });
    } catch (requestError) {
      setError(errorMessage(requestError));
      setSubmitting(false);
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

  const phoneField = (
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
          disabled={!phoneAvailable || codeSent || busy}
          onChange={(event) => setPhone(digitsOnly(event.target.value, 11))}
          aria-invalid={Boolean(phone) && !phoneValid}
        />
        {codeSent && (
          <button
            type="button"
            className="login-dialog-edit"
            onClick={() => {
              resetChallenge();
              setError('');
            }}
            disabled={busy}
          >修改</button>
        )}
      </div>
    </label>
  );

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
            <span>K2note ACCOUNT</span>
            <h2 id={titleId}>登录 K2note</h2>
          </div>
          <button type="button" className="login-dialog-close" aria-label="关闭登录" onClick={onClose} disabled={busy}>×</button>
        </header>

        <p id={descriptionId} className="login-dialog-intro">
          手机号注册时设置一次密码，之后直接使用手机号和密码登录；也可以使用 Google 账号。
        </p>

        {!available && (
          <div className="login-dialog-notice" role="status">
            <strong>登录功能正在配置</strong>
            <span>{unavailableReason || '当前仍可继续使用本地牌谱分析。'}</span>
          </div>
        )}

        <label className="login-dialog-consent">
          <input
            type="checkbox"
            checked={agreed}
            disabled={!available || busy}
            onChange={(event) => setAgreed(event.target.checked)}
          />
          <span>
            我已阅读并同意 <a href={termsHref} target="_blank" rel="noreferrer">《用户协议》</a> 和{' '}
            <a href={privacyHref} target="_blank" rel="noreferrer">《隐私政策》</a>，知悉登录后可开启个人牌谱库自动保存
          </span>
        </label>

        <button
          type="button"
          className="login-dialog-google"
          disabled={!googleAvailable || Boolean(googleDisabledReason) || !agreed || busy}
          onClick={handleGoogleLogin}
        >
          <i aria-hidden="true">G</i>
          <span>{googleLoading ? '正在前往 Google…' : '使用 Google 账号继续'}</span>
        </button>

        {googleDisabledReason && (
          <div className="login-dialog-google-warning" role="note">
            <strong>请先保留当前分析结果</strong>
            <span>{googleDisabledReason}</span>
          </div>
        )}

        {googleAvailable && (
          <p className="login-dialog-account-warning">
            已有手机号牌谱的用户，请先用手机号登录，再在账户区关联 Google；直接使用 Google 登录会创建独立账户。
          </p>
        )}

        {googleAvailable && phoneAvailable && <div className="login-dialog-divider"><span>或使用中国大陆手机号</span></div>}

        <div className="login-dialog-tabs" role="tablist" aria-label="手机号登录方式">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'password'}
            className={mode === 'password' ? 'active' : ''}
            onClick={() => switchMode('password')}
            disabled={!phoneAvailable || busy}
          >密码登录</button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'setup'}
            className={mode === 'setup' ? 'active' : ''}
            onClick={() => switchMode('setup')}
            disabled={!phoneAvailable || busy}
          >注册 / 重置密码</button>
        </div>

        {mode === 'password' ? (
          <form className="login-dialog-form" onSubmit={handlePasswordLogin}>
            {phoneField}
            <label className="login-dialog-field">
              <span>密码</span>
              <input
                className="login-dialog-password"
                type="password"
                autoComplete="current-password"
                placeholder="输入登录密码"
                value={password}
                maxLength={64}
                disabled={!phoneAvailable || busy}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            <button
              type="submit"
              className="login-dialog-submit"
              disabled={!phoneAvailable || !phoneValid || !password || !agreed || busy}
            >
              {submitting ? '登录中…' : '手机号密码登录'}
            </button>
            <button type="button" className="login-dialog-mode-link" onClick={() => switchMode('setup')} disabled={busy}>
              首次使用或忘记密码？用验证码设置
            </button>
          </form>
        ) : (
          <form className="login-dialog-form" onSubmit={handlePasswordSetup}>
            <div className="login-dialog-setup-note">
              新手机号会创建账户；已注册手机号会安全重置密码。两种情况都只需本次短信验证码。
            </div>
            {phoneField}
            <label className="login-dialog-field">
              <span>设置密码</span>
              <input
                className="login-dialog-password"
                type="password"
                autoComplete="new-password"
                placeholder="8–64 位强密码"
                value={password}
                maxLength={64}
                disabled={!phoneAvailable || codeSent || busy}
                onChange={(event) => setPassword(event.target.value)}
                aria-invalid={Boolean(password) && !passwordValid}
              />
              <small>需包含大写字母、小写字母、数字和特殊字符。</small>
            </label>
            <label className="login-dialog-field">
              <span>确认密码</span>
              <input
                className="login-dialog-password"
                type="password"
                autoComplete="new-password"
                placeholder="再次输入密码"
                value={confirmPassword}
                maxLength={64}
                disabled={!phoneAvailable || codeSent || busy}
                onChange={(event) => setConfirmPassword(event.target.value)}
                aria-invalid={Boolean(confirmPassword) && !passwordsMatch}
              />
              {confirmPassword && !passwordsMatch && <small className="login-dialog-field-error">两次输入的密码不一致。</small>}
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
                  disabled={!phoneAvailable || !codeSent || busy}
                  onChange={(event) => setCode(digitsOnly(event.target.value, 6))}
                />
                <button
                  type="button"
                  onClick={handleSendCode}
                  disabled={!phoneAvailable || !phoneValid || !passwordValid || !passwordsMatch || !agreed || busy || countdown > 0}
                >
                  {sending ? '发送中…' : countdown > 0 ? `${countdown}s` : codeSent ? '重新发送' : '获取验证码'}
                </button>
              </div>
            </label>
            {codeSent && !error && (
              <div className="login-dialog-sent" role="status" aria-live="polite">
                验证码已发送，请在 5 分钟内完成设置。
              </div>
            )}
            <button
              type="submit"
              className="login-dialog-submit"
              disabled={!phoneAvailable || !phoneValid || !passwordValid || !passwordsMatch || !codeSent || !codeValid || !agreed || busy}
            >
              {submitting ? '设置中…' : '完成注册 / 重置密码'}
            </button>
          </form>
        )}

        {error && <div className="login-dialog-error" role="alert">{error}</div>}

        <footer>
          <span>密码与短信验证码仅交由腾讯云 CloudBase 完成身份认证，K2note 不保存明文密码。</span>
          {googleAvailable && <span>Google 授权会离开并刷新当前页面；如已导入未保存牌谱，请先登录后再导入。</span>}
        </footer>
      </section>
    </div>
  );
}
