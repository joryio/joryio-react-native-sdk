import { flush, loadSdk, makeNative, NativeMock } from './helpers';

/**
 * An event tracked a moment before optOut() (found testing 1.4.0-beta.15 on
 * the demo apps: sometimes dropped, sometimes sent).
 *
 * The rule, the same on every Joryio SDK: an event whose track() came before
 * optOut() is dropped unless a request carrying it had already started when
 * optOut() was called. Native applies it to what it holds; this layer must
 * (a) drop what it still holds itself and (b) hand everything else to native
 * in call order, whatever phase initialize() is in - so the outcome never
 * depends on the bridge.
 *
 * The fake native below applies the native rule: track() queues, a flush
 * sends what is queued, optOut() clears the queue and stops sending, and a
 * request that starts after optOut() carries nothing tracked before it.
 */
function fakeNative(opts: { storedDelayMs?: number; initDelayMs?: number } = {}) {
  const calls: string[] = [];
  const queued: string[] = [];
  const sent: string[] = [];
  let optedOut = false;
  const native: NativeMock = makeNative({
    isUserOptedOut: jest.fn(
      () => new Promise((resolve) => setTimeout(() => resolve(false), opts.storedDelayMs ?? 0)),
    ),
    getTrackingConsent: jest.fn(async () => 'granted'),
    initialize: jest.fn(() => {
      calls.push('initialize');
      return new Promise((resolve) => setTimeout(() => resolve(null), opts.initDelayMs ?? 0));
    }),
    track: jest.fn((name: string) => {
      calls.push(`track:${name}`);
      if (!optedOut) queued.push(name);
    }),
    optOut: jest.fn(() => {
      calls.push('optOut');
      optedOut = true;
      queued.length = 0;
    }),
    flush: jest.fn(() => {
      calls.push('flush');
      if (!optedOut) sent.push(...queued.splice(0));
    }),
  });
  return { native, calls, queued, sent };
}

type Sdk = ReturnType<typeof loadSdk>['default'];

const PHASES: Record<string, (J: Sdk) => Promise<void>> = {
  'before initialize()': async (J) => {
    J.track('E');
    J.optOut();
    await J.initialize('jry_sdk_key', 'host');
  },
  'while initialize() is in flight': async (J) => {
    const init = J.initialize('jry_sdk_key', 'host');
    J.track('E');
    J.optOut();
    await init;
  },
  'track before initialize(), optOut while it is in flight': async (J) => {
    J.track('E');
    const init = J.initialize('jry_sdk_key', 'host');
    J.optOut();
    await init;
  },
  'track while initialize() is in flight, optOut after it': async (J) => {
    const init = J.initialize('jry_sdk_key', 'host');
    J.track('E');
    await init;
    J.optOut();
  },
  'after initialize()': async (J) => {
    await J.initialize('jry_sdk_key', 'host');
    J.track('E');
    J.optOut();
  },
  'after a failed initialize(), then a retry': async (J) => {
    await J.initialize('jry_sdk_key', 'host');
    J.track('E');
    J.optOut();
    await J.initialize('jry_sdk_key', 'host');
  },
};

// Native answering slowly or at once - the timing the demo apps varied.
const TIMINGS = [
  {},
  { storedDelayMs: 30 },
  { initDelayMs: 30 },
  { storedDelayMs: 60, initDelayMs: 10 },
];

beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe('track() then optOut(): the same outcome in every phase and at every timing', () => {
  for (const [phase, run] of Object.entries(PHASES)) {
    for (const timing of TIMINGS) {
      it(`${phase} ${JSON.stringify(timing)}`, async () => {
        const fake = fakeNative(timing);
        if (phase.startsWith('after a failed')) {
          fake.native.initialize.mockImplementationOnce(() => {
            fake.calls.push('initialize');
            return Promise.reject(new Error('bad key'));
          });
        }
        const { default: Joryio } = loadSdk(fake.native);
        await run(Joryio);
        await new Promise((resolve) => setTimeout(resolve, 100));
        await flush();
        Joryio.flush();
        await flush();

        // Native never gets the event after the opt-out: either this layer
        // dropped it, or it reached native first.
        const t = fake.calls.indexOf('track:E');
        const o = fake.calls.indexOf('optOut');
        expect(o).toBeGreaterThanOrEqual(0);
        if (t >= 0) expect(t).toBeLessThan(o);
        // And with no request started before optOut(), it is never sent.
        expect(fake.sent).toEqual([]);
        expect(fake.queued).toEqual([]);
      });
    }
  }

  it('a request native had already started before optOut() is the only way it goes out', async () => {
    const fake = fakeNative();
    const { default: Joryio } = loadSdk(fake.native);
    await Joryio.initialize('jry_sdk_key', 'host');
    Joryio.track('E');
    Joryio.flush(); // the request starts here, before the opt-out
    Joryio.optOut();
    expect(fake.calls).toEqual(['initialize', 'track:E', 'flush', 'optOut']);
    expect(fake.sent).toEqual(['E']);
  });
});
