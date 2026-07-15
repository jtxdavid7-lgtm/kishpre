import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { LoginDialog } from '../components/auth/LoginDialog.jsx';
import { cloudbaseClient, getCloudbaseAuthReadiness } from '../lib/cloudbaseClient.js';
import { ensureDefaultCloudLibrary } from '../lib/cloudLibrary.js';

const AuthContext = createContext(null);

export function AuthProvider({ children, onLoginSuccess }) {
  const [authStatus, setAuthStatus] = useState('loading');
  const [user, setUser] = useState(null);
  const [authError, setAuthError] = useState(null);
  const [loginOpen, setLoginOpen] = useState(false);
  const successCallbackRef = useRef(null);
  const readiness = getCloudbaseAuthReadiness();

  const refreshSession = useCallback(async () => {
    try {
      const result = await cloudbaseClient.getSession();
      const nextUser = result?.user ?? null;
      setAuthError(null);
      setUser(nextUser);
      setAuthStatus(nextUser ? 'authenticated' : 'guest');
      return nextUser;
    } catch (error) {
      setAuthError(error);
      setAuthStatus((current) => current === 'loading' ? 'error' : current);
      return null;
    }
  }, []);

  useEffect(() => {
    let active = true;
    cloudbaseClient.getSession().then((result) => {
      if (!active) return;
      const nextUser = result?.user ?? null;
      setAuthError(null);
      setUser(nextUser);
      setAuthStatus(nextUser ? 'authenticated' : 'guest');
    }).catch((error) => {
      if (!active) return;
      setAuthError(error);
      setAuthStatus('error');
    });
    const unsubscribe = cloudbaseClient.subscribe((event) => {
      if (!active) return;
      if (event?.error) {
        setAuthError(event.error);
        return;
      }
      const nextUser = event?.user ?? null;
      setAuthError(null);
      setUser(nextUser);
      setAuthStatus(nextUser ? 'authenticated' : 'guest');
    });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [refreshSession]);

  const openLogin = useCallback((options = {}) => {
    successCallbackRef.current = typeof options === 'function' ? options : options.onSuccess ?? null;
    setLoginOpen(true);
  }, []);

  const closeLogin = useCallback(() => {
    cloudbaseClient.clearPendingOtp();
    successCallbackRef.current = null;
    setLoginOpen(false);
  }, []);

  const handleLoginSuccess = useCallback(async (result) => {
    const nextUser = result?.user ?? null;
    if (!nextUser) throw new Error('登录成功后未获取到用户信息。');
    setUser(nextUser);
    setAuthError(null);
    setAuthStatus('authenticated');
    setLoginOpen(false);

    const pendingCallback = successCallbackRef.current;
    successCallbackRef.current = null;
    Promise.resolve()
      .then(() => ensureDefaultCloudLibrary().catch((error) => console.error('创建默认牌谱库失败', error)))
      .then(() => onLoginSuccess?.(nextUser))
      .then(() => pendingCallback?.(nextUser))
      .catch((error) => console.error('登录后操作失败', error));
  }, [onLoginSuccess]);

  const logout = useCallback(async () => {
    await cloudbaseClient.signOut();
    successCallbackRef.current = null;
    setLoginOpen(false);
    setUser(null);
    setAuthError(null);
    setAuthStatus('guest');
  }, []);

  const contextValue = useMemo(() => ({
    authStatus,
    authError,
    user,
    isAuthenticated: authStatus === 'authenticated',
    authAvailable: readiness.available,
    authUnavailableReason: readiness.reason,
    openLogin,
    closeLogin,
    logout,
    refreshSession
  }), [authError, authStatus, closeLogin, logout, openLogin, readiness.available, readiness.reason, refreshSession, user]);

  return (
    <AuthContext.Provider value={contextValue}>
      {children}
      <LoginDialog
        open={loginOpen}
        available={readiness.available}
        unavailableReason={readiness.reason}
        onClose={closeLogin}
        onSendCode={cloudbaseClient.sendPhoneCode}
        onVerifyCode={cloudbaseClient.verifyPhoneCode}
        onSuccess={handleLoginSuccess}
        termsHref="/?page=terms"
        privacyHref="/?page=privacy"
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
