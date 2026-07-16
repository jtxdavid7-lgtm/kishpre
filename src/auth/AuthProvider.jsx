import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { GoogleLinkDialog } from '../components/auth/GoogleLinkDialog.jsx';
import { LoginDialog } from '../components/auth/LoginDialog.jsx';
import {
  cloudbaseClient,
  getCloudbaseAuthReadiness,
  isAnonymousCloudbaseUser
} from '../lib/cloudbaseClient.js';
import { withAuthMutationLock } from '../lib/authMutationLock.js';
import { ensureDefaultCloudLibrary } from '../lib/cloudLibrary.js';

const AuthContext = createContext(null);
const GOOGLE_OAUTH_INTENT_KEY = 'kish2note:google-oauth-intent';
const GOOGLE_LINK_LOCK_KEY = 'kish2note:google-link-lock';
const GOOGLE_AUTH_FLASH_KEY = 'kish2note:google-auth-flash';
const GOOGLE_OAUTH_INTENT_TTL = 10 * 60 * 1000;
const SDK_GOOGLE_PROVIDER = 'google';
const SDK_OAUTH_SIGN_IN = 'sign_in';
const SDK_OAUTH_BIND_IDENTITY = 'bind_identity';

class OAuthFlowGuardError extends Error {
  constructor(message, scope = 'auth') {
    super(message);
    this.name = 'OAuthFlowGuardError';
    this.scope = scope;
  }
}

function providerName(identity) {
  return String(
    identity?.provider
      ?? identity?.provider_id
      ?? identity?.providerId
      ?? identity?.id
      ?? ''
  ).toLowerCase();
}

function hasGoogleIdentity(identities) {
  return Array.isArray(identities) && identities.some((identity) => providerName(identity) === 'google');
}

function userId(user) {
  return String(user?.id ?? user?.uid ?? user?.sub ?? '').trim();
}

function userFingerprint(user) {
  if (!user) return '';
  return userId(user)
    || userPhone(user)
    || String(user?.email ?? user?.user_metadata?.email ?? '').trim().toLowerCase();
}

function authSnapshotMatches(snapshot, currentUser, currentEpoch) {
  if (!snapshot || snapshot.epoch !== currentEpoch) return false;
  const currentFingerprint = userFingerprint(currentUser);
  return Boolean(currentFingerprint && currentFingerprint === snapshot.fingerprint);
}

function usersRepresentSameAccount(first, second) {
  const firstId = userId(first);
  const secondId = userId(second);
  if (firstId && secondId) return firstId === secondId;
  const firstPhone = userPhone(first);
  const secondPhone = userPhone(second);
  if (firstPhone && secondPhone) return firstPhone === secondPhone;
  const firstEmail = String(first?.email ?? first?.user_metadata?.email ?? '').trim().toLowerCase();
  const secondEmail = String(second?.email ?? second?.user_metadata?.email ?? '').trim().toLowerCase();
  return Boolean(firstEmail && secondEmail && firstEmail === secondEmail);
}

function userPhone(user) {
  const raw = user?.phone
    ?? user?.phone_number
    ?? user?.user_metadata?.phone
    ?? user?.user_metadata?.phone_number
    ?? '';
  const digits = String(raw).replace(/\D/g, '');
  if (/^86(1\d{10})$/.test(digits)) return `+${digits}`;
  if (/^1\d{10}$/.test(digits)) return `+86${digits}`;
  return '';
}

function maskedPhone(user) {
  const digits = userPhone(user).replace(/\D/g, '').slice(-11);
  return /^1\d{10}$/.test(digits) ? `${digits.slice(0, 3)}****${digits.slice(-4)}` : '当前手机号';
}

function currentReturnTo() {
  if (typeof window === 'undefined') return '/';
  return `${window.location.pathname}${window.location.search}${window.location.hash}` || '/';
}

function normalizeReturnTo(value) {
  if (!value || typeof window === 'undefined') return '';
  try {
    const url = new URL(value, window.location.origin);
    if (url.origin !== window.location.origin) return '';
    return `${url.pathname}${url.search}${url.hash}` || '/';
  } catch {
    return '';
  }
}

function createOAuthState() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function writeGoogleIntent(intent) {
  if (typeof window === 'undefined') return;
  window.sessionStorage.setItem(GOOGLE_OAUTH_INTENT_KEY, JSON.stringify({ ...intent, startedAt: Date.now() }));
}

function clearGoogleIntent(intent = null) {
  if (typeof window === 'undefined') return;
  let current = intent;
  if (!current) {
    try {
      current = JSON.parse(window.sessionStorage.getItem(GOOGLE_OAUTH_INTENT_KEY) || 'null');
    } catch {
      current = null;
    }
  }
  window.sessionStorage.removeItem(GOOGLE_OAUTH_INTENT_KEY);
  if (current?.oauthState) window.sessionStorage.removeItem(current.oauthState);
}

function readGoogleIntent() {
  if (typeof window === 'undefined') return null;
  try {
    const value = JSON.parse(window.sessionStorage.getItem(GOOGLE_OAUTH_INTENT_KEY) || 'null');
    const startedAt = Number(value?.startedAt);
    if (
      !value
      || !Number.isFinite(startedAt)
      || startedAt <= 0
      || startedAt > Date.now() + 60 * 1000
      || Date.now() - startedAt > GOOGLE_OAUTH_INTENT_TTL
    ) {
      clearGoogleIntent(value);
      return null;
    }
    return value;
  } catch {
    clearGoogleIntent();
    return null;
  }
}

function writeGoogleLinkLock(expectedUserId, oauthState) {
  if (typeof window === 'undefined') return null;
  const normalizedUserId = String(expectedUserId ?? '').trim();
  const normalizedState = String(oauthState ?? '').trim();
  if (!normalizedUserId || !normalizedState) throw new Error('Google 关联锁参数无效。');
  const existing = readGoogleLinkLock();
  if (existing && (
    existing.expectedUserId !== normalizedUserId
    || existing.oauthState !== normalizedState
  )) {
    throw new Error('另一个 Google 关联流程正在进行，请在原页面完成后重试。');
  }
  const value = {
    expectedUserId: normalizedUserId,
    oauthState: normalizedState,
    startedAt: Date.now()
  };
  window.localStorage.setItem(GOOGLE_LINK_LOCK_KEY, JSON.stringify(value));
  const confirmed = readGoogleLinkLock();
  if (
    confirmed?.expectedUserId !== normalizedUserId
    || confirmed?.oauthState !== normalizedState
  ) {
    throw new Error('无法确认 Google 关联锁，请稍后重试。');
  }
  return confirmed;
}

function clearGoogleLinkLock(oauthState) {
  if (typeof window === 'undefined') return false;
  const normalizedState = String(oauthState ?? '').trim();
  if (!normalizedState) return false;
  const raw = window.localStorage.getItem(GOOGLE_LINK_LOCK_KEY);
  if (!raw) return true;
  try {
    const value = JSON.parse(raw);
    if (String(value?.oauthState ?? '') !== normalizedState) return false;
    if (window.localStorage.getItem(GOOGLE_LINK_LOCK_KEY) === raw) {
      window.localStorage.removeItem(GOOGLE_LINK_LOCK_KEY);
    }
    return true;
  } catch {
    return false;
  }
}

function removeExpiredGoogleLinkLock(raw) {
  if (typeof window === 'undefined' || !raw) return;
  if (window.localStorage.getItem(GOOGLE_LINK_LOCK_KEY) === raw) {
    window.localStorage.removeItem(GOOGLE_LINK_LOCK_KEY);
  }
}

function readGoogleLinkLock() {
  if (typeof window === 'undefined') return null;
  const raw = window.localStorage.getItem(GOOGLE_LINK_LOCK_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    const startedAt = Number(value?.startedAt);
    const expectedUserId = String(value?.expectedUserId ?? '').trim();
    const oauthState = String(value?.oauthState ?? '').trim();
    if (
      !expectedUserId
      || !oauthState
      || !Number.isFinite(startedAt)
      || startedAt <= 0
      || startedAt > Date.now() + 60 * 1000
      || Date.now() - startedAt > GOOGLE_OAUTH_INTENT_TTL
    ) {
      removeExpiredGoogleLinkLock(raw);
      return null;
    }
    return {
      expectedUserId,
      oauthState,
      startedAt
    };
  } catch {
    removeExpiredGoogleLinkLock(raw);
    return null;
  }
}

function expectedSdkOAuthType(intent) {
  if (intent?.type === 'link-google') return SDK_OAUTH_BIND_IDENTITY;
  if (intent?.type === 'sign-in-google') return SDK_OAUTH_SIGN_IN;
  return '';
}

function hasMatchingSdkOAuthState(intent, state) {
  if (typeof window === 'undefined' || !state) return false;
  try {
    const value = JSON.parse(window.sessionStorage.getItem(state) || 'null');
    return String(value?.provider ?? '').toLowerCase() === SDK_GOOGLE_PROVIDER
      && String(value?.type ?? '') === expectedSdkOAuthType(intent);
  } catch {
    return false;
  }
}

function writeAuthFlash(message, scope = 'auth') {
  if (typeof window === 'undefined') return;
  window.sessionStorage.setItem(GOOGLE_AUTH_FLASH_KEY, JSON.stringify({ message, scope }));
}

function readAuthFlash() {
  if (typeof window === 'undefined') return null;
  try {
    const value = JSON.parse(window.sessionStorage.getItem(GOOGLE_AUTH_FLASH_KEY) || 'null');
    window.sessionStorage.removeItem(GOOGLE_AUTH_FLASH_KEY);
    return value;
  } catch {
    window.sessionStorage.removeItem(GOOGLE_AUTH_FLASH_KEY);
    return null;
  }
}

function googleOAuthCallbackFailure() {
  if (typeof window === 'undefined') return '';
  const params = new URLSearchParams(window.location.search);
  const error = String(params.get('error') ?? '').toLowerCase();
  const description = String(params.get('error_description') ?? '').toLowerCase();
  if (!error && !description) return '';
  if (error === 'access_denied' || description.includes('denied') || description.includes('cancel')) {
    return '你已取消 Google 授权。';
  }
  return 'Google 授权未完成，请重试。';
}

function hasOAuthCallbackParams() {
  if (typeof window === 'undefined') return false;
  const params = new URLSearchParams(window.location.search);
  return params.has('state') && (params.has('code') || params.has('error') || params.has('error_description'));
}

function readOAuthCallback() {
  if (typeof window === 'undefined') return { present: false, code: '', state: '' };
  const params = new URLSearchParams(window.location.search);
  const state = String(params.get('state') ?? '');
  const code = String(params.get('code') ?? '');
  const present = Boolean(state && (code || params.has('error') || params.has('error_description')));
  return { present, code, state };
}

function oauthRecoveryUrl(intent) {
  const returnTo = normalizeReturnTo(intent?.returnTo);
  if (returnTo) return returnTo;
  const url = new URL(window.location.href);
  ['code', 'state', 'provider', 'error', 'error_description'].forEach((key) => url.searchParams.delete(key));
  return `${url.pathname}${url.search}${url.hash}` || '/';
}

function cleanOAuthCallbackUrl(intent) {
  if (typeof window === 'undefined') return;
  const target = oauthRecoveryUrl(intent);
  try {
    window.history.replaceState(window.history.state, '', target);
  } catch {
    // 无法原地清理时，后续成功/失败导航仍会使用同源 recovery URL。
  }
}

function reloadAfterOAuthFailure(intent, message, scope = 'auth') {
  writeAuthFlash(message, scope);
  clearGoogleIntent(intent);
  if (intent?.type === 'link-google') clearGoogleLinkLock(intent.oauthState);
  window.location.replace(oauthRecoveryUrl(intent));
}

export function AuthProvider({ children, onLoginSuccess }) {
  const [initialFlash] = useState(() => readAuthFlash());
  const [authStatus, setAuthStatus] = useState('loading');
  const [user, setUser] = useState(null);
  const [authError, setAuthError] = useState(null);
  const [loginOpen, setLoginOpen] = useState(false);
  const [googleLoginDisabledReason, setGoogleLoginDisabledReason] = useState('');
  const [googleLinkOpen, setGoogleLinkOpen] = useState(false);
  const [googleLinkPhoneLabel, setGoogleLinkPhoneLabel] = useState('');
  const [identities, setIdentities] = useState([]);
  const [identityStatus, setIdentityStatus] = useState('idle');
  const [identityError, setIdentityError] = useState(initialFlash?.scope === 'identity' ? initialFlash.message : '');
  const [authNotice, setAuthNotice] = useState(initialFlash?.scope === 'auth' ? initialFlash.message : '');
  const successCallbackRef = useRef(null);
  const loginReturnToRef = useRef('');
  const googleLinkContextRef = useRef(null);
  const currentUserRef = useRef(null);
  const authEpochRef = useRef(0);
  const identityRequestRef = useRef(0);
  const sessionRequestRef = useRef(0);
  const bootstrappingRef = useRef(true);
  const bootstrapGenerationRef = useRef(0);
  const readiness = getCloudbaseAuthReadiness();

  const adoptUser = useCallback((nextUser) => {
    const visibleUser = isAnonymousCloudbaseUser(nextUser) ? null : nextUser;
    const previousId = userFingerprint(currentUserRef.current);
    const nextId = userFingerprint(visibleUser);
    if (previousId !== nextId || Boolean(currentUserRef.current) !== Boolean(visibleUser)) {
      authEpochRef.current += 1;
      identityRequestRef.current += 1;
    }
    currentUserRef.current = visibleUser;
    setUser(visibleUser);
    setAuthStatus(visibleUser ? 'authenticated' : 'guest');
  }, []);

  const refreshIdentities = useCallback(async () => {
    const requestId = ++identityRequestRef.current;
    const epoch = authEpochRef.current;
    setIdentityStatus('loading');
    try {
      const nextIdentities = await cloudbaseClient.getUserIdentities();
      if (requestId !== identityRequestRef.current || epoch !== authEpochRef.current) return null;
      setIdentities(nextIdentities);
      setIdentityError('');
      setIdentityStatus('ready');
      return nextIdentities;
    } catch (error) {
      if (requestId !== identityRequestRef.current || epoch !== authEpochRef.current) return null;
      setIdentityError(error instanceof Error ? error.message : '读取账户登录方式失败。');
      setIdentityStatus('error');
      return null;
    }
  }, []);

  const refreshSession = useCallback(async () => {
    const requestId = ++sessionRequestRef.current;
    try {
      const result = await cloudbaseClient.getSession();
      if (requestId !== sessionRequestRef.current) return null;
      const nextUser = result?.user ?? null;
      setAuthError(null);
      adoptUser(nextUser);
      if (nextUser && !isAnonymousCloudbaseUser(nextUser)) await refreshIdentities();
      else {
        identityRequestRef.current += 1;
        setIdentities([]);
        setIdentityStatus('idle');
      }
      return nextUser;
    } catch (error) {
      if (requestId !== sessionRequestRef.current) return null;
      setAuthError(error);
      setAuthStatus((current) => current === 'loading' ? 'error' : current);
      return null;
    }
  }, [adoptUser, refreshIdentities]);

  const signOutFailClosed = useCallback(async () => {
    sessionRequestRef.current += 1;
    identityRequestRef.current += 1;
    authEpochRef.current += 1;
    await cloudbaseClient.signOut().catch(() => {});
    currentUserRef.current = null;
    setUser(null);
    setIdentities([]);
    setIdentityStatus('idle');
    setAuthStatus('guest');
  }, []);

  const snapshotIsCurrent = useCallback((snapshot) => authSnapshotMatches(
    snapshot,
    currentUserRef.current,
    authEpochRef.current
  ), []);

  const verifySnapshotCanonicalUser = useCallback(async ({ snapshot, canonicalUserId }) => {
    if (!snapshotIsCurrent(snapshot) || !canonicalUserId) return false;
    try {
      const currentUserId = await cloudbaseClient.getCurrentUserId();
      return snapshotIsCurrent(snapshot) && currentUserId === canonicalUserId;
    } catch {
      return false;
    }
  }, [snapshotIsCurrent]);

  const signOutSnapshotAccount = useCallback(async (prepared) => withAuthMutationLock(async () => {
    if (!snapshotIsCurrent(prepared?.snapshot) || !prepared?.canonicalUserId) return false;
    let currentUserId = '';
    try {
      currentUserId = await cloudbaseClient.getCurrentUserId();
    } catch {
      return false;
    }
    if (!snapshotIsCurrent(prepared.snapshot) || currentUserId !== prepared.canonicalUserId) return false;
    await signOutFailClosed();
    return true;
  }), [signOutFailClosed, snapshotIsCurrent]);

  const finishGoogleCallback = useCallback(async (intent, prepared) => {
    const { nextUser, canonicalUserId, snapshot } = prepared ?? {};
    if (!intent || !nextUser || !canonicalUserId || !snapshot) return;

    const isCurrentAccount = () => snapshotIsCurrent(snapshot);
    const stopIfAccountChanged = () => {
      if (isCurrentAccount()) return false;
      reloadAfterOAuthFailure(
        intent,
        '账户登录状态已在其他页面改变，本次 Google 后续处理已停止。',
        intent.type === 'link-google' ? 'identity' : 'auth'
      );
      return true;
    };
    const expectedUserId = String(intent.expectedUserId ?? '').trim();
    if (intent.type === 'link-google' && (!expectedUserId || expectedUserId !== canonicalUserId)) {
      await signOutSnapshotAccount(prepared);
      reloadAfterOAuthFailure(intent, '关联回调的账户与原账户不一致，已安全退出。请重新登录后检查关联状态。');
      return;
    }

    if (stopIfAccountChanged()) return;
    const nextIdentities = await refreshIdentities();
    if (stopIfAccountChanged()) return;
    if (!await verifySnapshotCanonicalUser(prepared)) {
      reloadAfterOAuthFailure(
        intent,
        '无法再次确认 Google 回调账户，本次后续处理已停止，请刷新后检查登录状态。',
        intent.type === 'link-google' ? 'identity' : 'auth'
      );
      return;
    }
    if (nextIdentities === null) {
      cleanOAuthCallbackUrl(intent);
      clearGoogleIntent(intent);
      if (intent.type === 'link-google') clearGoogleLinkLock(intent.oauthState);
      const message = 'Google 已完成回跳，但暂时无法确认关联状态，请刷新后再查看。';
      if (intent.type === 'link-google') setIdentityError(message);
      else setAuthNotice(message);
      return;
    }
    if (!hasGoogleIdentity(nextIdentities)) {
      if (intent.type === 'link-google') {
        reloadAfterOAuthFailure(intent, 'Google 账号尚未关联成功，请确认它没有绑定其他 K2note 账户。', 'identity');
      } else {
        const signedOut = await signOutSnapshotAccount(prepared);
        reloadAfterOAuthFailure(
          intent,
          signedOut ? 'Google 登录未能完成，已安全退出，请重试。' : '账户状态已经变化，本次 Google 登录检查已停止。'
        );
      }
      return;
    }

    clearGoogleIntent(intent);
    if (intent.type === 'link-google') clearGoogleLinkLock(intent.oauthState);
    googleLinkContextRef.current = null;
    setGoogleLinkPhoneLabel('');
    setIdentityError('');
    setAuthNotice(intent.type === 'link-google' ? 'Google 账号关联成功。' : 'Google 登录成功。');
    if (!await verifySnapshotCanonicalUser(prepared)) return;
    await ensureDefaultCloudLibrary().catch((error) => console.error('创建默认牌谱库失败', error));
    if (!await verifySnapshotCanonicalUser(prepared)) return;
    if (onLoginSuccess) {
      await onLoginSuccess(nextUser);
      if (!await verifySnapshotCanonicalUser(prepared)) return;
    }

    const returnTo = normalizeReturnTo(intent.returnTo);
    if (returnTo && returnTo !== currentReturnTo()) window.location.assign(returnTo);
  }, [onLoginSuccess, refreshIdentities, signOutSnapshotAccount, snapshotIsCurrent, verifySnapshotCanonicalUser]);

  useEffect(() => {
    let active = true;
    const generation = ++bootstrapGenerationRef.current;
    bootstrappingRef.current = true;
    const requestId = ++sessionRequestRef.current;
    const isCurrentBootstrap = () => active
      && generation === bootstrapGenerationRef.current
      && requestId === sessionRequestRef.current;
    const bootstrap = async () => {
      const intent = readGoogleIntent();
      const callback = readOAuthCallback();

      if (callback.present) {
        if (!intent || !intent.oauthState || callback.state !== intent.oauthState) {
          window.sessionStorage.removeItem(callback.state);
          reloadAfterOAuthFailure(
            intent,
            'Google 回调状态无效或已过期，已停止处理，请重试。',
            intent?.type === 'link-google' ? 'identity' : 'auth'
          );
          return;
        }

        if (!expectedSdkOAuthType(intent) || !hasMatchingSdkOAuthState(intent, callback.state)) {
          reloadAfterOAuthFailure(
            intent,
            'Google 回调的安全状态与发起操作不一致，已停止处理，请重试。',
            intent.type === 'link-google' ? 'identity' : 'auth'
          );
          return;
        }

        const callbackFailure = googleOAuthCallbackFailure();
        if (callbackFailure || !callback.code) {
          reloadAfterOAuthFailure(
            intent,
            callbackFailure || 'Google 授权未返回有效凭据，请重试。',
            intent.type === 'link-google' ? 'identity' : 'auth'
          );
          return;
        }

        const prepared = await withAuthMutationLock(async () => {
          if (!isCurrentBootstrap()) return;
          const activeLinkLock = readGoogleLinkLock();
          if (intent.type === 'link-google') {
            const expectedUserId = String(intent.expectedUserId ?? '').trim();
            if (
              !activeLinkLock
              || !expectedUserId
              || activeLinkLock.expectedUserId !== expectedUserId
              || activeLinkLock.oauthState !== callback.state
            ) {
              throw new OAuthFlowGuardError(
                'Google 关联会话已失效，已停止绑定，请重新发起。',
                'identity'
              );
            }
            const currentSession = await cloudbaseClient.getSession();
            if (!currentSession?.user) {
              throw new OAuthFlowGuardError(
                '原账户登录态已失效，已停止绑定，请重新登录。',
                'identity'
              );
            }
            const currentUserId = await cloudbaseClient.getCurrentUserId();
            if (currentUserId !== expectedUserId) {
              await signOutFailClosed();
              throw new OAuthFlowGuardError('当前账户与关联前账户不一致，已安全退出。', 'identity');
            }
          } else if (activeLinkLock && activeLinkLock.oauthState !== callback.state) {
            throw new OAuthFlowGuardError(
              '另一个页面正在关联 Google，本次 Google 登录已安全停止。'
            );
          }

          if (!isCurrentBootstrap()) return;
          if (!hasMatchingSdkOAuthState(intent, callback.state)) {
            throw new OAuthFlowGuardError(
              'Google 回调的安全状态已失效，已停止处理，请重新发起。',
              intent.type === 'link-google' ? 'identity' : 'auth'
            );
          }
          await cloudbaseClient.verifyGoogleOAuth({ code: callback.code, state: callback.state });
          cleanOAuthCallbackUrl(intent);

          const result = await cloudbaseClient.getSession();
          if (!isCurrentBootstrap()) return;
          const nextUser = result?.user ?? null;
          if (!nextUser) throw new OAuthFlowGuardError('Google 登录未能建立有效会话，请重试。');

          let canonicalUserId = '';
          try {
            canonicalUserId = await cloudbaseClient.getCurrentUserId();
          } catch {
            await signOutFailClosed();
            throw new OAuthFlowGuardError(
              '无法验证 Google 回调账户，已安全退出，请重新登录。',
              intent.type === 'link-google' ? 'identity' : 'auth'
            );
          }
          const expectedUserId = String(intent.expectedUserId ?? '').trim();
          if (intent.type === 'link-google' && (!expectedUserId || expectedUserId !== canonicalUserId)) {
            await signOutFailClosed();
            throw new OAuthFlowGuardError(
              '关联回调的账户与原账户不一致，已安全退出。请重新登录后检查关联状态。',
              'identity'
            );
          }

          setAuthError(null);
          adoptUser(nextUser);
          const fingerprint = userFingerprint(nextUser);
          if (!fingerprint) {
            await signOutFailClosed();
            throw new OAuthFlowGuardError('Google 回调账户缺少可验证标识，已安全退出，请重新登录。');
          }
          return {
            nextUser,
            canonicalUserId,
            snapshot: { epoch: authEpochRef.current, fingerprint }
          };
        });
        if (!prepared || !isCurrentBootstrap()) return;
        bootstrappingRef.current = false;
        await finishGoogleCallback(intent, prepared);
        return;
      } else if (intent) {
        reloadAfterOAuthFailure(
          intent,
          'Google 授权未完成，请重试。',
          intent.type === 'link-google' ? 'identity' : 'auth'
        );
        return;
      }

      const result = await cloudbaseClient.getSession();
      if (!isCurrentBootstrap()) return;
      const nextUser = result?.user ?? null;
      setAuthError(null);
      adoptUser(nextUser);
      if (nextUser && !isAnonymousCloudbaseUser(nextUser)) await refreshIdentities();
      else {
        setIdentities([]);
        setIdentityStatus('idle');
      }
      if (!isCurrentBootstrap()) return;
      bootstrappingRef.current = false;
    };

    const bootstrapTimer = window.setTimeout(() => bootstrap().catch((error) => {
      const intent = readGoogleIntent();
      const callback = readOAuthCallback();
      const isCurrentGeneration = active && generation === bootstrapGenerationRef.current;
      if (isCurrentGeneration && (intent || callback.present)) {
        if (callback.state) window.sessionStorage.removeItem(callback.state);
        reloadAfterOAuthFailure(
          intent,
          error instanceof OAuthFlowGuardError ? error.message : 'Google 回调处理失败，请重试。',
          error instanceof OAuthFlowGuardError
            ? error.scope
            : intent?.type === 'link-google' ? 'identity' : 'auth'
        );
        return;
      }
      if (!isCurrentBootstrap()) return;
      bootstrappingRef.current = false;
      setAuthError(error);
      setAuthStatus('error');
    }), 0);

    const unsubscribe = cloudbaseClient.subscribe((event) => {
      if (!active || bootstrappingRef.current) return;
      if (event?.error) {
        setAuthError(event.error);
        return;
      }
      const eventName = String(event?.event ?? '').toUpperCase();
      if (eventName === 'SIGNED_OUT') {
        sessionRequestRef.current += 1;
        adoptUser(null);
        setIdentities([]);
        setIdentityStatus('idle');
        return;
      }
      if (event?.user) {
        setAuthError(null);
        adoptUser(event.user);
        if (!isAnonymousCloudbaseUser(event.user)) void refreshIdentities();
        else {
          setIdentities([]);
          setIdentityStatus('idle');
        }
        return;
      }
      if (eventName === 'BIND_IDENTITY') void refreshSession();
    });
    return () => {
      active = false;
      window.clearTimeout(bootstrapTimer);
      unsubscribe?.();
    };
  }, [adoptUser, finishGoogleCallback, refreshIdentities, refreshSession, signOutFailClosed]);

  useEffect(() => {
    const handlePageShow = (event) => {
      if (!event.persisted) return;
      const intent = readGoogleIntent();
      if (!intent || hasOAuthCallbackParams()) return;
      reloadAfterOAuthFailure(
        intent,
        'Google 授权未完成，请重试。',
        intent.type === 'link-google' ? 'identity' : 'auth'
      );
    };
    window.addEventListener('pageshow', handlePageShow);
    return () => window.removeEventListener('pageshow', handlePageShow);
  }, []);

  const openLogin = useCallback((options = {}) => {
    if (readGoogleLinkLock()) {
      setAuthNotice('Google 关联正在进行，请先在原页面完成或等待 10 分钟后重试。');
      return;
    }
    const normalized = typeof options === 'function' ? { onSuccess: options } : options;
    successCallbackRef.current = normalized.onSuccess ?? null;
    loginReturnToRef.current = normalizeReturnTo(normalized.returnTo);
    setGoogleLoginDisabledReason(String(normalized.googleDisabledReason ?? ''));
    setAuthNotice('');
    setLoginOpen(true);
  }, []);

  const closeLogin = useCallback(() => {
    cloudbaseClient.clearPendingOtp();
    successCallbackRef.current = null;
    loginReturnToRef.current = '';
    setGoogleLoginDisabledReason('');
    setLoginOpen(false);
  }, []);

  const preparePhoneLoginWithinLock = useCallback(async (result) => {
    const nextUser = result?.user ?? null;
    if (!nextUser) throw new Error('登录成功后未获取到用户信息。');
    let canonicalUserId = '';
    try {
      canonicalUserId = await cloudbaseClient.getCurrentUserId();
    } catch {
      await signOutFailClosed();
      throw new Error('无法确认当前登录账户，已安全退出，请重试。');
    }
    const linkLock = readGoogleLinkLock();
    if (linkLock?.expectedUserId && linkLock.expectedUserId !== canonicalUserId) {
      await signOutFailClosed();
      throw new Error('另一个页面正在为不同账户关联 Google，本次登录已安全取消。');
    }
    const fingerprint = userFingerprint(nextUser);
    if (!fingerprint) {
      await signOutFailClosed();
      throw new Error('当前登录账户缺少可验证标识，已安全退出，请重试。');
    }

    adoptUser(nextUser);
    setAuthError(null);
    setLoginOpen(false);
    setGoogleLoginDisabledReason('');
    const pendingCallback = successCallbackRef.current;
    const returnTo = loginReturnToRef.current;
    successCallbackRef.current = null;
    loginReturnToRef.current = '';
    return {
      result,
      nextUser,
      canonicalUserId,
      pendingCallback,
      returnTo,
      snapshot: { epoch: authEpochRef.current, fingerprint }
    };
  }, [adoptUser, signOutFailClosed]);

  const finishPhoneLogin = useCallback(async (prepared) => {
    const { result, nextUser, pendingCallback, returnTo } = prepared;
    const assertCurrentAccount = async () => {
      if (!await verifySnapshotCanonicalUser(prepared)) {
        throw new Error('账户登录状态已在其他页面改变，本次登录后的操作已停止。');
      }
    };

    await assertCurrentAccount();
    await refreshIdentities();
    await assertCurrentAccount();
    await ensureDefaultCloudLibrary().catch((error) => console.error('创建默认牌谱库失败', error));
    await assertCurrentAccount();
    if (onLoginSuccess) {
      await onLoginSuccess(nextUser);
      await assertCurrentAccount();
    }
    await pendingCallback?.(nextUser);
    if (returnTo && !pendingCallback && returnTo !== currentReturnTo()) window.location.assign(returnTo);
    return result;
  }, [onLoginSuccess, refreshIdentities, verifySnapshotCanonicalUser]);

  const signInWithPhonePassword = useCallback(async (params) => {
    const prepared = await withAuthMutationLock(async () => {
      if (readGoogleLinkLock()) {
        throw new Error('另一个页面正在关联 Google，本次手机号登录已安全停止。');
      }
      const result = await cloudbaseClient.signInWithPhonePassword(params);
      return preparePhoneLoginWithinLock(result);
    });
    return finishPhoneLogin(prepared);
  }, [finishPhoneLogin, preparePhoneLoginWithinLock]);

  const completePhonePasswordSetup = useCallback(async (params) => {
    const prepared = await withAuthMutationLock(async () => {
      if (readGoogleLinkLock()) {
        throw new Error('另一个页面正在关联 Google，本次手机号操作已安全停止。');
      }
      const result = await cloudbaseClient.completePhonePasswordSetup(params);
      return preparePhoneLoginWithinLock(result);
    });
    return finishPhoneLogin(prepared);
  }, [finishPhoneLogin, preparePhoneLoginWithinLock]);

  const signInWithGoogle = useCallback(async () => {
    if (googleLoginDisabledReason) throw new Error(googleLoginDisabledReason);
    if (readGoogleLinkLock()) throw new Error('Google 关联正在进行，请先完成当前关联。');
    const returnTo = loginReturnToRef.current || currentReturnTo();
    const oauthState = createOAuthState();
    const intent = { type: 'sign-in-google', returnTo, oauthState };
    writeGoogleIntent(intent);
    setAuthError(null);
    try {
      return await cloudbaseClient.signInWithGoogle({ redirectTo: returnTo, state: oauthState });
    } catch (error) {
      clearGoogleIntent(intent);
      throw error;
    }
  }, [googleLoginDisabledReason]);

  const openGoogleLink = useCallback(async () => {
    try {
      setIdentityStatus('loading');
      setIdentityError('');
      const prepared = await withAuthMutationLock(async () => {
        const currentUser = currentUserRef.current;
        if (!currentUser) throw new Error('请先登录，再关联 Google 账号。');
        const phone = userPhone(currentUser);
        if (!readiness.phoneAvailable || !phone) {
          throw new Error('当前账户没有可验证的中国大陆手机号，无法执行安全关联。');
        }
        const fingerprint = userFingerprint(currentUser);
        if (!fingerprint) throw new Error('当前登录账户缺少可验证标识，请退出后重新登录。');
        const snapshot = { epoch: authEpochRef.current, fingerprint };
        const currentSession = await cloudbaseClient.getSession();
        if (!currentSession?.user || !snapshotIsCurrent(snapshot)) {
          throw new Error('当前账户已经变化，请重新打开关联窗口。');
        }
        if (!usersRepresentSameAccount(currentUser, currentSession.user)) {
          throw new Error('当前账户已经变化，请重新打开关联窗口。');
        }
        const canonicalUserId = await cloudbaseClient.getCurrentUserId();
        if (
          !canonicalUserId
          || !snapshotIsCurrent(snapshot)
          || (userId(currentUser) && userId(currentUser) !== canonicalUserId)
        ) {
          throw new Error('当前账户已经变化，请重新打开关联窗口。');
        }
        return {
          expectedUserId: canonicalUserId,
          canonicalUserId,
          phone,
          phoneLabel: maskedPhone(currentUser),
          snapshot
        };
      });
      if (!await verifySnapshotCanonicalUser(prepared)) {
        throw new Error('当前账户已经变化，请重新打开关联窗口。');
      }
      googleLinkContextRef.current = prepared;
      setGoogleLinkPhoneLabel(prepared.phoneLabel);
      setIdentityStatus('ready');
      setGoogleLinkOpen(true);
    } catch (error) {
      setIdentityStatus('error');
      setIdentityError(error instanceof Error ? error.message : '无法开始 Google 关联。');
      throw error;
    }
  }, [readiness.phoneAvailable, snapshotIsCurrent, verifySnapshotCanonicalUser]);

  const closeGoogleLink = useCallback(() => {
    cloudbaseClient.clearPendingOtp();
    googleLinkContextRef.current = null;
    setGoogleLinkPhoneLabel('');
    setGoogleLinkOpen(false);
  }, []);

  const sendGoogleLinkCode = useCallback(async () => {
    const prepared = googleLinkContextRef.current;
    if (!prepared) throw new Error('关联会话已失效，请关闭后重试。');
    if (!await verifySnapshotCanonicalUser(prepared)) {
      closeGoogleLink();
      throw new Error('当前账户已经变化，旧的关联窗口已关闭。');
    }
    return cloudbaseClient.sendPhoneCode({ phone: prepared.phone });
  }, [closeGoogleLink, verifySnapshotCanonicalUser]);

  const verifyAndLinkGoogle = useCallback(async ({ code, challengeId }) => {
    const linkContext = googleLinkContextRef.current;
    const expectedUserId = linkContext?.expectedUserId;
    if (!linkContext || !expectedUserId) throw new Error('关联会话已失效，请关闭后重试。');
    const prepared = await withAuthMutationLock(async () => {
      if (readGoogleLinkLock()) {
        throw new Error('另一个 Google 关联流程正在进行，请在原页面完成后重试。');
      }
      if (!snapshotIsCurrent(linkContext.snapshot)) {
        closeGoogleLink();
        throw new Error('当前账户已经变化，旧的关联窗口已关闭。');
      }
      const currentSession = await cloudbaseClient.getSession();
      if (!currentSession?.user || !snapshotIsCurrent(linkContext.snapshot)) {
        closeGoogleLink();
        throw new Error('当前账户已经变化，旧的关联窗口已关闭。');
      }
      const currentUserId = await cloudbaseClient.getCurrentUserId();
      if (currentUserId !== expectedUserId || !snapshotIsCurrent(linkContext.snapshot)) {
        closeGoogleLink();
        throw new Error('当前账户已经变化，旧的关联窗口已关闭。');
      }
      const result = await cloudbaseClient.verifyPhoneCode({ code, challengeId });
      const nextUser = result?.user ?? null;
      const verifiedUserId = await cloudbaseClient.getCurrentUserId();
      if (!nextUser || verifiedUserId !== expectedUserId) {
        setGoogleLinkOpen(false);
        await signOutFailClosed();
        throw new Error('手机号验证账户与当前账户不一致，已安全退出。');
      }
      const fingerprint = userFingerprint(nextUser);
      if (!fingerprint) {
        setGoogleLinkOpen(false);
        await signOutFailClosed();
        throw new Error('手机号验证账户缺少可验证标识，已安全退出。');
      }
      adoptUser(nextUser);

      const returnTo = currentReturnTo();
      const oauthState = createOAuthState();
      const intent = {
        type: 'link-google',
        expectedUserId,
        returnTo,
        oauthState
      };
      try {
        writeGoogleIntent(intent);
        writeGoogleLinkLock(expectedUserId, oauthState);
      } catch (error) {
        clearGoogleIntent(intent);
        clearGoogleLinkLock(oauthState);
        throw error;
      }
      return {
        intent,
        oauthState,
        returnTo,
        canonicalUserId: verifiedUserId,
        snapshot: { epoch: authEpochRef.current, fingerprint }
      };
    });

    const { intent, oauthState, returnTo } = prepared;
    if (!await verifySnapshotCanonicalUser(prepared)) {
      clearGoogleIntent(intent);
      clearGoogleLinkLock(oauthState);
      throw new Error('当前账户已经变化，本次 Google 关联已停止。');
    }
    setIdentityStatus('linking');
    setIdentityError('');
    setAuthNotice('');
    setGoogleLinkOpen(false);
    try {
      return await cloudbaseClient.linkGoogleIdentity({ redirectTo: returnTo, state: oauthState });
    } catch (error) {
      clearGoogleIntent(intent);
      clearGoogleLinkLock(intent.oauthState);
      setIdentityStatus('error');
      setIdentityError(error instanceof Error ? error.message : 'Google 账号关联失败。');
      throw error;
    }
  }, [adoptUser, closeGoogleLink, signOutFailClosed, snapshotIsCurrent, verifySnapshotCanonicalUser]);

  const logout = useCallback(async () => {
    await withAuthMutationLock(async () => {
      if (readGoogleLinkLock()) {
        setAuthNotice('Google 关联正在进行，暂时不能切换或退出账户。');
        throw new Error('Google 关联正在进行，暂时不能退出账户。');
      }
      sessionRequestRef.current += 1;
      identityRequestRef.current += 1;
      authEpochRef.current += 1;
      await cloudbaseClient.signOut();
      clearGoogleIntent();
    });
    successCallbackRef.current = null;
    loginReturnToRef.current = '';
    googleLinkContextRef.current = null;
    setGoogleLinkPhoneLabel('');
    setLoginOpen(false);
    setGoogleLoginDisabledReason('');
    setGoogleLinkOpen(false);
    currentUserRef.current = null;
    setUser(null);
    setIdentities([]);
    setIdentityStatus('idle');
    setIdentityError('');
    setAuthNotice('');
    setAuthError(null);
    setAuthStatus('guest');
  }, []);

  const googleLinked = hasGoogleIdentity(identities);
  const contextValue = useMemo(() => ({
    authStatus,
    authError,
    authNotice,
    clearAuthNotice: () => setAuthNotice(''),
    user,
    identities,
    identityStatus,
    identityError,
    googleLinked,
    isAuthenticated: authStatus === 'authenticated',
    authAvailable: readiness.available,
    phoneAuthAvailable: readiness.phoneAvailable,
    googleAuthAvailable: readiness.googleAvailable,
    authUnavailableReason: readiness.reason,
    openLogin,
    closeLogin,
    openGoogleLink,
    logout,
    refreshSession,
    refreshIdentities
  }), [authError, authNotice, authStatus, closeLogin, googleLinked, identities, identityError, identityStatus, logout, openGoogleLink, openLogin, readiness.available, readiness.googleAvailable, readiness.phoneAvailable, readiness.reason, refreshIdentities, refreshSession, user]);

  return (
    <AuthContext.Provider value={contextValue}>
      {children}
      <LoginDialog
        open={loginOpen}
        available={readiness.available}
        phoneAvailable={readiness.phoneAvailable}
        googleAvailable={readiness.googleAvailable}
        googleDisabledReason={googleLoginDisabledReason}
        unavailableReason={readiness.reason}
        onClose={closeLogin}
        onGoogleLogin={signInWithGoogle}
        onPasswordLogin={signInWithPhonePassword}
        onBeginPasswordSetup={cloudbaseClient.beginPhonePasswordSetup}
        onCompletePasswordSetup={completePhonePasswordSetup}
        termsHref="/?page=terms"
        privacyHref="/?page=privacy"
      />
      <GoogleLinkDialog
        open={googleLinkOpen}
        phoneLabel={googleLinkPhoneLabel || maskedPhone(user)}
        onClose={closeGoogleLink}
        onSendCode={sendGoogleLinkCode}
        onVerifyAndLink={verifyAndLinkGoogle}
      />
    </AuthContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth 必须在 AuthProvider 内使用。');
  return value;
}
