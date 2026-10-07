/**
 * Scan 8 (1.3.0 round 8). The behaviour tests here failed on the round-7 code
 * (release/sdk-1.3.0 at dc70d92d9); they are the scan's probes P1a-P1d and P2,
 * lifted with the assertions kept, run on both platforms, plus the race the
 * fix opens (a call made before native has answered the stored read).
 */
import { flush, loadSdk, makeNative, NativeMock } from './helpers';

beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

type Os = 'ios' | 'android';
const KEY: Record<Os, string> = { ios: 'jry_sdk_ios_ok', android: 'jry_sdk_android_ok' };

/**
 * Like round7.test.ts model(), plus the state STORED by an earlier launch,
 * which both natives answer from before their own initialize() (contract 44).
 * A data call reaching native while refused is dropped there (rule 73), and
 * one reaching it while allowed is sent. `answerLate` holds the stored read
 * until `release()`, to model a bridge that answers after JS has moved on.
 */
function model(opts: { failFirst?: boolean; storedOptOut?: boolean; storedDenied?: boolean; answerLate?: boolean }) {
  const calls: string[] = [];
  const sent: string[] = [];
  let attempt = 0;
  let optedOut = !!opts.storedOptOut;
  let consent = opts.storedDenied ? 'denied' : 'granted';
  const allowed = () => !optedOut && consent === 'granted';
  let release: () => void = () => {};
  const gate = opts.answerLate ? new Promise<void>((resolve) => { release = resolve; }) : Promise.resolve();
  // The stored state at the moment native is asked (calls are served in order).
  const storedAnswer = <T>(value: () => T) => {
    const now = value();
    return gate.then(() => now);
  };
  const native: NativeMock = makeNative({
    initialize: jest.fn(async () => {
      attempt += 1;
      calls.push('initialize#' + attempt);
      if (opts.failFirst && attempt === 1) throw new Error('bad key');
      return null;
    }),
    optOut: jest.fn(() => { calls.push('optOut'); optedOut = true; }),
    optIn: jest.fn(() => { calls.push('optIn'); optedOut = false; }),
    updateConsent: jest.fn((c: string) => {
      calls.push('updateConsent:' + c);
      if (c === 'pending' && consent === 'denied') return;
      consent = c;
    }),
    isUserOptedOut: jest.fn(() => storedAnswer(() => optedOut)),
    getTrackingConsent: jest.fn(() => storedAnswer(() => consent)),
    track: jest.fn((n: string) => {
      calls.push('track:' + n);
      if (allowed()) sent.push('track:' + n);
    }),
    setAttribute: jest.fn((k: string) => {
      calls.push('attr:' + k);
      if (allowed()) sent.push('attr:' + k);
    }),
  });
  return { native, calls, sent, release: () => release() };
}

describe.each<Os>(['android', 'ios'])('v8 83: a decision stored by an earlier launch applies before init (%s)', (os) => {
  it('P1a stored opt-out: track, optIn, initialize -> the track is never sent', async () => {
    const m = model({ storedOptOut: true });
    const { default: Joryio } = loadSdk(m.native, os);
    expect(await Joryio.isUserOptedOut()).toBe(true);
    Joryio.track('while-stored-opted-out');
    Joryio.setAttribute('plan', 'pro');
    Joryio.optIn();
    await Joryio.initialize(KEY[os], 'h');
    await flush();
    expect(m.sent).toEqual([]);
    // The lift itself still reaches native, ahead of initialize().
    expect(m.calls).toEqual(['optIn', 'initialize#1']);
    // And calls after it are collected.
    Joryio.track('after-opt-in');
    expect(m.sent).toEqual(['track:after-opt-in']);
  });

  it('P1b stored denial: track, grant, initialize -> the track is never sent', async () => {
    const m = model({ storedDenied: true });
    const { default: Joryio } = loadSdk(m.native, os);
    Joryio.track('while-stored-denied');
    Joryio.updateConsent('granted');
    await Joryio.initialize(KEY[os], 'h');
    await flush();
    expect(m.sent).not.toContain('track:while-stored-denied');
  });

  it('P1c stored opt-out, failed init, track, optIn, retry -> the track is never sent', async () => {
    const m = model({ storedOptOut: true, failFirst: true });
    const { default: Joryio } = loadSdk(m.native, os);
    await Joryio.initialize(KEY[os], 'h');
    Joryio.track('after-failed-init');
    Joryio.optIn();
    await Joryio.initialize(KEY[os], 'h');
    await flush();
    expect(m.sent).not.toContain('track:after-failed-init');
  });

  it('P1d in-flight window with a stored opt-out stays correct', async () => {
    const m = model({ storedOptOut: true });
    const { default: Joryio } = loadSdk(m.native, os);
    const p = Joryio.initialize(KEY[os], 'h');
    Joryio.track('in-flight');
    Joryio.optIn();
    await p;
    await flush();
    expect(m.sent).not.toContain('track:in-flight');
  });

  it('a call made before native answered the stored read is judged once it answers', async () => {
    const m = model({ storedOptOut: true, answerLate: true });
    const { default: Joryio } = loadSdk(m.native, os);
    Joryio.track('before-the-answer');
    Joryio.optIn();
    Joryio.track('after-opt-in');
    const init = Joryio.initialize(KEY[os], 'h');
    await flush();
    // Nothing replayed while the stored decision is unknown.
    expect(m.calls).toEqual(['optIn', 'initialize#1']);
    m.release();
    await init;
    await flush();
    expect(m.sent).toEqual(['track:after-opt-in']);
  });

  it('with nothing stored a late answer drops nothing, and order is kept', async () => {
    const m = model({ answerLate: true });
    const { default: Joryio } = loadSdk(m.native, os);
    Joryio.track('a');
    Joryio.setAttribute('k', 1);
    Joryio.track('b');
    const init = Joryio.initialize(KEY[os], 'h');
    m.release();
    await init;
    await flush();
    expect(m.sent).toEqual(['track:a', 'attr:k', 'track:b']);
  });

  it('a decision made in this process wins over the stored one', async () => {
    const m = model({ storedOptOut: true, answerLate: true });
    const { default: Joryio } = loadSdk(m.native, os);
    Joryio.optIn();
    Joryio.track('after-opt-in');
    Joryio.updateConsent('denied');
    Joryio.track('after-denial');
    Joryio.updateConsent('granted');
    Joryio.track('after-grant');
    const init = Joryio.initialize(KEY[os], 'h');
    m.release();
    await init;
    await flush();
    // The denial discards what came before it (rule 83); what came after the
    // in-process optIn and grant is collected despite the stored opt-out.
    expect(m.sent).toEqual(['track:after-grant']);
  });

  it('a stored read that never answers does not hold initialize() forever', async () => {
    const native = makeNative({
      isUserOptedOut: jest.fn(() => new Promise(() => {})),
      getTrackingConsent: jest.fn(() => new Promise(() => {})),
    });
    const { default: Joryio } = loadSdk(native, os);
    Joryio.track('x');
    const started = Date.now();
    await Joryio.initialize(KEY[os], 'h');
    expect(Date.now() - started).toBeLessThan(6000);
    expect(native.track).toHaveBeenCalledWith('x', {});
  }, 10000);

  it('a stored read that throws counts as nothing stored', async () => {
    const native = makeNative({
      isUserOptedOut: jest.fn(() => { throw new Error('no store'); }),
    });
    const { default: Joryio } = loadSdk(native, os);
    Joryio.track('x');
    await Joryio.initialize(KEY[os], 'h');
    expect(native.track).toHaveBeenCalledWith('x', {});
  });
});

describe('v8 84: the SDK-auth token and handler reach native before initialize()', () => {
  it('P2 token, unsubscribe, wipe: all three are handed to native ahead of initialize', async () => {
    const calls: string[] = [];
    const native = makeNative({
      initialize: jest.fn(async () => { calls.push('initialize'); return null; }),
      setSdkAuthenticationToken: jest.fn(() => calls.push('setSdkAuthenticationToken')),
      wipeData: jest.fn(() => calls.push('wipeData')),
      setSubscription: jest.fn((c: string, s: string) => calls.push('sub:' + c + ':' + s)),
    });
    const { default: Joryio } = loadSdk(native, 'android');
    Joryio.setSdkAuthenticationToken('T');
    Joryio.setSubscription('email', 'unsubscribed');
    Joryio.wipeData();
    await Joryio.initialize('jry_sdk_android_ok', 'h');
    await flush();
    expect(calls).toEqual(['setSdkAuthenticationToken', 'sub:email:unsubscribed', 'wipeData', 'initialize']);
  });

  it('onSdkAuthenticationError enables the native handler before initialize() (Android)', async () => {
    const calls: string[] = [];
    const native = makeNative({
      initialize: jest.fn(async () => { calls.push('initialize'); return null; }),
      enableSdkAuthenticationErrors: jest.fn(() => calls.push('enableSdkAuthenticationErrors')),
    });
    const { default: Joryio } = loadSdk(native, 'android');
    Joryio.onSdkAuthenticationError(() => {});
    expect(calls).toEqual(['enableSdkAuthenticationErrors']);
    await Joryio.initialize('jry_sdk_android_ok', 'h');
    expect(calls).toEqual(['enableSdkAuthenticationErrors', 'initialize']);
  });

  it('a throwing native enable never reaches the host', () => {
    const native = makeNative({
      enableSdkAuthenticationErrors: jest.fn(() => { throw new Error('boom'); }),
    });
    const { default: Joryio } = loadSdk(native, 'android');
    expect(() => Joryio.onSdkAuthenticationError(() => {})).not.toThrow();
  });
});
