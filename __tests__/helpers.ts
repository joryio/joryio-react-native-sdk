/**
 * Loads a fresh copy of the SDK against a mocked `react-native`, so each test
 * gets its own singleton and its own native module (or none at all).
 */
type SdkModule = typeof import('../src');

export type NativeMock = Record<string, jest.Mock> & { __listeners: Map<string, Set<(e: unknown) => void>> };

const NOT_METHODS = new Set(['then', 'asymmetricMatch', 'toJSON', 'nodeType', 'constructor']);

/** A native module whose every method is a jest.fn, created on first use. */
export function makeNative(overrides: Record<string, jest.Mock> = {}): NativeMock {
  const fns: Record<string, jest.Mock> = {
    initialize: jest.fn().mockResolvedValue(null),
    ...overrides,
  };
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  return new Proxy(fns, {
    get(target, prop: string | symbol) {
      if (prop === '__listeners') return listeners;
      // Not native methods: promise sniffing and jest's own pretty-printer.
      if (typeof prop !== 'string' || NOT_METHODS.has(prop) || prop.startsWith('$$')) {
        return undefined;
      }
      if (!(prop in target)) target[prop] = jest.fn();
      return target[prop];
    },
    has() {
      return true;
    },
  }) as NativeMock;
}

export function loadSdk(native: NativeMock | null, os?: 'ios' | 'android'): SdkModule {
  let mod: SdkModule | undefined;
  jest.isolateModules(() => {
    jest.doMock(
      'react-native',
      () => ({
        NativeModules: native ? { JoryioModule: native } : {},
        ...(os ? { Platform: { OS: os } } : {}),
        NativeEventEmitter: class {
          constructor(private readonly module: NativeMock) {}
          addListener(event: string, cb: (e: unknown) => void) {
            const set = this.module.__listeners.get(event) ?? new Set();
            set.add(cb);
            this.module.__listeners.set(event, set);
            return { remove: () => set.delete(cb) };
          }
        },
      }),
      { virtual: true },
    );
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    mod = require('../src');
  });
  return mod!;
}

export const flush = () => new Promise((resolve) => setImmediate(resolve));
