/**
 * Scan 7 (1.3.0 round 7). The behaviour tests here failed on the round-6 code
 * (release/sdk-1.3.0 at f31cd0f96); they are the scan's probes H1a-H1d, lifted
 * with the assertions inverted, plus the guards around them.
 */
import * as fs from 'fs';
import * as path from 'path';
import { flush, loadSdk, makeNative, NativeMock } from './helpers';

beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

/**
 * A native module that behaves like both native SDKs: a decision recorded
 * before a successful init applies inside it; a data call is sent only when
 * tracking is allowed at the moment it runs. `failFirst` refuses the first
 * initialize() (a wrong key). `calls` is what reached native, `sent` what
 * reached the network.
 */
function model(failFirst: boolean): { native: NativeMock; calls: string[]; sent: string[] } {
  const calls: string[] = [];
  const sent: string[] = [];
  let attempt = 0;
  let initialized = false;
  let optedOut = false;
  let consent = 'granted';
  const allowed = () => !optedOut && consent === 'granted';
  const native = makeNative({
    initialize: jest.fn(async () => {
      attempt += 1;
      calls.push(`initialize#${attempt}`);
      if (failFirst && attempt === 1) throw new Error('bad key');
      initialized = true;
      if (allowed()) sent.push('Session Start');
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
      if (c === 'pending' && consent === 'denied') return; // pending never reopens a denial
      consent = c;
    }),
    wipeData: jest.fn(() => calls.push('wipeData')),
    track: jest.fn((n: string) => {
      calls.push(`track:${n}`);
      if (initialized && allowed()) sent.push(`track:${n}`);
    }),
    setAttribute: jest.fn((k: string) => {
      calls.push(`attr:${k}`);
      if (initialized && allowed()) sent.push(`attr:${k}`);
    }),
    identify: jest.fn((id: string) => calls.push(`identify:${id}`)),
    setSubscription: jest.fn((c: string, s: string) => calls.push(`sub:${c}:${s}`)),
  });
  return { native, calls, sent };
}

describe('S1 (contract v7 73): data calls made while opted out or denied are dropped, not sent after a later optIn/grant', () => {
  it('H1a never started: optOut, track, optIn, initialize -> the event never reaches native', async () => {
    const { native, calls, sent } = model(false);
    const { default: Joryio } = loadSdk(native, 'android');
    Joryio.optOut();
    Joryio.track('while-opted-out');
    Joryio.optIn();
    await Joryio.initialize('jry_sdk_android_ok', 'h');
    await flush();
    expect(calls).toEqual(['optOut', 'optIn', 'initialize#1']);
    expect(sent).not.toContain('track:while-opted-out');
  });

  it('H1b in flight, init succeeds: still dropped', async () => {
    const { native, calls, sent } = model(false);
    const { default: Joryio } = loadSdk(native, 'android');
    const p = Joryio.initialize('jry_sdk_android_ok', 'h');
    Joryio.optOut();
    Joryio.track('while-opted-out');
    Joryio.optIn();
    await p;
    await flush();
    expect(calls).not.toContain('track:while-opted-out');
    expect(sent).not.toContain('track:while-opted-out');
  });

  it('H1c in flight, init FAILS, retry succeeds: the event is dropped on the failed-init path too', async () => {
    const { native, calls, sent } = model(true);
    const { default: Joryio } = loadSdk(native, 'android');
    const p = Joryio.initialize('jry_sdk_android_bad', 'h');
    Joryio.optOut();
    Joryio.track('while-opted-out');
    Joryio.optIn();
    await p;
    await Joryio.initialize('jry_sdk_android_ok', 'h');
    await flush();
    expect(calls).toEqual(['initialize#1', 'optOut', 'optIn', 'initialize#2']);
    expect(sent).not.toContain('track:while-opted-out');
  });

  it('after a failed init: optOut, track, optIn, retry -> dropped', async () => {
    const { native, calls, sent } = model(true);
    const { default: Joryio } = loadSdk(native, 'ios');
    await Joryio.initialize('jry_sdk_ios_bad', 'h');
    Joryio.optOut();
    Joryio.track('after-failure');
    Joryio.optIn();
    await Joryio.initialize('jry_sdk_ios_ok', 'h');
    await flush();
    expect(calls).not.toContain('track:after-failure');
    expect(sent).not.toContain('track:after-failure');
  });

  it('H1d denied, track, granted -> dropped', async () => {
    const { native, calls, sent } = model(false);
    const { default: Joryio } = loadSdk(native, 'android');
    Joryio.updateConsent('denied');
    Joryio.track('while-denied');
    Joryio.setAttribute('plan', 'pro');
    Joryio.updateConsent('granted');
    await Joryio.initialize('jry_sdk_android_ok', 'h');
    await flush();
    expect(calls).toEqual(['updateConsent:denied', 'updateConsent:granted', 'initialize#1']);
    expect(sent).toEqual(['Session Start']);
  });

  it("'pending' never reopens a denial: denied, pending, track, granted -> dropped", async () => {
    const { native, calls } = model(false);
    const { default: Joryio } = loadSdk(native, 'android');
    Joryio.updateConsent('denied');
    Joryio.updateConsent('pending');
    Joryio.track('still-denied');
    Joryio.updateConsent('granted');
    await Joryio.initialize('jry_sdk_android_ok', 'h');
    await flush();
    expect(calls).not.toContain('track:still-denied');
  });

  it('opted out AND denied: lifting one switch is not enough', async () => {
    const { native, calls } = model(false);
    const { default: Joryio } = loadSdk(native, 'android');
    Joryio.optOut();
    Joryio.updateConsent('denied');
    Joryio.optIn();
    Joryio.track('still-denied');
    Joryio.updateConsent('granted');
    Joryio.track('allowed');
    await Joryio.initialize('jry_sdk_android_ok', 'h');
    await flush();
    expect(calls).not.toContain('track:still-denied');
    expect(calls).toContain('track:allowed');
  });

  it("'pending' alone does not drop: data made while pending is held for native to queue", async () => {
    const { native, calls } = model(false);
    const { default: Joryio } = loadSdk(native, 'android');
    Joryio.updateConsent('pending');
    Joryio.track('while-pending');
    await Joryio.initialize('jry_sdk_android_ok', 'h');
    await flush();
    expect(calls).toContain('track:while-pending');
  });

  it('calls made after the optIn/grant are kept and sent', async () => {
    const { native, sent } = model(false);
    const { default: Joryio } = loadSdk(native, 'android');
    Joryio.optOut();
    Joryio.optIn();
    Joryio.track('after-opt-in');
    await Joryio.initialize('jry_sdk_android_ok', 'h');
    await flush();
    expect(sent).toContain('track:after-opt-in');
  });

  it('identify and withdrawals made while opted out are kept (D-b, contract v4 36); a subscribe is dropped', async () => {
    const { native, calls } = model(false);
    const { default: Joryio } = loadSdk(native, 'android');
    Joryio.optOut();
    Joryio.identify('u1');
    Joryio.setSubscription('email', 'unsubscribed');
    Joryio.setSubscription('sms', 'subscribed');
    Joryio.optIn();
    await Joryio.initialize('jry_sdk_android_ok', 'h');
    await flush();
    expect(calls).toContain('identify:u1');
    expect(calls).toContain('sub:email:unsubscribed');
    expect(calls).not.toContain('sub:sms:subscribed');
  });

  it('e-commerce calls made while opted out are dropped too', async () => {
    const { native, calls } = model(false);
    const { default: Joryio } = loadSdk(native, 'android');
    Joryio.optOut();
    Joryio.ecommerce.viewProduct({ productId: 'p1', name: 'P', price: 1 });
    Joryio.optIn();
    await Joryio.initialize('jry_sdk_android_ok', 'h');
    await flush();
    expect((native.ecommerce as jest.Mock).mock.calls.length).toBe(0);
    expect(calls).toEqual(['optOut', 'optIn', 'initialize#1']);
  });

  it('after a successful init, calls go to native as they are made (native decides)', async () => {
    const { native, calls } = model(false);
    const { default: Joryio } = loadSdk(native, 'android');
    await Joryio.initialize('jry_sdk_android_ok', 'h');
    Joryio.optOut();
    Joryio.track('runtime');
    await flush();
    expect(calls).toEqual(['initialize#1', 'optOut', 'track:runtime']);
  });
});

describe('N2 / N3: wording', () => {
  const root = path.join(__dirname, '..');
  const docs = path.join(root, '..', 'docs');
  const pages = [
    path.join(docs, 'docs/developers/sdk/react-native-sdk.md'),
    ...['he', 'el', 'ar', 'es'].map((l) =>
      path.join(docs, `i18n/${l}/docusaurus-plugin-content-docs/current/developers/sdk/react-native-sdk.md`),
    ),
  ];

  it('no README or docs page says a pre-init wipe "drops" an earlier token', () => {
    const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
    expect(readme).not.toContain('which also drops an earlier `setSdkAuthenticationToken()`');
    // Round 8 (contract v8 88): true on both platforms now that the Android
    // bridge uses the companion setter, and says so.
    expect(readme).toContain('on iOS and Android alike the wipe keeps it only for the erased person');
    const en = fs.readFileSync(pages[0], 'utf8');
    expect(en).not.toContain('which also drops an earlier `setSdkAuthenticationToken()`');
    expect(en).toContain('on iOS and Android alike the wipe keeps it only for the erased person');
  });

  it('isUserOptedOut JSDoc names the failed native read', () => {
    const src = fs.readFileSync(path.join(root, 'src/index.ts'), 'utf8');
    expect(src).not.toContain('Answers `false` only when');
    expect(src).toMatch(/or the native read fails/);
  });
});
