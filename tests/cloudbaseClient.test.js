import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  vi.unstubAllEnvs();
});

describe('CloudBase phone registration', () => {
  it('uses the v3 smart signUp flow instead of the email password-reset API', async () => {
    vi.stubEnv('VITE_CLOUDBASE_ENV_ID', 'test-env');
    vi.stubEnv('VITE_CLOUDBASE_REGION', 'ap-shanghai');
    vi.stubEnv('VITE_CLOUDBASE_ACCESS_KEY', 'test-publishable-key');

    const user = { id: 'phone-user', phone: '+86 13800138000' };
    const session = { access_token: 'access-token', user };
    const verifyOtp = vi.fn().mockResolvedValue({ data: { user, session }, error: null });
    const auth = {
      getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
      signUp: vi.fn().mockResolvedValue({ data: { verifyOtp }, error: null }),
      resetPasswordForEmail: vi.fn(),
    };
    const app = {
      auth: vi.fn(() => auth),
      rdb: vi.fn(() => ({})),
    };
    vi.doMock('@cloudbase/js-sdk', () => ({
      default: { init: vi.fn(() => app) },
    }));

    const { cloudbaseClient } = await import('../src/lib/cloudbaseClient.js');
    const challenge = await cloudbaseClient.beginPhonePasswordSetup({
      phone: '+8613800138000',
      password: 'StrongPass1!',
    });

    expect(auth.signUp).toHaveBeenCalledWith({
      phone: '+86 13800138000',
      password: 'StrongPass1!',
    });
    expect(auth.resetPasswordForEmail).not.toHaveBeenCalled();

    const result = await cloudbaseClient.completePhonePasswordSetup({
      challengeId: challenge.challengeId,
      code: '123456',
      password: 'StrongPass1!',
    });

    expect(verifyOtp).toHaveBeenCalledWith({ token: '123456' });
    expect(result).toEqual({ user, session });
  });
});
