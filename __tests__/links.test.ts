import { loadSdk, makeNative, flush } from './helpers';

/**
 * setLinkHandler on React Native: the native SDK hands every link it is
 * about to open to JS (event `JoryioLink`), and JS answers with completeLink -
 * true when the handler took it, false to let native open it as without a
 * handler. The routing rules themselves are the native SDKs' (LinkHandlerTests
 * on iOS, LinkRouterTest on Android).
 */
const emit = (native: any, body: unknown) => native.__listeners.get('JoryioLink')?.forEach((cb: any) => cb(body));
const link = (extra: Record<string, unknown> = {}) => ({ linkId: 'l1', url: 'https://shop.example/sale', source: 'placement', placementKey: 'home_hero', itemId: 'i1', isAppDeepLink: false, ...extra });

describe('setLinkHandler (React Native)', () => {
  it('enables the native handler before initialize() and hands the link over with its context', () => {
    const native = makeNative();
    const { default: Joryio } = loadSdk(native);
    const seen: unknown[] = [];
    Joryio.setLinkHandler((l) => (seen.push(l), true));
    expect(native.enableLinkHandler).toHaveBeenCalledTimes(1);
    emit(native, link());
    expect(seen).toEqual([{ url: 'https://shop.example/sale', source: 'placement', placementKey: 'home_hero', itemId: 'i1', isAppDeepLink: false }]);
    expect(native.completeLink).toHaveBeenCalledWith('l1', true);
  });

  it('a declined, throwing or non-boolean answer hands the link back to native', () => {
    for (const handler of [() => false, () => { throw new Error('boom'); }, () => 'yes' as any]) {
      const native = makeNative();
      const { default: Joryio } = loadSdk(native);
      Joryio.setLinkHandler(handler);
      emit(native, link({ url: 'myapp://cart', isAppDeepLink: true }));
      expect(native.completeLink).toHaveBeenCalledWith('l1', false);
    }
  });

  it('a Promise decides later', async () => {
    const native = makeNative();
    const { default: Joryio } = loadSdk(native);
    let resolve!: (v: boolean) => void;
    Joryio.setLinkHandler(() => new Promise<boolean>((r) => (resolve = r)));
    emit(native, link({ source: 'in_app', campaignId: 'camp-1' }));
    expect(native.completeLink).not.toHaveBeenCalled();
    resolve(false);
    await flush();
    expect(native.completeLink).toHaveBeenCalledWith('l1', false);
  });

  it('a malformed event is handed back, and clearLinkHandler disables native and stops listening', () => {
    const native = makeNative();
    const { default: Joryio } = loadSdk(native);
    const handler = jest.fn(() => true);
    Joryio.setLinkHandler(handler);
    emit(native, link({ source: 'somewhere' }));
    expect(handler).not.toHaveBeenCalled();
    expect(native.completeLink).toHaveBeenCalledWith('l1', false);
    Joryio.clearLinkHandler();
    expect(native.disableLinkHandler).toHaveBeenCalledTimes(1);
    expect(native.__listeners.get('JoryioLink')?.size ?? 0).toBe(0);
  });

  it('a second setLinkHandler replaces the first, with one listener', () => {
    const native = makeNative();
    const { default: Joryio } = loadSdk(native);
    const first = jest.fn(() => true);
    const second = jest.fn(() => true);
    Joryio.setLinkHandler(first);
    Joryio.setLinkHandler(second);
    emit(native, link());
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(native.__listeners.get('JoryioLink')!.size).toBe(1);
  });

  it('not a function: ignored; no native module: nothing breaks', () => {
    const native = makeNative();
    const { default: Joryio } = loadSdk(native);
    Joryio.setLinkHandler(null as any);
    expect(native.enableLinkHandler).not.toHaveBeenCalled();
    const { default: Bare } = loadSdk(null);
    expect(() => Bare.setLinkHandler(() => true)).not.toThrow();
    expect(() => Bare.clearLinkHandler()).not.toThrow();
  });

  it('forwardUniversalLinks reaches native initialize()', async () => {
    const native = makeNative();
    const { default: Joryio } = loadSdk(native);
    await Joryio.initialize('jry_sdk_ios_test', 'api-eu1.joryio.com', { forwardUniversalLinks: true });
    expect(native.initialize.mock.calls[0][2]).toMatchObject({ forwardUniversalLinks: true });
  });
});
