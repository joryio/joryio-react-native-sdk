import { loadSdk, makeNative, flush } from './helpers';

/**
 * Placements on React Native (D444, PR 7). The native SDKs do the work; the
 * JS layer must hand the data over faithfully and route every report back to
 * native (where the identity and consent checks live).
 */
const json = JSON.stringify({
  home_hero: {
    placementKey: 'home_hero',
    isControl: false,
    emptyBehavior: 'collapse',
    maxItems: 1,
    ttlSeconds: 300,
    items: [{ id: 'camp-1', variantId: 'v2', kind: 'native', data: { headline: 'Free shipping' }, content: { kind: 'native', title: 't' } }],
  },
  cart_upsell: { placementKey: 'cart_upsell', isControl: true, emptyBehavior: 'keep_space', maxItems: 1, ttlSeconds: 60, items: [] },
});

describe('placements (React Native)', () => {
  it('exports the shared constants', () => {
    const sdk = loadSdk(makeNative());
    expect(sdk.PLACEMENT_VIEWABLE_FRACTION).toBe(0.5);
    expect(sdk.PLACEMENT_MIN_REFRESH_SECONDS).toBe(30);
  });

  it('product cards from the native toJson reach the app (D444 Phase 2b)', async () => {
    const withProducts = JSON.stringify({
      home_hero: { placementKey: 'home_hero', isControl: false, emptyBehavior: 'collapse', maxItems: 1, ttlSeconds: 300,
        items: [{ id: 'camp-1', kind: 'data', data: {}, products: [{ id: 'sku-1', title: 'Mug', price: '$9', discountPercent: 10 }, { title: 'no id' }] }] },
    });
    const native = makeNative({ getPlacements: jest.fn().mockResolvedValue(withProducts) });
    const { default: Joryio } = loadSdk(native);
    await Joryio.initialize('jry_sdk_ios_test', 'host');
    const r = await Joryio.getPlacements(['home_hero']);
    expect(r.home_hero.items[0].products).toEqual([{ id: 'sku-1', title: 'Mug', price: '$9', compareAtPrice: null, discountPercent: 10, imageUrl: null, url: null }]);
  });

  it('getPlacements parses the native JSON and routes mark* back to native', async () => {
    const native = makeNative({ getPlacements: jest.fn().mockResolvedValue(json) });
    const { default: Joryio } = loadSdk(native);
    await Joryio.initialize('jry_sdk_ios_test', 'host');
    const r = await Joryio.getPlacements(['home_hero', 'cart_upsell']);
    expect(native.getPlacements).toHaveBeenCalledWith(['home_hero', 'cart_upsell']);
    expect(r.home_hero.items[0]).toMatchObject({ id: 'camp-1', kind: 'native', data: { headline: 'Free shipping' } });
    expect(r.cart_upsell).toMatchObject({ isControl: true, emptyBehavior: 'keep_space', items: [] });
    r.home_hero.items[0].markDisplayed();
    r.home_hero.items[0].markClicked('cta');
    r.home_hero.items[0].markDismissed();
    r.cart_upsell.markDisplayed();
    expect(native.markPlacement.mock.calls).toEqual([
      ['home_hero', 'camp-1', 'displayed', null],
      ['home_hero', 'camp-1', 'clicked', 'cta'],
      ['home_hero', 'camp-1', 'dismissed', null],
      ['cart_upsell', null, 'control', null],
    ]);
  });

  it('resolves {} without the native module or on a bad answer', async () => {
    expect(await loadSdk(null).default.getPlacements(['home_hero'])).toEqual({});
    const bad = makeNative({ getPlacements: jest.fn().mockResolvedValue('not json') });
    const sdk = loadSdk(bad).default;
    await sdk.initialize('jry_sdk_ios_test', 'host');
    expect(await sdk.getPlacements(['home_hero'])).toEqual({});
  });

  it('onPlacementsUpdated enables native updates once, delivers parsed placements, and disables on the last unsubscribe', async () => {
    const native = makeNative();
    const { default: Joryio } = loadSdk(native);
    await Joryio.initialize('jry_sdk_ios_test', 'host');
    const heard: string[][] = [];
    const off1 = Joryio.onPlacementsUpdated((p) => heard.push(Object.keys(p)));
    const off2 = Joryio.onPlacementsUpdated(() => undefined);
    await flush();
    expect(native.enablePlacementsUpdates).toHaveBeenCalled();
    native.__listeners.get('JoryioPlacementsUpdated')!.forEach((cb) => cb({ json }));
    expect(heard).toEqual([['home_hero', 'cart_upsell']]);
    // A JoryioSubscription: cancel() stops it (calling it is the same); twice is harmless.
    off1.cancel();
    off1();
    await flush();
    expect(native.disablePlacementsUpdates).not.toHaveBeenCalled();
    off2.cancel();
    await flush();
    expect(native.disablePlacementsUpdates).toHaveBeenCalledTimes(1);
  });

  it('refreshPlacements forwards the keys (null = everything on screen)', async () => {
    const native = makeNative();
    const { default: Joryio } = loadSdk(native);
    await Joryio.initialize('jry_sdk_ios_test', 'host');
    Joryio.refreshPlacements(['home_hero']);
    Joryio.refreshPlacements();
    await flush();
    expect(native.refreshPlacements.mock.calls).toEqual([[['home_hero']], [null]]);
  });
});

/**
 * "Show when" (BACKLOG D465): the native SDK holds an item until its moment and
 * builds the placements request (including an event re-check's `recheckEvent`).
 * The bridge adds nothing: it must pass the native answer through (a held item
 * is simply absent; the revealed one arrives on the update event) and must not
 * build a placements request of its own.
 */
describe('placements (React Native): Show when inherits from native', () => {
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..');
  const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8');

  it('exports the shared names and wire values', () => {
    const sdk = loadSdk(makeNative());
    expect(sdk.SHOW_WHEN_KINDS).toEqual(['load', 'seconds', 'scroll', 'exit', 'event']);
    // No capability (owner decision): placements exist only in the 1.4.0 betas.
    expect('SHOW_WHEN_CAPABILITY' in sdk).toBe(false);
  });

  it('a held item is absent until native reveals it; the reveal reaches onPlacementsUpdated', async () => {
    const held = JSON.stringify({ home_hero: { placementKey: 'home_hero', isControl: false, emptyBehavior: 'collapse', maxItems: 1, ttlSeconds: 300, items: [] } });
    const native = makeNative({ getPlacements: jest.fn().mockResolvedValue(held) });
    const { default: Joryio } = loadSdk(native);
    await Joryio.initialize('jry_sdk_ios_test', 'host');
    expect((await Joryio.getPlacements(['home_hero'])).home_hero.items).toEqual([]);
    const heard: number[] = [];
    Joryio.onPlacementsUpdated((p) => heard.push(p.home_hero?.items.length ?? -1));
    await flush();
    native.__listeners.get('JoryioPlacementsUpdated')!.forEach((cb) => cb({ json }));
    expect(heard).toEqual([1]);
  });

  it('a control answer before its moment: markDisplayed still goes to native, which decides', async () => {
    const native = makeNative({ getPlacements: jest.fn().mockResolvedValue(json) });
    const { default: Joryio } = loadSdk(native);
    await Joryio.initialize('jry_sdk_ios_test', 'host');
    (await Joryio.getPlacements(['cart_upsell'])).cart_upsell.markDisplayed();
    expect(native.markPlacement).toHaveBeenCalledWith('cart_upsell', null, 'control', null);
  });

  it('tripwire: neither native module builds a placements request of its own', () => {
    const swift = read('ios/JoryioModule.swift');
    const kt = read('android/src/main/java/io/joryio/reactnative/JoryioModule.kt');
    for (const src of [swift, kt]) {
      expect(src).not.toMatch(/in-app\/placements/);
      expect(src).not.toMatch(/show_when|recheckEvent/);
    }
    // Placements come from the native SDK call, which builds the request.
    expect(swift).toMatch(/Joryio\.shared\.getPlacements\(/);
    expect(kt).toMatch(/getPlacements\(placementKeys\(keys\)/);
    // The JS layer builds no placements request either.
    const ts = read('src/index.ts');
    expect(ts).not.toMatch(/in-app\/placements/);
  });
});

describe('placements (React Native): deep links', () => {
  /** The SDK with a native view component, and React reduced to what JoryioPlacement calls. */
  const loadWithView = () => {
    let mod: typeof import('../src') | undefined;
    jest.isolateModules(() => {
      jest.doMock(
        'react-native',
        () => ({
          NativeModules: { JoryioModule: makeNative() },
          NativeEventEmitter: class {
            addListener() {
              return { remove: () => undefined };
            }
          },
          requireNativeComponent: (name: string) => name,
        }),
        { virtual: true },
      );
      jest.doMock('react', () => ({ useState: (v: unknown) => [v, () => undefined], createElement: (type: unknown, props: any) => ({ type, props }) }));
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      mod = require('../src');
    });
    return mod!;
  };

  it('isAppDeepLink: only a scheme:// app link that is not http(s) nor a refused scheme', () => {
    const { isAppDeepLink } = loadSdk(makeNative());
    for (const url of ['myapp://cart', 'MyApp://p/1?x=y', 'com.shop.app://home']) expect({ url, ok: isAppDeepLink(url) }).toEqual({ url, ok: true });
    for (const url of [
      'javascript:alert(1)', 'javascript://%0aalert(1)', 'data:text/html,x', 'data://x', 'intent://scan#Intent;end', 'file:///etc/passwd',
      'vbscript://x', 'blob://x', 'about://blank', 'content://x', 'http://x.example', 'https://x.example', 'myapp:cart', 'myapp://', '', null, 42,
    ]) expect({ url, ok: isAppDeepLink(url) }).toEqual({ url, ok: false });
  });

  it('an app deep link from the native view reaches onDeepLink; javascript:, data:, intent: and http(s) do not', () => {
    const { JoryioPlacement } = loadWithView();
    const routed: string[] = [];
    const el = JoryioPlacement({ placementKey: 'home_hero', onDeepLink: (url) => routed.push(url) });
    expect(el.type).toBe('JoryioPlacementView');
    for (const url of ['myapp://cart', 'javascript:alert(1)', 'javascript://%0aalert(1)', 'data:text/html,x', 'intent://x#Intent;end', 'https://shop.example', 'http://shop.example']) {
      el.props.onPlacementDeepLink({ nativeEvent: { url, itemId: 'camp-1' } });
    }
    // http(s) is opened by the native PlacementView itself and never reaches JS as a deep link.
    expect(routed).toEqual(['myapp://cart']);
  });

  it('passes the product cards props to the native PlacementView (defaults: on, no button, 160)', () => {
    const { JoryioPlacement, PLACEMENT_PRODUCT_CARD_WIDTH, placementProductElementId } = loadWithView();
    const plain = JoryioPlacement({ placementKey: 'home_hero' });
    expect(plain.props).toMatchObject({ showProducts: true, productButtonText: null, productCardWidth: PLACEMENT_PRODUCT_CARD_WIDTH });
    expect(PLACEMENT_PRODUCT_CARD_WIDTH).toBe(160);
    const set = JoryioPlacement({ placementKey: 'home_hero', showProducts: false, productButtonText: 'Buy', productCardWidth: 120 });
    expect(set.props).toMatchObject({ showProducts: false, productButtonText: 'Buy', productCardWidth: 120 });
    expect(JoryioPlacement({ placementKey: 'home_hero', productCardWidth: -1 }).props.productCardWidth).toBe(160);
    expect(placementProductElementId('sku-1')).toBe('product:sku-1');
    expect(placementProductElementId('x'.repeat(300))).toHaveLength(128);
  });
});
