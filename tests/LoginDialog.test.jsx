// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoginDialog } from '../src/components/auth/LoginDialog.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root = null;
let container = null;

async function setInputValue(input, value) {
  await act(async () => {
    const valueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )?.set;
    valueSetter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

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

describe('LoginDialog phone verification guidance', () => {
  it('shows an inline consent control and explains why the code button is disabled', async () => {
    const onBeginPasswordSetup = vi.fn().mockResolvedValue({ challengeId: 'challenge-1' });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <LoginDialog
          open
          available
          phoneAvailable
          onClose={() => {}}
          onBeginPasswordSetup={onBeginPasswordSetup}
        />
      );
    });

    const tabs = container.querySelectorAll('.login-dialog-tabs button');
    await act(async () => tabs[1].click());

    const phoneInput = container.querySelector('input[type="tel"]');
    const passwordInputs = container.querySelectorAll('input[type="password"]');
    const inlineConsent = container.querySelector('.login-dialog-consent-inline input');
    const codeButton = container.querySelector('.login-dialog-code button');
    const codeHint = container.querySelector('.login-dialog-code-hint');

    expect(inlineConsent).not.toBeNull();
    expect(codeButton.disabled).toBe(true);
    expect(codeHint.textContent).toContain('手机号');

    await setInputValue(phoneInput, '13480252502');
    await setInputValue(passwordInputs[0], 'Strong#123');
    await setInputValue(passwordInputs[1], 'Strong#123');

    expect(codeButton.disabled).toBe(true);
    expect(codeHint.textContent).toContain('用户协议');

    await act(async () => inlineConsent.click());
    expect(codeButton.disabled).toBe(false);
    expect(codeHint.classList.contains('ready')).toBe(true);

    await act(async () => codeButton.click());
    expect(onBeginPasswordSetup).toHaveBeenCalledWith({
      phone: '+8613480252502',
      password: 'Strong#123'
    });
  });
});
