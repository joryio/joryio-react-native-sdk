import { flush, loadSdk, makeNative, NativeMock } from './helpers';

/**
 * Privacy decisions made BEFORE initialize() (contract item 25), tested by
 * BEHAVIOUR rather than by reading the source.
 *
 * The fake below behaves the way both native SDKs do: a decision that arrives
 * before its own initialize() is RECORDED and applied inside init, ahead of
 * the init side effects - the Session Start, the in-app sync and the push
 * re-registration. A decision that arrives after init runs after those side
 * effects. `sent` is what reached the network, in order.
 *
 * Before the fix the JS layer held optOut / updateConsent / wipeData in its
 * own queue until native init RESOLVED, so the native SDK started with the
 * default (granted, not opted out) and sent all three side effects first.
 * Every test in the first block fails on that code.
 */
function fakeNative(): { native: NativeMock; sent: string[]; calls: string[] } {
  const sent: string[] = [];
  const calls: string[] = [];
  let started = false;
  let optedOut = false;
  let consent: 'granted' | 'denied' | 'pending' = 'granted';
  let wipePending = false;
  let identity = 'anon-1';
  const canSend = () => !optedOut && consent === 'granted';

  const native = makeNative({
    initialize: jest.fn(async () => {
      calls.push('initialize');
      started = true;
      if (wipePending) {
        identity = 'anon-2';
        wipePending = false;
      }
      if (canSend()) {
        sent.push(`Session Start (${identity})`, `in-app sync (${identity})`, `push register (${identity})`);
      }
      return null;
    }),
    optOut: jest.fn(() => {
      calls.push('optOut');
      if (started && canSend()) sent.push(`tracking_opted_out (${identity})`);
      optedOut = true;
    }),
    optIn: jest.fn(() => {
      calls.push('optIn');
      optedOut = false;
    }),
    updateConsent: jest.fn((c: 'granted' | 'denied' | 'pending') => {
      calls.push(`updateConsent:${c}`);
      consent = c;
    }),
    wipeData: jest.fn(() => {
      calls.push('wipeData');
      if (started) identity = 'anon-2';
      else wipePending = true;
    }),
    track: jest.fn((name: string) => {
      calls.push(`track:${name}`);
      if (canSend()) sent.push(`${name} (${identity})`);
    }),
    identify: jest.fn((id: string) => {
      calls.push(`identify:${id}`);
    }),
  });
  return { native, sent, calls };
}

beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe('a privacy decision made before initialize() is applied before init side effects', () => {
  it('optOut(): no Session Start, in-app sync, push registration or opt-out marker', async () => {
    const { native, sent, calls } = fakeNative();
    const { default: Joryio } = loadSdk(native);
    Joryio.optOut();
    await Joryio.initialize('jry_sdk_key', 'host');
    Joryio.track('After');
    await flush();
    expect(sent).toEqual([]);
    expect(calls.indexOf('optOut')).toBeLessThan(calls.indexOf('initialize'));
  });

  it("updateConsent('denied'): nothing sent at init", async () => {
    const { native, sent, calls } = fakeNative();
    const { default: Joryio } = loadSdk(native);
    Joryio.updateConsent('denied');
    await Joryio.initialize('jry_sdk_key', 'host');
    expect(sent).toEqual([]);
    expect(calls.slice(0, 2)).toEqual(['updateConsent:denied', 'initialize']);
  });

  it("updateConsent('pending'): nothing sent at init, released by a later grant", async () => {
    const { native, sent } = fakeNative();
    const { default: Joryio } = loadSdk(native);
    Joryio.updateConsent('pending');
    await Joryio.initialize('jry_sdk_key', 'host');
    expect(sent).toEqual([]);
    Joryio.updateConsent('granted');
    Joryio.track('Later');
    expect(sent).toEqual(['Later (anon-1)']);
  });

  it('wipeData(): the init side effects carry the NEW identity, never the erased one', async () => {
    const { native, sent, calls } = fakeNative();
    const { default: Joryio } = loadSdk(native);
    Joryio.wipeData();
    await Joryio.initialize('jry_sdk_key', 'host');
    expect(calls.slice(0, 2)).toEqual(['wipeData', 'initialize']);
    expect(sent.some((line) => line.includes('anon-1'))).toBe(false);
    expect(sent[0]).toBe('Session Start (anon-2)');
  });

  it('optIn() reaches native before initialize() too', async () => {
    const { native, calls } = fakeNative();
    const { default: Joryio } = loadSdk(native);
    Joryio.optIn();
    await Joryio.initialize('jry_sdk_key', 'host');
    expect(calls.slice(0, 2)).toEqual(['optIn', 'initialize']);
  });
});

describe('what happens to calls held before the decision', () => {
  // identify() is not dropped by an opt-out (contract v5 D-b): native keeps
  // the user id on the device, unsent, so that withdrawals carry the person.
  // A data call made AFTER the optOut(), while still opted out, is dropped as
  // well (contract v7 73) - held, a later optIn() would have sent it.
  it('data calls made before and after an optOut() are dropped; identify() reaches native (D-b)', async () => {
    const { native, calls } = fakeNative();
    const { default: Joryio } = loadSdk(native);
    Joryio.track('Before');
    Joryio.identify('u1');
    Joryio.optOut();
    Joryio.track('AfterOptOut');
    await Joryio.initialize('jry_sdk_key', 'host');
    expect(calls).toEqual(['optOut', 'initialize', 'identify:u1']);
  });

  it("data calls made before a wipeData() or updateConsent('denied') are dropped", async () => {
    const { native, calls } = fakeNative();
    const { default: Joryio } = loadSdk(native);
    Joryio.identify('erased');
    Joryio.wipeData();
    Joryio.identify('kept');
    Joryio.track('Gone');
    Joryio.updateConsent('denied');
    await Joryio.initialize('jry_sdk_key', 'host');
    // 'erased' goes with the wipe; 'kept' was made after it and survives the
    // denial (D-b), so native knows whom a later withdrawal is for.
    expect(calls).toEqual(['wipeData', 'updateConsent:denied', 'initialize', 'identify:kept']);
  });

  it('an unsubscribe held before an optOut(), a denial or a wipe is kept and delivered (contract v4 36)', async () => {
    const { native, calls } = fakeNative();
    const { default: Joryio } = loadSdk(native);
    Joryio.setSubscription('email', 'unsubscribed');
    Joryio.setSubscription('sms', 'optedIn');
    Joryio.removeFromSubscriptionGroup('weekly', 'email');
    Joryio.addToSubscriptionGroup('daily', 'email');
    Joryio.optOut();
    Joryio.updateConsent('denied');
    Joryio.wipeData();
    await Joryio.initialize('jry_sdk_key', 'host');
    expect(native.setSubscription).toHaveBeenCalledTimes(1);
    expect(native.setSubscription).toHaveBeenCalledWith('email', 'unsubscribed');
    expect(native.removeFromSubscriptionGroup).toHaveBeenCalledWith('weekly', 'email');
    expect(native.addToSubscriptionGroup).not.toHaveBeenCalled();
    expect(calls.slice(0, 4)).toEqual(['optOut', 'updateConsent:denied', 'wipeData', 'initialize']);
  });

  it('non-data calls held before an optOut() are kept (listeners, tokens, flush)', async () => {
    const { native } = fakeNative();
    const { default: Joryio } = loadSdk(native);
    Joryio.onInAppMessage(() => {});
    Joryio.setSdkAuthenticationToken('jwt');
    Joryio.optOut();
    await Joryio.initialize('jry_sdk_key', 'host');
    expect(native.enableInAppMessages).toHaveBeenCalledTimes(1);
    expect(native.setSdkAuthenticationToken).toHaveBeenCalledWith('jwt');
  });

  it('optIn() and a grant keep the calls held before them', async () => {
    const { native, calls } = fakeNative();
    const { default: Joryio } = loadSdk(native);
    Joryio.track('Held');
    Joryio.optIn();
    Joryio.updateConsent('granted');
    await Joryio.initialize('jry_sdk_key', 'host');
    expect(calls).toEqual(['optIn', 'updateConsent:granted', 'initialize', 'track:Held']);
  });
});

describe('a decision made after initialize() was called', () => {
  it('while init is in flight, it runs after init, in call order', async () => {
    const { native, calls } = fakeNative();
    const { default: Joryio } = loadSdk(native);
    const init = Joryio.initialize('jry_sdk_key', 'host');
    Joryio.track('A');
    Joryio.optOut();
    await init;
    // The data call before the opt-out is dropped; the opt-out follows init.
    expect(calls).toEqual(['initialize', 'optOut']);
  });

  it('after a failed initialize(), it goes to native for the next attempt', async () => {
    const { native, calls } = fakeNative();
    native.initialize.mockRejectedValueOnce(new Error('bad key'));
    const { default: Joryio } = loadSdk(native);
    await Joryio.initialize('jry_sdk_key', 'host');
    Joryio.optOut();
    expect(native.optOut).toHaveBeenCalledTimes(1);
    await Joryio.initialize('jry_sdk_key', 'host');
    expect(calls.slice(-2)).toEqual(['optOut', 'initialize']);
  });
});

describe('overlapping initialize() calls (React StrictMode)', () => {
  it('share one native initialize(), and the SDK stays on', async () => {
    let finish!: () => void;
    const native = makeNative({
      initialize: jest
        .fn()
        .mockImplementationOnce(() => new Promise<null>((r) => (finish = () => r(null))))
        .mockRejectedValue(new Error('already initialized')),
    });
    const { default: Joryio } = loadSdk(native);
    const first = Joryio.initialize('jry_sdk_key', 'host');
    const second = Joryio.initialize('jry_sdk_key', 'host');
    finish();
    await Promise.all([first, second]);
    expect(native.initialize).toHaveBeenCalledTimes(1);
    Joryio.track('Works');
    expect(native.track).toHaveBeenCalledWith('Works', {});
  });

  it('a later initialize() that native refuses does not switch a running SDK off', async () => {
    const native = makeNative({
      initialize: jest.fn().mockResolvedValueOnce(null).mockRejectedValue(new Error('refused')),
    });
    const { default: Joryio } = loadSdk(native);
    await Joryio.initialize('jry_sdk_key', 'host');
    await Joryio.initialize('jry_sdk_key', 'host');
    Joryio.track('StillOn');
    expect(native.track).toHaveBeenCalledWith('StillOn', {});
    await expect(Joryio.getUserId()).resolves.toBeNull();
    expect(native.getUserId).toHaveBeenCalled();
  });
});

describe('consent model A on the JS side', () => {
  it('an unset trackingConsent is not sent at all, so native keeps a stored denial', async () => {
    const native = makeNative();
    const { default: Joryio } = loadSdk(native);
    await Joryio.initialize('jry_sdk_key', 'host', { enableDebug: true });
    expect(native.initialize.mock.calls[0][2]).toEqual({ enableDebug: true });
  });

  it("updateConsent accepts 'pending' and refuses anything else", async () => {
    const native = makeNative();
    const { default: Joryio } = loadSdk(native);
    await Joryio.initialize('jry_sdk_key', 'host');
    Joryio.updateConsent('pending');
    Joryio.updateConsent('yes' as 'granted');
    expect(native.updateConsent.mock.calls).toEqual([['pending']]);
  });

  it('updateConsent does not touch the opt-out switch', async () => {
    const native = makeNative();
    const { default: Joryio } = loadSdk(native);
    await Joryio.initialize('jry_sdk_key', 'host');
    Joryio.updateConsent('granted');
    Joryio.updateConsent('denied');
    expect(native.optIn).not.toHaveBeenCalled();
    expect(native.optOut).not.toHaveBeenCalled();
  });

  it('getTrackingConsent answers the native value, and null for anything else', async () => {
    const native = makeNative({
      // The first answer is the read at load (contract v8 83).
      getTrackingConsent: jest.fn().mockResolvedValueOnce('granted').mockResolvedValueOnce('denied').mockResolvedValueOnce(null),
    });
    const { default: Joryio } = loadSdk(native);
    await Joryio.initialize('jry_sdk_key', 'host');
    await expect(Joryio.getTrackingConsent()).resolves.toBe('denied');
    await expect(Joryio.getTrackingConsent()).resolves.toBeNull();
  });

  it('getTrackingConsent answers null without a native module', async () => {
    const { default: Joryio } = loadSdk(null);
    await expect(Joryio.getTrackingConsent()).resolves.toBeNull();
  });
});
