import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadConfig, resetConfigForTests } from '../src/config/index';
import {
  createRazorpayClient,
  getRazorpayClient,
  resetRazorpayClientForTests,
} from '../src/integrations/razorpay/index';
import { resetLoggerForTests } from '../src/shared/logger/logger';

const razorpayConstructorSpy = vi.fn();

vi.mock('razorpay', () => {
  return {
    default: class MockRazorpay {
      orders = {};

      constructor(config: unknown) {
        razorpayConstructorSpy(config);
      }
    },
  };
});

describe('Razorpay client infrastructure', () => {
  beforeEach(() => {
    resetConfigForTests();
    resetRazorpayClientForTests();
    resetLoggerForTests();
    razorpayConstructorSpy.mockClear();
  });

  afterEach(() => {
    resetRazorpayClientForTests();
  });

  it('creates a client from valid configuration without calling the Razorpay API', () => {
    const client = createRazorpayClient({
      keyId: 'rzp_test_key',
      keySecret: 'rzp_test_secret',
    });

    expect(razorpayConstructorSpy).toHaveBeenCalledTimes(1);
    expect(razorpayConstructorSpy).toHaveBeenCalledWith({
      key_id: 'rzp_test_key',
      key_secret: 'rzp_test_secret',
    });
    expect(client).toBeTruthy();
  });

  it('fails initialization when Razorpay keys are missing', () => {
    loadConfig({
      NODE_ENV: 'test',
      PORT: '3000',
      LOG_LEVEL: 'silent',
      CORS_ORIGIN: 'http://localhost:5173',
    });

    expect(() => getRazorpayClient()).toThrow('Missing required configuration: RAZORPAY_KEY_ID');
    expect(razorpayConstructorSpy).not.toHaveBeenCalled();
  });

  it('does not include secrets in initialization failure messages', () => {
    try {
      createRazorpayClient({
        keyId: 'rzp_test_key',
        keySecret: undefined,
      });
      expect.unreachable('expected createRazorpayClient to throw');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toBe('Missing required configuration: RAZORPAY_KEY_SECRET');
      expect(message).not.toContain('rzp_test');
    }
  });

  it('reuses a singleton client from process configuration', () => {
    loadConfig({
      NODE_ENV: 'test',
      PORT: '3000',
      LOG_LEVEL: 'silent',
      CORS_ORIGIN: 'http://localhost:5173',
      RAZORPAY_KEY_ID: 'rzp_test_key',
      RAZORPAY_KEY_SECRET: 'rzp_test_secret',
    });

    const first = getRazorpayClient();
    const second = getRazorpayClient();

    expect(first).toBe(second);
    expect(razorpayConstructorSpy).toHaveBeenCalledTimes(1);
  });
});
