/**
 * Scan 6 (1.3.0 round 6). Each behaviour test here failed on the round-5 code
 * (release/sdk-1.3.0 at 011d4a88c); most are the scan's probes P1-P10, lifted
 * with assertions.
 */
import * as fs from 'fs';
import * as path from 'path';
import { flush, loadSdk, makeNative, NativeMock } from './helpers';

beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
});

/**
 * A native module that behaves like both native SDKs around a FAILING first
 * initialize(): the first call is refused (a wrong key), the second works. A
 * decision that arrives before a successful init is recorded and applied
 * inside it, ahead of the Session Start; one that arrives after applies at
 * once. `calls` is what reached native, `sent` what reached the network.
 */
function failingThenWorking(): { native: NativeMock; calls: string[]; sent: string[]; state: () => { optedOut: boolean; consent: string } } {
  const calls: string[] = [];
  const sent: string[] = [];
  let attempt = 0;
  let optedOut = false;
  let consent = 'granted';
  const native = makeNative({
    initialize: jest.fn(async () => {
      attempt += 1;
      calls.push(`initialize#${attempt}`);
      if (attempt === 1) throw new Error('bad key');
      if (!optedOut && consent === 'granted') sent.push('Session Start');
      return null;
    }),
    optOut: jest.fn(() => {
      calls.push('optOut');
      optedOut = true;
    }),
    optIn: jest.fn(() => {
      calls.push('optIn');
      optedOut = false;
    }),
    updateConsent: jest.fn((c: string) => {
      calls.push(`updateConsent:${c}`);
      consent = c;
    }),
    wipeData: jest.fn(() => calls.push('wipeData')),
    isUserOptedOut: jest.fn(async () => optedOut),
    getTrackingConsent: jest.fn(async () => consent),
    setSubscription: jest.fn((c: string, s: string) => calls.push(`setSubscription:${c}:${s}`)),
    unregisterPush: jest.fn(() => calls.push('unregisterPush')),
    identify: jest.fn((id: string) => calls.push(`identify:${id}`)),
    track: jest.fn((n: string) => calls.push(`track:${n}`)),
  });
  return { native, calls, sent, state: () => ({ optedOut, consent }) };
}

describe('S1 / v6 65: decisions made while an initialize() that FAILS is in flight', () => {
  it('reach native on the failure, before the retry and its Session Start (probe P1)', async () => {
    const { native, calls, sent } = failingThenWorking();
    const { default: Joryio } = loadSdk(native, 'android');
    const first = Joryio.initialize('jry_sdk_android_WRONG', 'h');
    Joryio.optOut();
    await first;
    expect(calls).toEqual(['initialize#1', 'optOut']);
    await Joryio.initialize('jry_sdk_android_ok', 'h');
    await flush();
    expect(calls).toEqual(['initialize#1', 'optOut', 'initialize#2']);
    expect(sent).toEqual([]);
  });

  it('a held optIn never overrides a later optOut (probe P2)', async () => {
    const { native, calls, state } = failingThenWorking();
    const { default: Joryio } = loadSdk(native, 'android');
    const first = Joryio.initialize('jry_sdk_android_WRONG', 'h');
    Joryio.optIn();
    await first;
    Joryio.optOut();
    await Joryio.initialize('jry_sdk_android_ok', 'h');
    await flush();
    expect(calls).toEqual(['initialize#1', 'optIn', 'optOut', 'initialize#2']);
    expect(state().optedOut).toBe(true);
  });

  it('a held denial never overrides a later grant (probe P6)', async () => {
    const { native, calls, state } = failingThenWorking();
    const { default: Joryio } = loadSdk(native, 'android');
    const first = Joryio.initialize('jry_sdk_android_WRONG', 'h');
    Joryio.updateConsent('denied');
    await first;
    Joryio.updateConsent('granted');
    await Joryio.initialize('jry_sdk_android_ok', 'h');
    await flush();
    expect(calls).toEqual(['initialize#1', 'updateConsent:denied', 'updateConsent:granted', 'initialize#2']);
    expect(state().consent).toBe('granted');
  });

  it('a held wipe goes to native with the withdrawals made before it, ahead of the retry (probe P7)', async () => {
    const { native, calls } = failingThenWorking();
    const { default: Joryio } = loadSdk(native, 'android');
    Joryio.setSubscription('email', 'unsubscribed');
    const first = Joryio.initialize('jry_sdk_android_WRONG', 'h');
    Joryio.wipeData();
    await first;
    await Joryio.initialize('jry_sdk_android_ok', 'h');
    await flush();
    expect(calls).toEqual(['initialize#1', 'setSubscription:email:unsubscribed', 'wipeData', 'initialize#2']);
  });

  it('a withdrawal made in the window goes to native on the failure', async () => {
    const { native, calls } = failingThenWorking();
    const { default: Joryio } = loadSdk(native, 'android');
    const first = Joryio.initialize('jry_sdk_android_WRONG', 'h');
    Joryio.unregisterPush();
    Joryio.optOut();
    await first;
    expect(calls).toEqual(['initialize#1', 'unregisterPush', 'optOut']);
  });

  it('a withdrawal held behind a subscribe stays behind it, so the subscribe cannot supersede it', async () => {
    const { native, calls } = failingThenWorking();
    const { default: Joryio } = loadSdk(native, 'android');
    const first = Joryio.initialize('jry_sdk_android_WRONG', 'h');
    Joryio.setSubscription('email', 'subscribed');
    Joryio.setSubscription('email', 'unsubscribed');
    await first;
    expect(calls).toEqual(['initialize#1']);
    await Joryio.initialize('jry_sdk_android_ok', 'h');
    await flush();
    expect(calls).toEqual([
      'initialize#1',
      'initialize#2',
      'setSubscription:email:subscribed',
      'setSubscription:email:unsubscribed',
    ]);
  });

  it('data and identify calls stay held for the retry, in order', async () => {
    const { native, calls } = failingThenWorking();
    const { default: Joryio } = loadSdk(native, 'android');
    const first = Joryio.initialize('jry_sdk_android_WRONG', 'h');
    Joryio.identify('u1');
    Joryio.track('t1');
    Joryio.updateConsent('granted');
    await first;
    expect(calls).toEqual(['initialize#1', 'updateConsent:granted']);
    await Joryio.initialize('jry_sdk_android_ok', 'h');
    await flush();
    expect(calls).toEqual(['initialize#1', 'updateConsent:granted', 'initialize#2', 'identify:u1', 'track:t1']);
  });
});

describe('S2 / v6 65: privacy getters during an initialize() that fails', () => {
  it('ask native for the stored decision instead of answering the default (probe P9)', async () => {
    const native = makeNative({
      initialize: jest.fn(async () => {
        throw new Error('bad key');
      }),
      isUserOptedOut: jest.fn(async () => true),
      getTrackingConsent: jest.fn(async () => 'denied'),
    });
    const { default: Joryio } = loadSdk(native, 'android');
    const init = Joryio.initialize('jry_sdk_android_WRONG', 'h');
    const optedOut = Joryio.isUserOptedOut();
    const consent = Joryio.getTrackingConsent();
    await init;
    expect(await optedOut).toBe(true);
    expect(await consent).toBe('denied');
    // Once at load (contract v8 83), once for the getter.
    expect(native.isUserOptedOut).toHaveBeenCalledTimes(2);
  });

  it('see a decision made in the failing window (probe P3)', async () => {
    const { native } = failingThenWorking();
    const { default: Joryio } = loadSdk(native, 'android');
    const first = Joryio.initialize('jry_sdk_android_WRONG', 'h');
    Joryio.optOut();
    const asked = Joryio.isUserOptedOut();
    await first;
    expect(await asked).toBe(true);
    expect(await Joryio.isUserOptedOut()).toBe(true);
  });

  it('wait for an in-flight initialize() that succeeds, then ask native', async () => {
    const order: string[] = [];
    const native = makeNative({
      initialize: jest.fn(async () => {
        order.push('initialize');
        return null;
      }),
      optOut: jest.fn(() => order.push('optOut')),
      isUserOptedOut: jest.fn(async () => {
        order.push('isUserOptedOut');
        return true;
      }),
    });
    const { default: Joryio } = loadSdk(native, 'ios');
    const init = Joryio.initialize('jry_sdk_ios_x', 'h');
    Joryio.optOut();
    const asked = Joryio.isUserOptedOut();
    await init;
    expect(await asked).toBe(true);
    // The first read is the one at load, ahead of everything (contract v8 83).
    expect(order).toEqual(['isUserOptedOut', 'initialize', 'optOut', 'isUserOptedOut']);
  });
});

describe('S3: getTrackingConsent() passes native through', () => {
  it("answers native's 'granted' before initialize() with nothing stored", async () => {
    const native = makeNative({ getTrackingConsent: jest.fn(async () => 'granted') });
    const { default: Joryio } = loadSdk(native, 'android');
    expect(await Joryio.getTrackingConsent()).toBe('granted');
    expect(native.initialize).not.toHaveBeenCalled();
  });
});

describe('S4: notificationChannelName', () => {
  it('reaches native initialize() in the config', async () => {
    const native = makeNative();
    const { default: Joryio } = loadSdk(native, 'android');
    await Joryio.initialize('jry_sdk_android_x', 'h', { notificationChannelName: 'התראות' });
    expect(native.initialize.mock.calls[0][2]).toEqual({ notificationChannelName: 'התראות' });
  });

  it('is read by the Android bridge into the native config', () => {
    const kt = fs.readFileSync(
      path.join(__dirname, '../android/src/main/java/io/joryio/reactnative/JoryioModule.kt'),
      'utf8',
    );
    expect(kt).toMatch(/optString\("notificationChannelName"\)[\s\S]{0,120}copy\(notificationChannelName = it\)/);
  });
});

describe('N1: an SDK-auth token set before initialize()', () => {
  it('goes to native before initialize(), so native applies it ahead of init side effects', async () => {
    const native = makeNative();
    const { default: Joryio } = loadSdk(native, 'ios');
    Joryio.setSdkAuthenticationToken('jwt');
    expect(native.setSdkAuthenticationToken).toHaveBeenCalledWith('jwt');
    await Joryio.initialize('jry_sdk_ios_x', 'h');
    expect(native.setSdkAuthenticationToken.mock.invocationCallOrder[0]).toBeLessThan(
      native.initialize.mock.invocationCallOrder[0],
    );
  });

  it('stays behind a held identify() it belongs to', async () => {
    const native = makeNative();
    const { default: Joryio } = loadSdk(native, 'ios');
    Joryio.identify('u1');
    Joryio.setSdkAuthenticationToken('jwt-u1');
    expect(native.setSdkAuthenticationToken).not.toHaveBeenCalled();
    await Joryio.initialize('jry_sdk_ios_x', 'h');
    await flush();
    expect(native.identify.mock.invocationCallOrder[0]).toBeLessThan(
      native.setSdkAuthenticationToken.mock.invocationCallOrder[0],
    );
  });

  it('stays behind a held reset(), which would otherwise retire it', async () => {
    const native = makeNative();
    const { default: Joryio } = loadSdk(native, 'ios');
    Joryio.reset();
    Joryio.setSdkAuthenticationToken('jwt-next');
    expect(native.setSdkAuthenticationToken).not.toHaveBeenCalled();
    await Joryio.initialize('jry_sdk_ios_x', 'h');
    await flush();
    expect(native.reset.mock.invocationCallOrder[0]).toBeLessThan(
      native.setSdkAuthenticationToken.mock.invocationCallOrder[0],
    );
  });
});

describe('N3: NaN inside class instances (probe P5)', () => {
  class Line {
    constructor(public productId: string, public price: number, public quantity: number) {}
  }

  it('is dropped from a track() property and a cart line', async () => {
    const native = makeNative();
    const { default: Joryio } = loadSdk(native, 'android');
    await Joryio.initialize('jry_sdk_android_x', 'h');
    Joryio.track('t', { obj: new Line('p', 1, NaN) });
    Joryio.ecommerce.cartViewed([new Line('p', 1, NaN) as never], 1);
    await flush();
    expect(native.track.mock.calls[0][1]).toEqual({ obj: { productId: 'p', price: 1 } });
    expect(native.ecommerce.mock.calls[0][1].items).toEqual([{ productId: 'p', price: 1 }]);
  });

  it('leaves an instance with nothing to drop untouched, and a Date as a value', async () => {
    const native = makeNative();
    const { default: Joryio } = loadSdk(native, 'android');
    await Joryio.initialize('jry_sdk_android_x', 'h');
    const line = new Line('p', 1, 2);
    const at = new Date(0);
    Joryio.track('t', { line, at });
    await flush();
    expect(native.track.mock.calls[0][1].line).toBe(line);
    expect(native.track.mock.calls[0][1].at).toBe(at);
  });
});

describe('N8 / v6 69: a push token is trimmed, like both native SDKs', () => {
  it('registers an APNs token read with a trailing newline on iOS (probe P8)', async () => {
    const native = makeNative({
      registerPushToken: jest.fn(async () => ({ success: true, isRetryable: false, isUnauthorized: false })),
    });
    const { default: Joryio } = loadSdk(native, 'ios');
    await Joryio.initialize('jry_sdk_ios_x', 'h');
    const token = 'a'.repeat(64);
    const result = await Joryio.registerPushToken(`${token}\n`);
    expect(result.success).toBe(true);
    expect(native.registerPushToken).toHaveBeenCalledWith(token);
  });

  it('refuses an iOS token longer than 200 hex digits, the iOS SDK and backend bound', async () => {
    const native = makeNative({
      registerPushToken: jest.fn(async () => ({ success: true, isRetryable: false, isUnauthorized: false })),
    });
    const { default: Joryio } = loadSdk(native, 'ios');
    await Joryio.initialize('jry_sdk_ios_x', 'h');
    const refused = await Joryio.registerPushToken('ab'.repeat(101));
    expect(refused).toMatchObject({ success: false, isRetryable: false });
    expect(native.registerPushToken).not.toHaveBeenCalled();
    expect((await Joryio.registerPushToken('ab'.repeat(100))).success).toBe(true);
    expect(native.registerPushToken).toHaveBeenCalledTimes(1);
  });

  it('trims on Android too, and a blank token is still refused', async () => {
    const native = makeNative({
      registerPushToken: jest.fn(async () => ({ success: true, isRetryable: false, isUnauthorized: false })),
    });
    const { default: Joryio } = loadSdk(native, 'android');
    await Joryio.initialize('jry_sdk_android_x', 'h');
    await Joryio.registerPushToken('  fcm-token ');
    expect(native.registerPushToken).toHaveBeenCalledWith('fcm-token');
    expect((await Joryio.registerPushToken('  ')).success).toBe(false);
    expect(native.registerPushToken).toHaveBeenCalledTimes(1);
  });
});

describe('N8: the Android bridge settles isUserOptedOut on a throw', () => {
  it('wraps the native read like getTrackingConsent', () => {
    const kt = fs.readFileSync(
      path.join(__dirname, '../android/src/main/java/io/joryio/reactnative/JoryioModule.kt'),
      'utf8',
    );
    const body = kt.slice(kt.indexOf('fun isUserOptedOut('), kt.indexOf('fun updateConsent('));
    expect(body).toMatch(/try\s*\{[\s\S]*Joryio\.isUserOptedOut\(\)[\s\S]*catch/);
  });
});
