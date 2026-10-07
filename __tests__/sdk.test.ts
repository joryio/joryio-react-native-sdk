import { flush, loadSdk, makeNative } from './helpers';

beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe('readiness and the pre-init queue', () => {
  it('replays calls made before initialize(), in order', async () => {
    const native = makeNative();
    const { default: Joryio } = loadSdk(native);
    Joryio.track('a');
    Joryio.identify('u1');
    expect(native.track).not.toHaveBeenCalled();
    await Joryio.initialize('key', 'host');
    expect(native.track).toHaveBeenCalledWith('a', {});
    expect(native.identify).toHaveBeenCalledWith('u1');
    expect(native.track.mock.invocationCallOrder[0]).toBeLessThan(
      native.identify.mock.invocationCallOrder[0],
    );
  });

  it('bounds the calls held while initialize() has not run, dropping the oldest', async () => {
    const native = makeNative();
    const { default: Joryio, MAX_PRE_INIT_CALLS } = loadSdk(native);
    for (let i = 0; i < MAX_PRE_INIT_CALLS + 5; i++) Joryio.track(`e${i}`);
    await Joryio.initialize('key', 'host');
    expect(native.track).toHaveBeenCalledTimes(MAX_PRE_INIT_CALLS);
    expect(native.track.mock.calls[0][0]).toBe('e5');
  });

  it('keeps held calls when initialize() fails (until one succeeds), and never throws', async () => {
    const native = makeNative({ initialize: jest.fn().mockRejectedValue(new Error('bad key')) });
    const { default: Joryio } = loadSdk(native);
    Joryio.track('a');
    await expect(Joryio.initialize('key', 'host')).resolves.toBeUndefined();
    Joryio.track('b');
    expect(native.track).not.toHaveBeenCalled();
  });
});

describe('isUserOptedOut', () => {
  it('answers false instead of throwing when the native module is not linked', async () => {
    const { default: Joryio } = loadSdk(null);
    await expect(Joryio.isUserOptedOut()).resolves.toBe(false);
  });

  // Scan 4 #6: before initialize() it waited five seconds and answered
  // `false` - "not opted out" for a person whose opt-out is stored. Both
  // native SDKs answer from stored state before init, so native is asked.
  it('before initialize() asks native straight away (stored state)', async () => {
    const native = makeNative({
      isUserOptedOut: jest.fn().mockResolvedValue(true),
      getTrackingConsent: jest.fn().mockResolvedValue('denied'),
    });
    const { default: Joryio } = loadSdk(native);
    // No fake timers: the old code waits 5 s here and the test times out.
    await expect(Joryio.isUserOptedOut()).resolves.toBe(true);
    await expect(Joryio.getTrackingConsent()).resolves.toBe('denied');
    expect(native.initialize).not.toHaveBeenCalled();
  });

  it('after a failed initialize() still answers from native', async () => {
    const native = makeNative({
      initialize: jest.fn().mockRejectedValue(new Error('bad key')),
      isUserOptedOut: jest.fn().mockResolvedValue(true),
      getTrackingConsent: jest.fn().mockResolvedValue('pending'),
    });
    const { default: Joryio } = loadSdk(native);
    await Joryio.initialize('key', 'host');
    await expect(Joryio.isUserOptedOut()).resolves.toBe(true);
    await expect(Joryio.getTrackingConsent()).resolves.toBe('pending');
  });

  it('waits for an initialize() that is in flight, so a decision queued behind it is seen', async () => {
    let finishInit: () => void = () => {};
    const native = makeNative({
      initialize: jest.fn(() => new Promise<null>((resolve) => { finishInit = () => resolve(null); })),
      isUserOptedOut: jest.fn().mockResolvedValue(true),
    });
    const { default: Joryio } = loadSdk(native);
    // The one read at load, for the decisions stored by an earlier launch
    // (contract v8 83); the getter below is a separate ask.
    expect(native.isUserOptedOut).toHaveBeenCalledTimes(1);
    native.isUserOptedOut.mockClear();
    const init = Joryio.initialize('key', 'host');
    const answer = Joryio.isUserOptedOut();
    await flush();
    expect(native.isUserOptedOut).not.toHaveBeenCalled();
    finishInit();
    await init;
    await expect(answer).resolves.toBe(true);
  });
});

describe('getters never throw into the host app', () => {
  it('answer their default when native rejects', async () => {
    const native = makeNative({ getUserId: jest.fn().mockRejectedValue(new Error('boom')) });
    const { default: Joryio } = loadSdk(native);
    await Joryio.initialize('key', 'host');
    await expect(Joryio.getUserId()).resolves.toBeNull();
  });
});

describe('attributes', () => {
  it('setAttributes sends null values as unsets, never as values', async () => {
    const native = makeNative();
    const { default: Joryio } = loadSdk(native);
    await Joryio.initialize('key', 'host');
    Joryio.setAttributes({ plan: 'pro', nickname: null, age: 3 });
    expect(native.setAttributes).toHaveBeenCalledWith({ plan: 'pro', age: 3 });
    expect(native.unsetAttribute).toHaveBeenCalledWith('nickname');
  });

  it('setAttributes with only nulls sends no setAttributes call', async () => {
    const native = makeNative();
    const { default: Joryio } = loadSdk(native);
    await Joryio.initialize('key', 'host');
    Joryio.setAttributes({ nickname: null });
    expect(native.setAttributes).not.toHaveBeenCalled();
    expect(native.unsetAttribute).toHaveBeenCalledWith('nickname');
  });

  it('setAttribute(key, null) unsets', async () => {
    const native = makeNative();
    const { default: Joryio } = loadSdk(native);
    await Joryio.initialize('key', 'host');
    Joryio.setAttribute('nickname', null);
    expect(native.setAttribute).not.toHaveBeenCalled();
    expect(native.unsetAttribute).toHaveBeenCalledWith('nickname');
  });
});

describe('identity', () => {
  it('has no unlabelled alias()', () => {
    const { default: Joryio } = loadSdk(makeNative());
    expect((Joryio as unknown as Record<string, unknown>).alias).toBeUndefined();
  });

  it('addAlias forwards label and name, before identify too', async () => {
    const native = makeNative();
    const { default: Joryio } = loadSdk(native);
    await Joryio.initialize('key', 'host');
    Joryio.addAlias('crm_id', 'C-1042');
    expect(native.addAlias).toHaveBeenCalledWith('crm_id', 'C-1042');
  });

  it('addAlias ignores an empty label or name', async () => {
    const native = makeNative();
    const { default: Joryio } = loadSdk(native);
    await Joryio.initialize('key', 'host');
    Joryio.addAlias('', 'x');
    Joryio.addAlias('crm_id', '');
    expect(native.addAlias).not.toHaveBeenCalled();
  });
});

describe('tracking consent', () => {
  it('passes trackingConsent and optOut to native initialize', async () => {
    const native = makeNative();
    const { default: Joryio } = loadSdk(native);
    await Joryio.initialize('key', 'host', { trackingConsent: 'pending', optOut: true });
    expect(native.initialize).toHaveBeenCalledWith('key', 'host', {
      trackingConsent: 'pending',
      optOut: true,
    });
  });

  it('updateConsent forwards granted/denied and rejects anything else', async () => {
    const native = makeNative();
    const { default: Joryio } = loadSdk(native);
    await Joryio.initialize('key', 'host');
    Joryio.updateConsent('granted');
    Joryio.updateConsent('maybe' as 'granted');
    expect(native.updateConsent).toHaveBeenCalledTimes(1);
    expect(native.updateConsent).toHaveBeenCalledWith('granted');
  });

  // Scan 4 #4: Android parsed the config value case-insensitively and iOS
  // did not, so `'Denied'` started Android denied and iOS undecided.
  it('sends trackingConsent to native in lowercase, and leaves an unknown value unset', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const native = makeNative();
    const { default: Joryio } = loadSdk(native);
    await Joryio.initialize('key', 'host', { trackingConsent: 'Denied' as 'denied' });
    expect(native.initialize).toHaveBeenLastCalledWith('key', 'host', { trackingConsent: 'denied' });

    const other = makeNative();
    const { default: Second } = loadSdk(other);
    await Second.initialize('key', 'host', { trackingConsent: 'yes' as 'granted', optOut: false });
    expect(other.initialize).toHaveBeenLastCalledWith('key', 'host', { optOut: false });
    expect(warnSpy.mock.calls.flat().join('\n')).toContain("trackingConsent takes 'granted', 'denied' or 'pending'");
  });

  it('updateConsent accepts any letter case and forwards the lowercase spelling', async () => {
    const native = makeNative();
    const { default: Joryio } = loadSdk(native);
    await Joryio.initialize('key', 'host');
    Joryio.updateConsent('GRANTED' as 'granted');
    expect(native.updateConsent).toHaveBeenCalledWith('granted');
  });

  // Parity: web, Android, iOS and Unity have wipeData(); React Native did not.
  it('wipeData forwards to the native module', async () => {
    const native = makeNative();
    const { default: Joryio } = loadSdk(native);
    await Joryio.initialize('key', 'host');
    Joryio.wipeData();
    expect(native.wipeData).toHaveBeenCalledTimes(1);
  });
});

describe('push registration', () => {
  it('is NOT retryable after initialize() failed', async () => {
    const native = makeNative({ initialize: jest.fn().mockRejectedValue(new Error('bad key')) });
    const { default: Joryio } = loadSdk(native);
    await Joryio.initialize('key', 'host');
    const r = await Joryio.registerPushToken('tok');
    expect(r).toMatchObject({ success: false, isRetryable: false });
    expect(native.registerPushToken).not.toHaveBeenCalled();
  });

  // Scan 4 #2: a caller already waiting when initialize() FAILED was told the
  // SDK was ready (readiness settles on failure too) and went on to the
  // uninitialized native module, whose promise never settles - so the host's
  // await hung forever.
  it('a promise waiting when initialize() fails settles at once and never reaches native', async () => {
    let failInit: () => void = () => {};
    const never = () => new Promise<never>(() => {});
    const native = makeNative({
      initialize: jest.fn(() => new Promise<null>((_, reject) => { failInit = () => reject(new Error('refused')); })),
      registerPushToken: jest.fn(never),
      getAnonymousId: jest.fn(never),
      requestPushPermission: jest.fn(never),
      submitInAppForm: jest.fn(never),
    });
    const { default: Joryio } = loadSdk(native);
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const init = Joryio.initialize('key', 'host');
    const push = Joryio.registerPushToken('tok');
    const anon = Joryio.getAnonymousId();
    const permission = Joryio.requestPushPermission();
    const form = Joryio.submitInAppForm('c1', { email: 'a@b.c' });
    await flush();
    failInit();
    await init;

    const HUNG = Symbol('hung');
    const settled = <T>(p: Promise<T>) =>
      Promise.race([p, new Promise<typeof HUNG>((r) => setTimeout(() => r(HUNG), 200))]);
    await expect(settled(push)).resolves.toEqual({
      success: false,
      message: 'SDK initialization failed',
      isUnauthorized: false,
      isRetryable: false,
    });
    await expect(settled(anon)).resolves.toBe('');
    await expect(settled(permission)).resolves.toBe('unavailable');
    await expect(settled(form)).resolves.toMatchObject({ ok: false });
    expect(native.registerPushToken).not.toHaveBeenCalled();
    expect(native.getAnonymousId).not.toHaveBeenCalled();
    expect(native.requestPushPermission).not.toHaveBeenCalled();
    expect(native.submitInAppForm).not.toHaveBeenCalled();
  });

  it('IS retryable when initialize() simply has not run yet', async () => {
    jest.useFakeTimers();
    try {
      const { default: Joryio } = loadSdk(makeNative());
      const pending = Joryio.registerPushToken('tok');
      await jest.advanceTimersByTimeAsync(6000);
      await expect(pending).resolves.toMatchObject({ success: false, isRetryable: true });
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('in-app messages', () => {
  it('hands rendering back to native when the last listener unsubscribes', async () => {
    const native = makeNative();
    const { default: Joryio } = loadSdk(native);
    await Joryio.initialize('key', 'host');
    const offA = Joryio.onInAppMessage(() => {});
    const offB = Joryio.onInAppMessage(() => {});
    expect(native.enableInAppMessages).toHaveBeenCalledTimes(2);

    offA();
    expect(native.disableInAppMessages).not.toHaveBeenCalled();
    offA(); // idempotent: must not count as B's removal
    expect(native.disableInAppMessages).not.toHaveBeenCalled();

    offB();
    expect(native.disableInAppMessages).toHaveBeenCalledTimes(1);
    expect(native.__listeners.get('JoryioInAppMessage')?.size ?? 0).toBe(0);
  });

  it('keeps enable and disable in order when both happen before initialize()', async () => {
    const native = makeNative();
    const { default: Joryio } = loadSdk(native);
    const off = Joryio.onInAppMessage(() => {});
    off();
    await Joryio.initialize('key', 'host');
    expect(native.enableInAppMessages.mock.invocationCallOrder[0]).toBeLessThan(
      native.disableInAppMessages.mock.invocationCallOrder[0],
    );
  });

  it('an empty capability list means "not declared" (null), the same on both platforms', async () => {
    const native = makeNative();
    const { default: Joryio } = loadSdk(native);
    await Joryio.initialize('key', 'host');
    Joryio.enableInAppMessages([]);
    Joryio.onInAppMessage(() => {}, { capabilities: [] });
    Joryio.onInAppMessage(() => {}, { capabilities: ['content.native'] });
    expect(native.enableInAppMessages.mock.calls).toEqual([[null], [null], [['content.native']]]);
  });
});

describe('without a native module', () => {
  it('every public method is a safe no-op', async () => {
    const { default: Joryio } = loadSdk(null);
    expect(() => {
      Joryio.track('x');
      Joryio.addAlias('a', 'b');
      Joryio.updateConsent('granted');
      Joryio.setAttributes({ a: null });
      Joryio.onInAppMessage(() => {})();
      Joryio.disableInAppMessages();
    }).not.toThrow();
    await expect(Joryio.submitInAppForm('c', {})).resolves.toMatchObject({ ok: false });
    await expect(Joryio.requestPushPermission()).resolves.toBe('unavailable');
  });
});

describe('null and undefined from host code (contract item 19)', () => {
  it('a null config value is left out, so native applies its default', async () => {
    const native = makeNative();
    const { default: Joryio } = loadSdk(native);
    await Joryio.initialize('key', 'host', {
      batchSize: null as unknown as number,
      flushInterval: undefined,
      enableDebug: true,
      logLevel: null as unknown as 'debug',
    });
    expect(native.initialize).toHaveBeenCalledWith('key', 'host', { enableDebug: true });
  });

  it('a null config object is an empty one', async () => {
    const native = makeNative();
    const { default: Joryio } = loadSdk(native);
    await Joryio.initialize('key', 'host', null as unknown as object);
    expect(native.initialize).toHaveBeenCalledWith('key', 'host', {});
  });

  it('a null sdkKey warns and does not switch the SDK off', async () => {
    const native = makeNative();
    const { default: Joryio } = loadSdk(native);
    await Joryio.initialize(null as unknown as string, 'host');
    expect(native.initialize).not.toHaveBeenCalled();
    Joryio.track('held');
    await Joryio.initialize('key', 'host');
    expect(native.track).toHaveBeenCalledWith('held', {});
  });

  it('null required arguments warn and never reach native', async () => {
    const native = makeNative();
    const { default: Joryio } = loadSdk(native);
    await Joryio.initialize('key', 'host');
    const N = null as unknown as string;
    Joryio.track(N);
    Joryio.trackScreen(undefined as unknown as string);
    Joryio.identify(undefined as unknown as string);
    Joryio.addAlias(N, N);
    Joryio.setSdkAuthenticationToken(N);
    Joryio.setSubscription(N as 'email', N as 'subscribed');
    Joryio.addToSubscriptionGroup(N, N as 'email');
    Joryio.removeFromSubscriptionGroup(N, N as 'email');
    Joryio.setAttribute(N, 'x');
    Joryio.setAttributes(null as unknown as Record<string, string>);
    Joryio.unsetAttribute(N);
    Joryio.incrementAttribute(N, 1);
    Joryio.reportPushDelivered(N);
    Joryio.trackPushClick(N);
    Joryio.trackInAppImpression(N, 'displayed');
    for (const m of [
      'track', 'trackScreen', 'identify', 'addAlias', 'setSdkAuthenticationToken',
      'setSubscription', 'addToSubscriptionGroup', 'removeFromSubscriptionGroup',
      'setAttribute', 'setAttributes', 'unsetAttribute', 'incrementAttribute',
      'reportPushDelivered', 'trackPushClick', 'trackInAppImpression',
    ]) {
      expect([m, native[m].mock.calls.length]).toEqual([m, 0]);
    }
  });

  it('null properties are no properties', async () => {
    const native = makeNative();
    const { default: Joryio } = loadSdk(native);
    await Joryio.initialize('key', 'host');
    Joryio.track('e', null as unknown as Record<string, unknown>);
    Joryio.trackScreen('s', null as unknown as Record<string, unknown>);
    expect(native.track).toHaveBeenCalledWith('e', {});
    expect(native.trackScreen).toHaveBeenCalledWith('s', {});
  });

  it('a null increment step is the default step, a non-number is ignored', async () => {
    const native = makeNative();
    const { default: Joryio } = loadSdk(native);
    await Joryio.initialize('key', 'host');
    Joryio.incrementAttribute('logins', null as unknown as number);
    Joryio.incrementAttribute('logins', 'two' as unknown as number);
    Joryio.incrementAttribute('logins', NaN);
    expect(native.incrementAttribute.mock.calls).toEqual([['logins', 1]]);
  });

  it('a null elementId is sent as null, the full arity every time', async () => {
    const native = makeNative();
    const { default: Joryio } = loadSdk(native);
    await Joryio.initialize('key', 'host');
    Joryio.trackInAppImpression('c1', 'clicked', null as unknown as string);
    Joryio.trackInAppImpression('c1', 'clicked', 'buy');
    expect(native.trackInAppImpression.mock.calls).toEqual([
      ['c1', 'clicked', null],
      ['c1', 'clicked', 'buy'],
    ]);
  });

  it('registerPushToken(null) resolves a non-retryable failure without calling native', async () => {
    const native = makeNative();
    const { default: Joryio } = loadSdk(native);
    await Joryio.initialize('key', 'host');
    await expect(Joryio.registerPushToken(null as unknown as string)).resolves.toMatchObject({
      success: false,
      isRetryable: false,
    });
    expect(native.registerPushToken).not.toHaveBeenCalled();
  });

  it('submitInAppForm with a null campaign resolves ok:false; null values are no values', async () => {
    const native = makeNative({ submitInAppForm: jest.fn().mockResolvedValue({ ok: true }) });
    const { default: Joryio } = loadSdk(native);
    await Joryio.initialize('key', 'host');
    await expect(Joryio.submitInAppForm(null as unknown as string, {})).resolves.toMatchObject({ ok: false });
    await Joryio.submitInAppForm('c1', null as unknown as Record<string, string>);
    expect(native.submitInAppForm.mock.calls).toEqual([['c1', {}]]);
  });

  it('a null callback subscribes nothing and returns a callable unsubscribe', async () => {
    const native = makeNative();
    const { default: Joryio } = loadSdk(native);
    await Joryio.initialize('key', 'host');
    const off = Joryio.onInAppMessage(null as unknown as () => void);
    const offAuth = Joryio.onSdkAuthenticationError(undefined as unknown as () => void);
    expect(() => {
      off();
      offAuth();
    }).not.toThrow();
    expect(native.enableInAppMessages).not.toHaveBeenCalled();
    expect(native.__listeners.get('JoryioInAppMessage')?.size ?? 0).toBe(0);
  });

  it('e-commerce leaves optional arguments out instead of sending null', async () => {
    const native = makeNative();
    const { default: Joryio } = loadSdk(native);
    await Joryio.initialize('key', 'host');
    Joryio.ecommerce.search('shoes');
    Joryio.ecommerce.orderCancelled('o1', null as unknown as string);
    expect(native.ecommerce.mock.calls).toEqual([
      ['search', { query: 'shoes' }],
      ['orderCancelled', { orderId: 'o1' }],
    ]);
  });
});

describe('initialize() after a failed initialize()', () => {
  it('a second, successful initialize() turns the SDK back on', async () => {
    const init = jest.fn().mockRejectedValueOnce(new Error('bad key')).mockResolvedValue(null);
    const native = makeNative({ initialize: init });
    const { default: Joryio } = loadSdk(native);
    await Joryio.initialize('wrong', 'host');
    // Made after the failure: held for the retry, not dropped (scan 5 S2).
    Joryio.track('after failure');
    // Made while the retry is in flight: held and replayed, not discarded.
    const retry = Joryio.initialize('right', 'host');
    Joryio.track('held');
    await retry;
    Joryio.track('live');
    expect(native.track.mock.calls.map((c) => c[0])).toEqual(['after failure', 'held', 'live']);
    await Joryio.getUserId();
    expect(native.getUserId).toHaveBeenCalled();
  });
});

describe('warnings are user-facing text', () => {
  it('the not-initialized warning uses a hyphen, never an em-dash', async () => {
    jest.useFakeTimers();
    try {
      const { default: Joryio } = loadSdk(makeNative());
      const pending = Joryio.getUserId();
      await jest.advanceTimersByTimeAsync(6000);
      await pending;
      const text = (console.warn as jest.Mock).mock.calls.flat().join(' ');
      expect(text).toContain('initialize() has not completed');
      expect(text).not.toContain('—');
    } finally {
      jest.useRealTimers();
    }
  });
});
