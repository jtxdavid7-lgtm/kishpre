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
const GOOGLE_PROVIDER = 'google';
const OAUTH_BIND_IDENTITY = 'bind_identity';
const pendingOtp = new Map();
const pendingPhonePassword = new Map();
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const PHONE_PATTERN = /^\+86\s?(?:1[3-9]\d{9})$/;
const PASSWORD_PATTERN = /^(?=.{8,64}$)(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).+$/;

let app = null;
let auth = null;
let database = null;
let initializePromise = null;
let archiveSessionPromise = null;

async function ensureInitialized() {
  if (!configured) return null;
  if (app) return app;
  if (!initializePromise) {
    initializePromise = import('@cloudbase/js-sdk').then(({ default: cloudbase }) => {
      app = cloudbase.init({
        env: cloudbaseConfig.envId,
        region: cloudbaseConfig.region,
        accessKey: cloudbaseConfig.accessKey,
        // OAuth 回调由 AuthProvider 在核对 state、TTL 和目标 UID 后手动消费。
        auth: { detectSessionInUrl: false }
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
  nextError.category = error.category;
  nextError.errorCode = error.errorCode;
  nextError.cause = error;
  throw nextError;
}

function normalizeChinaPhone(phone) {
  const normalizedPhone = String(phone ?? '').trim();
  if (!PHONE_PATTERN.test(normalizedPhone)) {
    throw new AuthRequestError('请输入有效的中国大陆手机号。', 'auth/invalid-phone');
  }
  return normalizedPhone.replace(/^\+86\s?/, '+86 ');
}

function validateNewPassword(password) {
  if (!PASSWORD_PATTERN.test(String(password ?? ''))) {
    throw new AuthRequestError('密码需为 8–64 位，并包含大小写字母、数字和特殊字符。', 'auth/weak-password');
  }
}

function createChallengeId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function createOAuthState() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return createChallengeId();
}

function trustedOAuthRedirect(redirectTo) {
  if (typeof window === 'undefined') return undefined;
  const fallback = `${window.location.origin}${window.location.pathname}`;
  const target = new URL(redirectTo || fallback, window.location.origin);
  if (target.origin !== window.location.origin) {
    throw new AuthRequestError('Google 登录回调地址必须与当前网站同源。', 'auth/unsafe-redirect');
  }
  // OAuth provider 只接收可发送到服务端的 URL；业务 returnTo 另存 intent，成功后再恢复 hash。
  target.hash = '';
  return target.href;
}

function normalizeIdentities(response) {
  const data = response?.data;
  const candidates = [
    data,
    data?.identities,
    data?.identity,
    response?.identities,
    response?.identity
  ];
  return candidates.find(Array.isArray) ?? [];
}

function clearExpiredChallenges() {
  const now = Date.now();
  for (const [key, value] of pendingOtp) {
    if (value.expiresAt <= now) pendingOtp.delete(key);
  }
  for (const [key, value] of pendingPhonePassword) {
    if (value.expiresAt <= now) pendingPhonePassword.delete(key);
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

export function isAnonymousCloudbaseUser(user) {
  return user?.is_anonymous === true
    || user?.isAnonymous === true
    || String(user?.app_metadata?.provider ?? '').toLowerCase() === 'anonymous';
}

async function ensureArchiveSession() {
  if (archiveSessionPromise) return archiveSessionPromise;
  archiveSessionPromise = (async () => {
    await ensureInitialized();
    throwIfAuthUnavailable();

    const existing = await getSession();
    if (existing?.user) return existing;

    const { data, error } = await auth.signInAnonymously();
    throwAuthError(error, '无法建立游客牌谱保存身份。');
    const user = data?.user ?? data?.session?.user ?? null;
    const session = data?.session ?? null;
    if (!user || !session) {
      throw new AuthRequestError('游客牌谱保存身份响应无效，请稍后重试。', 'auth/invalid-anonymous-session');
    }
    return { user, session };
  })().finally(() => {
    archiveSessionPromise = null;
  });
  return archiveSessionPromise;
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
  pendingOtp.set(challengeId, { verifyOtp: data.verifyOtp, expiresAt: Date.now() + CHALLENGE_TTL_MS });
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

async function signInWithPhonePassword({ phone, password } = {}) {
  await ensureInitialized();
  throwIfAuthUnavailable();
  const normalizedPhone = normalizeChinaPhone(phone);
  if (!String(password ?? '')) {
    throw new AuthRequestError('请输入登录密码。', 'auth/invalid-password');
  }
  const { data, error } = await auth.signInWithPassword({ phone: normalizedPhone, password });
  throwAuthError(error, '手机号或密码错误。');
  return { user: data?.user ?? data?.session?.user ?? null, session: data?.session ?? null };
}

async function beginPhonePasswordSetup({ phone, password } = {}) {
  await ensureInitialized();
  throwIfAuthUnavailable();
  const normalizedPhone = normalizeChinaPhone(phone);
  validateNewPassword(password);
  clearExpiredChallenges();
  pendingPhonePassword.clear();
  const currentSession = await getSession();
  const anonymousToken = isAnonymousCloudbaseUser(currentSession?.user)
    ? String(currentSession?.session?.access_token ?? '')
    : '';

  const signupResponse = await auth.signUp({
    phone: normalizedPhone,
    password,
    ...(anonymousToken ? { anonymous_token: anonymousToken } : {})
  });
  throwAuthError(signupResponse?.error, '发送注册验证码失败。');
  const verify = signupResponse?.data?.verifyOtp;

  if (typeof verify !== 'function') {
    throw new AuthRequestError('验证码响应无效，请稍后重试。', 'auth/invalid-response');
  }

  const challengeId = createChallengeId();
  pendingPhonePassword.set(challengeId, {
    verify,
    expiresAt: Date.now() + CHALLENGE_TTL_MS
  });
  return { challengeId, expiresIn: 300 };
}

async function completePhonePasswordSetup({ code, challengeId, password } = {}) {
  await ensureInitialized();
  throwIfAuthUnavailable();
  clearExpiredChallenges();
  const challenge = pendingPhonePassword.get(challengeId);
  if (!challenge) {
    throw new AuthRequestError('验证码会话已过期，请重新获取。', 'auth/challenge-expired');
  }
  if (!/^\d{6}$/.test(String(code ?? ''))) {
    throw new AuthRequestError('请输入 6 位短信验证码。', 'auth/invalid-code');
  }
  validateNewPassword(password);

  const response = await challenge.verify({ token: code });
  throwAuthError(response?.error, '注册或验证登录失败。');
  pendingPhonePassword.delete(challengeId);
  const data = response?.data;
  return { user: data?.user ?? data?.session?.user ?? null, session: data?.session ?? null };
}

async function signInWithGoogle({ redirectTo, state = createOAuthState() } = {}) {
  await ensureInitialized();
  throwIfAuthUnavailable();
  const response = await auth.signInWithOAuth({
    provider: GOOGLE_PROVIDER,
    options: {
      redirectTo: trustedOAuthRedirect(redirectTo),
      state
    }
  });
  throwAuthError(response?.error, 'Google 登录发起失败。');
  return response?.data ?? response;
}

async function getUserIdentities() {
  await ensureInitialized();
  throwIfAuthUnavailable();
  const response = await auth.getUserIdentities();
  throwAuthError(response?.error, '读取账户登录方式失败。');
  return normalizeIdentities(response);
}

async function getCurrentUserId() {
  await ensureInitialized();
  throwIfAuthUnavailable();
  const response = await auth.getClaims();
  throwAuthError(response?.error, '读取账户标识失败。');
  const claims = response?.data?.claims ?? response?.claims ?? {};
  const id = String(claims.sub ?? '').trim();
  if (!id) throw new AuthRequestError('当前登录态缺少可验证的账户标识，请重新登录。', 'auth/missing-user-id');
  return id;
}

async function verifyGoogleOAuth({ code, state } = {}) {
  await ensureInitialized();
  throwIfAuthUnavailable();
  const response = await auth.verifyOAuth({
    code,
    state,
    provider: GOOGLE_PROVIDER
  });
  throwAuthError(response?.error, 'Google 回调验证失败。');
  return response?.data ?? response;
}

async function linkGoogleIdentity({ redirectTo, state = createOAuthState() } = {}) {
  await ensureInitialized();
  throwIfAuthUnavailable();
  // SDK 3.6.2 的 linkIdentity 不会透传 OAuth 错误或 redirectTo，直接调用同一底层 OAuth 流程。
  const response = await auth.signInWithOAuth({
    provider: GOOGLE_PROVIDER,
    options: {
      type: OAUTH_BIND_IDENTITY,
      redirectTo: trustedOAuthRedirect(redirectTo),
      state
    }
  });
  throwAuthError(response?.error, 'Google 账号关联发起失败。');
  return response?.data ?? response;
}

async function signOut() {
  if (!configured) return { user: null };
  await ensureInitialized();
  const response = await auth.signOut();
  throwAuthError(response?.error, '退出登录失败。');
  pendingOtp.clear();
  pendingPhonePassword.clear();
  return { user: null };
}

function clearPendingOtp() {
  pendingOtp.clear();
  pendingPhonePassword.clear();
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
  const phoneAvailable = configured && cloudbaseConfig.region === 'ap-shanghai';
  const googleAvailable = configured;
  return Object.freeze({
    available: phoneAvailable || googleAvailable,
    phoneAvailable,
    googleAvailable,
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
  ensureArchiveSession,
  sendPhoneCode,
  verifyPhoneCode,
  signInWithPhonePassword,
  beginPhonePasswordSetup,
  completePhonePasswordSetup,
  signInWithGoogle,
  getUserIdentities,
  getCurrentUserId,
  verifyGoogleOAuth,
  linkGoogleIdentity,
  signOut,
  clearPendingOtp,
  subscribe
});
