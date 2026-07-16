// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoginDialog } from '../src/components/auth/LoginDialog.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root = null;
let container = null;

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('LoginDialog Google preservation flow', () => {
  it('keeps Google login enabled after consent when a preparation note is shown', async () => {
    const onGoogleLogin = vi.fn().mockResolvedValue(undefined);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <LoginDialog
          open
          available
          googleAvailable
          googlePreparationNote="当前分析会在授权前临时保存在本机。"
          onClose={() => {}}
          onGoogleLogin={onGoogleLogin}
        />
      );
    });

    const consent = container.querySelector('.login-dialog-consent input');
    const googleButton = container.querySelector('.login-dialog-google');
    expect(container.textContent).toContain('当前分析会自动保留');
    expect(googleButton.disabled).toBe(true);

    await act(async () => consent.click());
    expect(googleButton.disabled).toBe(false);
    await act(async () => googleButton.click());
    expect(onGoogleLogin).toHaveBeenCalledTimes(1);
  });
});
