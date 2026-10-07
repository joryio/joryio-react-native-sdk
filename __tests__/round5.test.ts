/**
 * Scan 5 (1.3.0 round 5). Each test here failed on the round-4 code
 * (release/sdk-1.3.0 at 44379f8e1); the scan's probes are the origin of most.
 */
import { flush, loadSdk, makeNative } from './helpers';

beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
});

const LINE = { productId: 'p1', name: 'Buds', price: 10, quantity: 1 };

/** Run every listener the bridge registered for an event, as RN does. */
function emit(native: ReturnType<typeof makeNative>, event: string, payload: unknown): void {
  for (const listener of native.__listeners.get(event) ?? []) listener(payload);
}

describe('S2: a failed initialize() followed by a successful one', () => {
  it('keeps the listener hand-offs and every withdrawal (probe P1)', async () => {
    let attempt = 0;
    const native = makeNative({
      initialize: jest.fn(async () => {
        attempt += 1;
        if (attempt === 1) throw new Error('bad key');
        return null;
      }),
    });
    const { default: Joryio } = loadSdk(native);
    Joryio.onInAppMessage(() => {});
    Joryio.onSdkAuthenticationError(() => {});
    Joryio.setSubscription('email', 'unsubscribed');
    await Joryio.initialize('jry_sdk_android_WRONG', 'h');
    // Made while the SDK is failed: held for the retry.
    Joryio.removeFromSubscriptionGroup('g1', 'email');
    Joryio.unregisterPush();
    expect(native.enableInAppMessages).not.toHaveBeenCalled();
    await Joryio.initialize('jry_sdk_android_ok', 'h');
    await flush();
    expect(native.enableInAppMessages).toHaveBeenCalledTimes(1);
    expect(native.enableSdkAuthenticationErrors).toHaveBeenCalledTimes(1);
    expect(native.setSubscription).toHaveBeenCalledWith('email', 'unsubscribed');
    expect(native.removeFromSubscriptionGroup).toHaveBeenCalledWith('g1', 'email');
    expect(native.unregisterPush).toHaveBeenCalledTimes(1);
    // ...and after the second initialize(), in call order.
    expect(native.initialize.mock.invocationCallOrder[1]).toBeLessThan(
      native.enableInAppMessages.mock.invocationCallOrder[0],
    );
  });
});

describe('v5 51: a full pre-init hold never drops a withdrawal before data', () => {
  it('an unsubscribe followed by 1000 track() calls is kept (probe P3)', async () => {
    const native = makeNative();
    const { default: Joryio, MAX_PRE_INIT_CALLS } = loadSdk(native);
    Joryio.setSubscription('email', 'unsubscribed');
    Joryio.unregisterPush();
    for (let i = 0; i < MAX_PRE_INIT_CALLS; i++) Joryio.track('e' + i);
    await Joryio.initialize('jry_sdk_ios_x', 'h');
    await flush();
    expect(native.setSubscription).toHaveBeenCalledWith('email', 'unsubscribed');
    expect(native.unregisterPush).toHaveBeenCalledTimes(1);
    // Room was made by dropping the OLDEST data calls.
    expect(native.track).toHaveBeenCalledTimes(MAX_PRE_INIT_CALLS - 2);
    expect(native.track.mock.calls[0][0]).toBe('e2');
  });

  it('a decision queued behind an in-flight initialize() is kept over data', async () => {
    let finish: () => void = () => {};
    const native = makeNative({
      initialize: jest.fn(() => new Promise<null>((resolve) => { finish = () => resolve(null); })),
    });
    const { default: Joryio, MAX_PRE_INIT_CALLS } = loadSdk(native);
    const init = Joryio.initialize('jry_sdk_ios_x', 'h');
    Joryio.optIn();
    for (let i = 0; i < MAX_PRE_INIT_CALLS; i++) Joryio.track('e' + i);
    finish();
    await init;
    expect(native.optIn).toHaveBeenCalledTimes(1);
  });
});

describe('Unity S3 cross-check: unregisterPush() before initialize()', () => {
  it('is held through a pre-init optOut, denial and wipe, and delivered', async () => {
    const native = makeNative();
    const { default: Joryio } = loadSdk(native);
    Joryio.unregisterPush();
    Joryio.optOut();
    Joryio.updateConsent('denied');
    Joryio.wipeData();
    await Joryio.initialize('jry_sdk_ios_x', 'h');
    expect(native.unregisterPush).toHaveBeenCalledTimes(1);
    // Handed to native ahead of the wipe (see the N4 test below), which native
    // buffers and runs before erasing.
    expect(native.unregisterPush.mock.invocationCallOrder[0]).toBeLessThan(
      native.wipeData.mock.invocationCallOrder[0],
    );
  });
});

describe('N4 (integration): withdrawals held before a pre-init wipeData()', () => {
  it('reach native BEFORE the wipe, so native runs them under the erased identity', async () => {
    // Fails before: they stayed held in JS and replayed after native's init,
    // which had already run the wipe - sent under the new anonymous id.
    const native = makeNative();
    const { default: Joryio } = loadSdk(native);
    Joryio.setSubscription('email', 'unsubscribed');
    Joryio.removeFromSubscriptionGroup('g1', 'email');
    Joryio.track('erased with the wipe');
    Joryio.wipeData();
    Joryio.setSubscription('sms', 'unsubscribed');
    await Joryio.initialize('jry_sdk_ios_x', 'h');
    await flush();
    const order = (fn: jest.Mock, n = 0) => fn.mock.invocationCallOrder[n];
    expect(order(native.setSubscription)).toBeLessThan(order(native.wipeData));
    expect(order(native.removeFromSubscriptionGroup)).toBeLessThan(order(native.wipeData));
    // The unsubscribe made after the wipe belongs to the new identity: after init.
    expect(native.setSubscription).toHaveBeenNthCalledWith(2, 'sms', 'unsubscribed');
    expect(order(native.initialize)).toBeLessThan(order(native.setSubscription, 1));
    expect(native.track).not.toHaveBeenCalled();
  });
});

describe('N3: an SDK-auth token held before a pre-init wipeData()', () => {
  // Round 6 (scan 6 N1): a token set before initialize() has started goes to
  // native at once, so native applies it before init's first requests. The
  // wipe after it is then native's to apply - Android drops a token buffered
  // before its pre-init wipe, iOS retires it at that wipe - so the property
  // pinned here is the ORDER native sees: A ahead of the wipe, B (set after
  // the wipe) only after initialize(), never ahead of the wipe that would
  // retire it.
  it('is never handed to the next visitor after the wipe (probe P4)', async () => {
    const native = makeNative();
    const { default: Joryio } = loadSdk(native);
    Joryio.setSdkAuthenticationToken('jwt-for-A');
    Joryio.wipeData();
    Joryio.setSdkAuthenticationToken('jwt-for-B');
    await Joryio.initialize('jry_sdk_ios_x', 'h');
    expect(native.setSdkAuthenticationToken.mock.calls).toEqual([['jwt-for-A'], ['jwt-for-B']]);
    const [a, b] = native.setSdkAuthenticationToken.mock.invocationCallOrder;
    expect(a).toBeLessThan(native.wipeData.mock.invocationCallOrder[0]);
    expect(native.initialize.mock.invocationCallOrder[0]).toBeLessThan(b);
  });

  it('a token held behind an in-flight init is still dropped by a wipe made in that window', async () => {
    const native = makeNative();
    const { default: Joryio } = loadSdk(native);
    const init = Joryio.initialize('jry_sdk_ios_x', 'h');
    Joryio.setSdkAuthenticationToken('jwt-for-A');
    Joryio.wipeData();
    Joryio.setSdkAuthenticationToken('jwt-for-B');
    await init;
    await flush();
    expect(native.setSdkAuthenticationToken.mock.calls).toEqual([['jwt-for-B']]);
  });

  it('an opt-out keeps it (it collects nothing)', async () => {
    const native = makeNative();
    const { default: Joryio } = loadSdk(native);
    Joryio.setSdkAuthenticationToken('jwt');
    Joryio.optOut();
    await Joryio.initialize('jry_sdk_ios_x', 'h');
    expect(native.setSdkAuthenticationToken).toHaveBeenCalledWith('jwt');
  });
});

describe('S6 / v5 56: host callbacks are wrapped', () => {
  it('a throwing onInAppMessage callback neither throws into the dispatch nor starves the next listener', async () => {
    const native = makeNative();
    const { default: Joryio } = loadSdk(native);
    const second = jest.fn();
    Joryio.onInAppMessage(() => {
      throw new Error('renderer met an unknown kind');
    });
    Joryio.onInAppMessage(second);
    expect(() => emit(native, 'JoryioInAppMessage', { id: 'c1' })).not.toThrow();
    expect(second).toHaveBeenCalledWith({ id: 'c1' });
    expect((console.warn as jest.Mock).mock.calls.flat().join(' ')).toContain('onInAppMessage callback threw');
  });

  it('a throwing or rejecting onSdkAuthenticationError callback is caught', async () => {
    const native = makeNative();
    const { default: Joryio } = loadSdk(native);
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    try {
      Joryio.onSdkAuthenticationError(() => {
        throw new Error('sync');
      });
      Joryio.onSdkAuthenticationError(async () => {
        throw new Error('async');
      });
      expect(() => emit(native, 'JoryioSdkAuthError', { reason: 'expired' })).not.toThrow();
      await flush();
      await flush();
      expect(unhandled).not.toHaveBeenCalled();
      const text = (console.warn as jest.Mock).mock.calls.flat().map(String).join(' ');
      expect(text).toContain('Error: sync');
      expect(text).toContain('Error: async');
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});

describe('B1 / v5 59: an FCM token registered on iOS', () => {
  it('is refused on iOS, without reaching native, and not retryable', async () => {
    const native = makeNative({ registerPushToken: jest.fn().mockResolvedValue({ success: true }) });
    const { default: Joryio } = loadSdk(native, 'ios');
    await Joryio.initialize('jry_sdk_ios_x', 'h');
    const fcm = 'dQw4w9WgXcQ:APA91bHun4MxP5egoKMwt2KZFBaFUH-1RYqx';
    await expect(Joryio.registerPushToken(fcm)).resolves.toMatchObject({ success: false, isRetryable: false });
    expect(native.registerPushToken).not.toHaveBeenCalled();
  });

  it('an APNs token (hex) passes on iOS; any token passes on Android', async () => {
    const apns = 'a1'.repeat(32);
    const ios = makeNative({ registerPushToken: jest.fn().mockResolvedValue({ success: true }) });
    const { default: OnIos } = loadSdk(ios, 'ios');
    await OnIos.initialize('jry_sdk_ios_x', 'h');
    await expect(OnIos.registerPushToken(apns)).resolves.toMatchObject({ success: true });

    const android = makeNative({ registerPushToken: jest.fn().mockResolvedValue({ success: true }) });
    const { default: OnAndroid } = loadSdk(android, 'android');
    await OnAndroid.initialize('jry_sdk_android_x', 'h');
    await expect(OnAndroid.registerPushToken('fcm:token-with-colon')).resolves.toMatchObject({ success: true });
  });
});

describe('S1: null cart and order lines', () => {
  it('never reach native, so the whole order is not refused there (probe P2)', async () => {
    const native = makeNative();
    const { default: Joryio } = loadSdk(native);
    await Joryio.initialize('jry_sdk_ios_x', 'h');
    Joryio.ecommerce.purchase({ orderId: 'o1', items: [LINE, null as never, undefined as never], value: 10 });
    Joryio.ecommerce.cartViewed([null as never, LINE], 10);
    await flush();
    const [purchase, cart] = native.ecommerce.mock.calls;
    expect(purchase[0]).toBe('purchase');
    expect(purchase[1].order.items).toEqual([LINE]);
    expect(cart[1].items).toEqual([LINE]);
  });
});

describe('S5: submitReview rating', () => {
  it('a rating no 32-bit Int can hold is refused before the bridge (Swift Int(Double) traps)', async () => {
    const native = makeNative();
    const { default: Joryio } = loadSdk(native);
    await Joryio.initialize('jry_sdk_ios_x', 'h');
    Joryio.ecommerce.submitReview('p1', 1e20);
    Joryio.ecommerce.submitReview('p1', -3e9);
    Joryio.ecommerce.submitReview('p1', 4);
    await flush();
    expect(native.ecommerce.mock.calls.map((c) => c[1].rating)).toEqual([4]);
  });
});

describe('v5 49 / N4: NaN and Infinity', () => {
  it('an optional e-commerce count is left out, and the call still goes (probe P5)', async () => {
    const native = makeNative();
    const { default: Joryio } = loadSdk(native);
    await Joryio.initialize('jry_sdk_ios_x', 'h');
    Joryio.ecommerce.removeFromCart({ productId: 'p', name: 'n', price: 1 }, NaN);
    Joryio.ecommerce.addToCart({ productId: 'p', name: 'n', price: 1, quantity: Infinity });
    Joryio.ecommerce.search('shoes', NaN);
    await flush();
    const [remove, add, search] = native.ecommerce.mock.calls.map((c) => c[1]);
    expect(remove).toEqual({ product: { productId: 'p', name: 'n', price: 1 } });
    expect(add.item).toEqual({ productId: 'p', name: 'n', price: 1 });
    expect(search).toEqual({ query: 'shoes' });
  });

  it('setAttribute(key, NaN) is ignored - over the bridge it would arrive as null, an unset', async () => {
    const native = makeNative();
    const { default: Joryio } = loadSdk(native);
    await Joryio.initialize('jry_sdk_ios_x', 'h');
    Joryio.setAttribute('score', NaN);
    Joryio.setAttributes({ plan: 'pro', ltv: Infinity });
    expect(native.setAttribute).not.toHaveBeenCalled();
    expect(native.unsetAttribute).not.toHaveBeenCalled();
    expect(native.setAttributes).toHaveBeenCalledWith({ plan: 'pro' });
  });

  it('a non-finite event property is left out at any depth; the event is sent', async () => {
    const native = makeNative();
    const { default: Joryio } = loadSdk(native);
    await Joryio.initialize('jry_sdk_ios_x', 'h');
    const when = new Date(0);
    Joryio.track('Played', { score: NaN, level: 3, nested: { a: -Infinity, b: 'x' }, list: [1, NaN, 2], when });
    Joryio.trackScreen('Home', { ratio: Infinity });
    expect(native.track).toHaveBeenCalledWith('Played', { level: 3, nested: { b: 'x' }, list: [1, 2], when });
    expect(native.trackScreen).toHaveBeenCalledWith('Home', {});
    expect((console.warn as jest.Mock).mock.calls.flat().join(' ')).toContain('score, nested.a, list[1]');
  });
});

describe('N8: logLevel', () => {
  it('reaches both bridges lower-cased', async () => {
    const native = makeNative();
    const { default: Joryio } = loadSdk(native);
    await Joryio.initialize('jry_sdk_ios_x', 'h', { logLevel: 'Warn' as never });
    expect(native.initialize.mock.calls[0][2]).toMatchObject({ logLevel: 'warn' });
  });
});
