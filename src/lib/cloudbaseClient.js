const env = import.meta.env ?? {};

export const cloudbaseConfig = Object.freeze({
  envId: (env.VITE_CLOUDBASE_ENV_ID ?? '').trim(),
  region: (env.VITE_CLOUDBASE_REGION ?? 'ap-shanghai').trim(),
  accessKey: (env.VITE_CLOUDBASE_ACCESS_KEY ?? '').trim()
});

export class AuthUnavailableError extends Error {
  constructor(message = '登录服务尚未配置。') {
    super(message);
    this.name = 'AuthUnavailableError';
    this.code = 'auth/unavailable';
  }
}

export class AuthRequestError extends Error {
  constructor(message, code = 'auth/request-failed') {
    super(message);
    this.name = 'AuthRequestError';
    this.code = code;
  }
}

const configured = Boolean(cloudbaseConfig.envId && cloudbaseConfig.accessKey);
const pendingOtp = new Map();

let app = null;
let auth = null;
let database = null;
let initializePromise = null;

async function ensureInitialized() {
  if (!configured) return null;
  if (app) return app;
  if (!initializePromise) {
    initializePromise = import('@cloudbase/js-sdk').then(({ default: cloudbase }) => {
      app = cloudbase.init({
        env: cloudbaseConfig.envId,
        region: cloudbaseConfig.region,
        accessKey: cloudbaseConfig.accessKey
      });
      // 交给 CloudBase SDK 持久化登录态；业务代码不自行读写 access token。
      auth = app.auth({ persistence: 'local' });
      database = app.rdb();
      return app;
    }).catch((error) => {
      initializePromise = null;
      throw error;
    });
  }
  return initializePromise;
}

function unavailableReason() {
  if (!cloudbaseConfig.envId) return 'CloudBase 环境尚未配置，当前仍可使用免登录的本地分析。';
  if (!cloudbaseConfig.accessKey) return 'CloudBase Publishable Key 尚未配置，当前仍可使用免登录的本地分析。';
  return '';
}

function throwIfAuthUnavailable() {
  if (!auth) throw new AuthUnavailableError(unavailableReason());
}

function throwAuthError(error, fallback) {
  if (!error) return;
  const nextError = new AuthRequestError(
    error.message || fallback,
    error.errorCode || error.code || error.name || 'auth/request-failed'
  );
  nextError.status = error.status;
  nextError.retryAfter = error.retryAfter;
  nextError.cause = error;
  throw nextError;
}

function createChallengeId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function clearExpiredChallenges() {
  const now = Date.now();
  for (const [key, value] of pendingOtp) {
    if (value.expiresAt <= now) pendingOtp.delete(key);
  }
}

async function getSession() {
  if (!configured) return { user: null, session: null };
  await ensureInitialized();
  const { data, error } = await auth.getSession();
  throwAuthError(error, '读取登录状态失败。');
  return {
    session: data?.session ?? null,
    user: data?.session?.user ?? data?.user ?? null
  };
}

async function sendPhoneCode({ phone } = {}) {
  await ensureInitialized();
  throwIfAuthUnavailable();
  const { data, error } = await auth.signInWithOtp({
    phone,
    options: { shouldCreateUser: true }
  });
  throwAuthError(error, '验证码发送失败。');
  if (typeof data?.verifyOtp !== 'function') {
    throw new AuthRequestError('验证码响应无效，请稍后重试。', 'auth/invalid-response');
  }
  clearExpiredChallenges();
  const challengeId = createChallengeId();
  pendingOtp.set(challengeId, { verifyOtp: data.verifyOtp, expiresAt: Date.now() + 5 * 60 * 1000 });
  return { challengeId, expiresIn: 300 };
}

async function verifyPhoneCode({ code, challengeId } = {}) {
  await ensureInitialized();
  throwIfAuthUnavailable();
  clearExpiredChallenges();
  const challenge = pendingOtp.get(challengeId);
  if (!challenge) {
    throw new AuthRequestError('验证码会话已过期，请重新获取。', 'auth/challenge-expired');
  }
  const { data, error } = await challenge.verifyOtp({ token: code });
  throwAuthError(error, '验证码校验失败。');
  pendingOtp.delete(challengeId);
  return { user: data?.user ?? data?.session?.user ?? null, session: data?.session ?? null };
}

async function signOut() {
  if (!configured) return { user: null };
  await ensureInitialized();
  const response = await auth.signOut();
  throwAuthError(response?.error, '退出登录失败。');
  pendingOtp.clear();
  return { user: null };
}

function clearPendingOtp() {
  pendingOtp.clear();
}

function subscribe(callback) {
  if (!configured) return () => {};
  let active = true;
  let subscription = null;
  ensureInitialized().then(() => {
    if (!active || typeof auth?.onAuthStateChange !== 'function') return;
    const result = auth.onAuthStateChange((event, session, info) => {
      callback?.({
        event,
        session: session ?? null,
        user: session?.user ?? null,
        error: info?.error ?? null
      });
    });
    subscription = result?.data?.subscription ?? result?.subscription;
  }).catch((error) => {
    if (active) callback?.({ event: 'ERROR', session: null, user: null, error });
  });
  return () => {
    active = false;
    subscription?.unsubscribe?.();
  };
}

export function getCloudbaseAuthReadiness() {
  return Object.freeze({
    available: configured && cloudbaseConfig.region === 'ap-shanghai',
    mode: configured ? 'cloudbase-web-sdk' : 'guest',
    reason: !configured
      ? unavailableReason()
      : cloudbaseConfig.region !== 'ap-shanghai'
        ? '手机号登录当前仅支持 CloudBase 上海地域。'
        : '',
    envIdConfigured: Boolean(cloudbaseConfig.envId),
    region: cloudbaseConfig.region
  });
}

export function getCloudbaseDatabase() {
  if (!database) throw new AuthUnavailableError(unavailableReason());
  return database;
}

export function getCloudbaseApp() {
  if (!app) throw new AuthUnavailableError(unavailableReason());
  return app;
}

export const cloudbaseClient = Object.freeze({
  getSession,
  sendPhoneCode,
  verifyPhoneCode,
  signOut,
  clearPendingOtp,
  subscribe
});
