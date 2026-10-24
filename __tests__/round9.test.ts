/**
 * Scan 9 (1.3.0 round 9), contract v9 91. Q1 failed on the round-8 code
 * (release/sdk-1.3.0 at 56fefc54c): a data call made while initialize() was in
 * flight was judged by the STORED decision alone, so an explicit
 * `trackingConsent: 'granted'` in the config - which lifts a stored denial
 * natively - was ignored and the call dropped. The scan's probes, lifted with
 * the assertions kept, run on both platforms, plus the failed-init and
 * in-process-decision cases the fix must keep.
 */
import { flush, loadSdk, makeNative, NativeMock } from './helpers';

beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

type Os = 'ios' | 'android';
const KEY: Record<Os, string> = { ios: 'jry_sdk_ios_ok', android: 'jry_sdk_android_ok' };

/**
 * Both natives answer the stored state pre-init; a successful initialize()
 * applies config.trackingConsent and config.optOut true (an explicit grant
 * lifts a stored denial, contract 24). A data call reaching native while
 * allowed is sent. `initDelay` holds init until finishInit(); `failFirst`
 * makes the first init reject without applying its config.
 */
function model(opts: { storedOptOut?: boolean; storedDenied?: boolean; initDelay?: boolean; failFirst?: boolean }) {
  const sent: string[] = [];
  let attempt = 0;
  let optedOut = !!opts.storedOptOut;
  let consent = opts.storedDenied ? 'denied' : 'granted';
  let finishInit: () => void = () => {};
  const native: NativeMock = makeNative({
    initialize: jest.fn((_k: string, _h: string, cfg: Record<string, unknown>) => {
      attempt += 1;
      const fails = opts.failFirst === true && attempt === 1;
      const apply = () => {
        if (fails) return;
        if (cfg.trackingConsent === 'granted') consent = 'granted';
        if (cfg.trackingConsent === 'denied') consent = 'denied';
        if (cfg.optOut === true) optedOut = true;
      };
      if (!opts.initDelay || attempt > 1) {
        apply();
        return fails ? Promise.reject(new Error('bad key')) : Promise.resolve(null);
      }
      return new Promise<null>((resolve, reject) => {
        finishInit = () => {
          apply();
          if (fails) reject(new Error('bad key'));
          else resolve(null);
        };
      });
    }),
    optOut: jest.fn(() => {
      optedOut = true;
    }),
    optIn: jest.fn(() => {
      optedOut = false;
    }),
    updateConsent: jest.fn((c: string) => {
      if (c === 'pending' && consent === 'denied') return;
      consent = c;
    }),
    isUserOptedOut: jest.fn(async () => optedOut),
    getTrackingConsent: jest.fn(async () => consent),
    track: jest.fn((n: string) => {
      if (!optedOut && consent === 'granted') sent.push('track:' + n);
    }),
  });
  return { native, sent, finishInit: () => finishInit() };
}

describe.each<Os>(['android', 'ios'])('round 9 %s: the init config while init is in flight', (os) => {
  it('Q1 stored denial + explicit trackingConsent granted at init: a track made while init is in flight is sent', async () => {
    const m = model({ storedDenied: true, initDelay: true });
    const { default: Joryio } = loadSdk(m.native, os);
    await flush();
    const init = Joryio.initialize(KEY[os], 'h', { trackingConsent: 'granted' });
    Joryio.track('app_open'); // not awaited - the common shape
    m.finishInit();
    await init;
    await flush();
    expect(m.sent).toEqual(['track:app_open']);
  });

  it('Q1 also when the stored read has not answered yet (held call judged with the config)', async () => {
    const m = model({ storedDenied: true, initDelay: true });
    const { default: Joryio } = loadSdk(m.native, os);
    // No flush: the stored read is still pending when the track is made.
    const init = Joryio.initialize(KEY[os], 'h', { trackingConsent: 'Granted' as never });
    Joryio.track('app_open');
    m.finishInit();
    await init;
    await flush();
    expect(m.sent).toEqual(['track:app_open']);
  });

  it('Q1-control: no stored denial -> sent', async () => {
    const m = model({ initDelay: true });
    const { default: Joryio } = loadSdk(m.native, os);
    await flush();
    const init = Joryio.initialize(KEY[os], 'h', { trackingConsent: 'granted' });
    Joryio.track('app_open');
    m.finishInit();
    await init;
    await flush();
    expect(m.sent).toEqual(['track:app_open']);
  });

  it('Q1b: a track right after an AWAITED init is sent', async () => {
    const m = model({ storedDenied: true });
    const { default: Joryio } = loadSdk(m.native, os);
    await Joryio.initialize(KEY[os], 'h', { trackingConsent: 'granted' });
    Joryio.track('after');
    await flush();
    expect(m.sent).toEqual(['track:after']);
  });

  it('Q2 stored opt-out + optOut:false at init: an in-flight track is dropped (false lifts nothing)', async () => {
    const m = model({ storedOptOut: true, initDelay: true });
    const { default: Joryio } = loadSdk(m.native, os);
    await flush();
    const init = Joryio.initialize(KEY[os], 'h', { optOut: false });
    Joryio.track('x');
    m.finishInit();
    await init;
    await flush();
    expect(m.sent).toEqual([]);
  });

  it('a pre-init updateConsent(denied) wins over the config grant: the in-flight track is dropped', async () => {
    const m = model({ initDelay: true });
    const { default: Joryio } = loadSdk(m.native, os);
    await flush();
    Joryio.updateConsent('denied');
    const init = Joryio.initialize(KEY[os], 'h', { trackingConsent: 'granted' });
    Joryio.track('x');
    m.finishInit();
    await init;
    await flush();
    Joryio.updateConsent('granted');
    await flush();
    expect(m.sent).toEqual([]);
    expect(m.native.track).not.toHaveBeenCalled();
  });

  it('config grant, then that init FAILS: the in-flight track is judged by the stored denial and dropped', async () => {
    const m = model({ storedDenied: true, initDelay: true, failFirst: true });
    const { default: Joryio } = loadSdk(m.native, os);
    await flush();
    const init = Joryio.initialize(KEY[os], 'h', { trackingConsent: 'granted' });
    Joryio.track('in_window');
    m.finishInit();
    await init;
    await flush();
    // The retry grants: the call made under the failed init's grant is not sent.
    await Joryio.initialize(KEY[os], 'h', { trackingConsent: 'granted' });
    await flush();
    Joryio.track('after_retry');
    await flush();
    expect(m.sent).toEqual(['track:after_retry']);
    expect(m.native.track).toHaveBeenCalledTimes(1);
  });

  it('config grant, then that init FAILS with nothing stored: the in-flight track is kept for the retry', async () => {
    const m = model({ initDelay: true, failFirst: true });
    const { default: Joryio } = loadSdk(m.native, os);
    await flush();
    const init = Joryio.initialize(KEY[os], 'h', { trackingConsent: 'granted' });
    Joryio.track('in_window');
    m.finishInit();
    await init;
    await Joryio.initialize(KEY[os], 'h', {});
    await flush();
    expect(m.sent).toEqual(['track:in_window']);
  });

  it('config optOut:true: an in-flight track is dropped and a later optIn does not send it', async () => {
    const m = model({ initDelay: true });
    const { default: Joryio } = loadSdk(m.native, os);
    await flush();
    const init = Joryio.initialize(KEY[os], 'h', { optOut: true });
    Joryio.track('x');
    m.finishInit();
    await init;
    await flush();
    Joryio.optIn();
    await flush();
    expect(m.native.track).not.toHaveBeenCalled();
  });

  it('config denied over nothing stored: an in-flight track is dropped', async () => {
    const m = model({ initDelay: true });
    const { default: Joryio } = loadSdk(m.native, os);
    await flush();
    const init = Joryio.initialize(KEY[os], 'h', { trackingConsent: 'denied' });
    Joryio.track('x');
    m.finishInit();
    await init;
    await flush();
    expect(m.native.track).not.toHaveBeenCalled();
  });
});
