import * as fs from 'fs';
import * as path from 'path';
import { loadSdk, makeNative, flush } from './helpers';

/**
 * Content cards on React Native (D444 Phase 3). The native SDKs do the work -
 * the request, the cache, the rate limit, notModified / 429 handling, the
 * anonymous visitor's device state, the silent push - and are tested there
 * (CardManagerTest.kt, CardManagerTests.swift). The JS layer must hand the
 * feed over faithfully, send every report back to native by card id, and
 * never throw into the app.
 */
const feedJson = JSON.stringify({
  cards: [
    {
      id: 'card-1',
      campaignId: 'camp-1',
      variantId: null,
      title: 'Welcome',
      body: 'Hello there',
      imageUrl: 'https://cdn.example/a.png',
      buttonText: 'Open',
      url: 'https://shop.example/sale',
      pinned: true,
      createdAt: '2026-11-20T10:00:00.000Z',
      expiresAt: null,
      read: false,
      clicked: false,
    },
    {
      id: 'card-2',
      campaignId: 'journey:canvas-1:node-2',
      variantId: 'v2',
      title: null,
      body: 'Second',
      imageUrl: null,
      buttonText: null,
      url: 'myapp://cart',
      pinned: false,
      createdAt: '2026-11-19T10:00:00.000Z',
      expiresAt: '2026-12-01T00:00:00.000Z',
      read: true,
      clicked: false,
    },
  ],
  unreadCount: 1,
  nextCursor: 'cursor-2',
  stateScope: 'device',
});

describe('content cards (React Native)', () => {
  it('exports the shared constants', () => {
    const sdk = loadSdk(makeNative());
    expect(sdk.CARD_MIN_REFRESH_SECONDS).toBe(30);
    expect(sdk.CARD_FEED_TTL_SECONDS).toBe(300);
  });

  it('getCards parses the native feed (the exact field names) and asks for the feed, not a page', async () => {
    const native = makeNative({ getCards: jest.fn().mockResolvedValue(feedJson) });
    const { default: Joryio } = loadSdk(native);
    await Joryio.initialize('jry_sdk_ios_test', 'api-eu1.joryio.com');
    const feed = await Joryio.getCards();
    expect(native.getCards).toHaveBeenCalledWith(null);
    expect(feed.unreadCount).toBe(1);
    expect(feed.nextCursor).toBe('cursor-2');
    expect(feed.stateScope).toBe('device');
    expect(feed.cards).toHaveLength(2);
    expect(Object.keys(feed.cards[0]).sort()).toEqual(
      ['id', 'campaignId', 'variantId', 'title', 'body', 'imageUrl', 'buttonText', 'url', 'pinned', 'createdAt', 'expiresAt', 'read', 'clicked'].sort(),
    );
    expect(feed.cards[0]).toMatchObject({ id: 'card-1', pinned: true, read: false, url: 'https://shop.example/sale' });
    expect(feed.cards[1]).toMatchObject({ id: 'card-2', title: null, variantId: 'v2', read: true, expiresAt: '2026-12-01T00:00:00.000Z' });
    // No delivery token ever reaches JS.
    expect(JSON.stringify(feed)).not.toContain('deliveryToken');
  });

  it('getCards({ cursor }) forwards the cursor for the next page', async () => {
    const native = makeNative({ getCards: jest.fn().mockResolvedValue(feedJson) });
    const { default: Joryio } = loadSdk(native);
    await Joryio.initialize('jry_sdk_ios_test', 'api-eu1.joryio.com');
    await Joryio.getCards({ cursor: 'cursor-2' });
    await Joryio.getCards({ cursor: '' });
    expect(native.getCards.mock.calls).toEqual([['cursor-2'], [null]]);
  });

  it('resolves the empty feed without the native module, on a bad answer and on a native rejection', async () => {
    const empty = { cards: [], unreadCount: 0, nextCursor: null, stateScope: 'server' };
    expect(await loadSdk(null).default.getCards()).toEqual(empty);

    const bad = loadSdk(makeNative({ getCards: jest.fn().mockResolvedValue('not json') })).default;
    await bad.initialize('jry_sdk_ios_test', 'api-eu1.joryio.com');
    expect(await bad.getCards()).toEqual(empty);

    const rejecting = loadSdk(makeNative({ getCards: jest.fn().mockRejectedValue(new Error('boom')) })).default;
    await rejecting.initialize('jry_sdk_ios_test', 'api-eu1.joryio.com');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await rejecting.getCards()).toEqual(empty);
    warn.mockRestore();
  });

  it('drops a malformed card and clamps an impossible unread count', async () => {
    const json = JSON.stringify({ cards: [{ title: 'no id' }, null, { id: 'ok' }], unreadCount: -3, stateScope: 'weird' });
    const native = makeNative({ getCards: jest.fn().mockResolvedValue(json) });
    const { default: Joryio } = loadSdk(native);
    await Joryio.initialize('jry_sdk_ios_test', 'api-eu1.joryio.com');
    const feed = await Joryio.getCards();
    expect(feed.cards.map((c) => c.id)).toEqual(['ok']);
    expect(feed.cards[0]).toMatchObject({ campaignId: '', pinned: false, read: false, clicked: false, url: null });
    expect(feed.unreadCount).toBe(0);
    expect(feed.stateScope).toBe('server');
  });

  it('getUnreadCardCount answers the native cache count (0 on a bad answer)', async () => {
    const native = makeNative({ getUnreadCardCount: jest.fn().mockResolvedValueOnce(4).mockResolvedValueOnce(null) });
    const { default: Joryio } = loadSdk(native);
    await Joryio.initialize('jry_sdk_ios_test', 'api-eu1.joryio.com');
    expect(await Joryio.getUnreadCardCount()).toBe(4);
    expect(await Joryio.getUnreadCardCount()).toBe(0);
    expect(await loadSdk(null).default.getUnreadCardCount()).toBe(0);
  });

  it('every report goes to native by card id - a card or its id - and an empty id is never sent', async () => {
    const native = makeNative({ getCards: jest.fn().mockResolvedValue(feedJson) });
    const { default: Joryio } = loadSdk(native);
    await Joryio.initialize('jry_sdk_ios_test', 'api-eu1.joryio.com');
    const feed = await Joryio.getCards();
    Joryio.markCardViewed(feed.cards[0]);
    Joryio.markCardRead(feed.cards[0]);
    Joryio.markCardClicked('card-2');
    Joryio.dismissCard(feed.cards[1]);
    Joryio.markCardRead('');
    Joryio.dismissCard(null as unknown as string);
    expect(native.markCardViewed.mock.calls).toEqual([['card-1']]);
    expect(native.markCardRead.mock.calls).toEqual([['card-1']]);
    expect(native.markCardClicked.mock.calls).toEqual([['card-2']]);
    expect(native.dismissCard.mock.calls).toEqual([['card-2']]);
  });

  it('refreshCards is held until initialize() and then reaches native', async () => {
    const native = makeNative();
    const { default: Joryio } = loadSdk(native);
    Joryio.refreshCards();
    expect(native.refreshCards).not.toHaveBeenCalled();
    await Joryio.initialize('jry_sdk_ios_test', 'api-eu1.joryio.com');
    await flush();
    expect(native.refreshCards).toHaveBeenCalledTimes(1);
  });

  it('onCardsUpdated enables native updates once, delivers the parsed feed, and disables on the last unsubscribe', async () => {
    const native = makeNative();
    const { default: Joryio } = loadSdk(native);
    await Joryio.initialize('jry_sdk_ios_test', 'api-eu1.joryio.com');
    const heard: number[] = [];
    const off1 = Joryio.onCardsUpdated((f) => heard.push(f.unreadCount));
    const off2 = Joryio.onCardsUpdated(() => {
      throw new Error('app bug');
    });
    await flush();
    expect(native.enableCardsUpdates).toHaveBeenCalled();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    native.__listeners.get('JoryioCardsUpdated')!.forEach((cb) => cb({ json: feedJson }));
    warn.mockRestore();
    expect(heard).toEqual([1]);
    // A JoryioSubscription: cancel() stops it (the same name on all five SDKs); calling it is the same.
    off1.cancel();
    off1();
    off1.cancel();
    await flush();
    expect(native.disableCardsUpdates).not.toHaveBeenCalled();
    off2();
    await flush();
    expect(native.disableCardsUpdates).toHaveBeenCalledTimes(1);
  });

  it('onCardsUpdated without the native module is a no-op subscription', () => {
    const off = loadSdk(null).default.onCardsUpdated(() => undefined);
    expect(typeof off.cancel).toBe('function');
    expect(() => off.cancel()).not.toThrow();
    expect(() => off()).not.toThrow();
  });
});

/**
 * `<JoryioCardFeed />`: onDeepLink gets the whole Card and onRender the whole
 * CardFeed, as on iOS, Android and web (the native views send their toJson()).
 */
describe('<JoryioCardFeed /> callbacks', () => {
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
  const card2 = JSON.stringify(JSON.parse(feedJson).cards[1]);

  it('onDeepLink gets the url and the parsed Card', () => {
    const { JoryioCardFeed } = loadWithView();
    const routed: Array<[string, any]> = [];
    const el = JoryioCardFeed({ onDeepLink: (url, card) => routed.push([url, card]) });
    expect(el.type).toBe('JoryioCardFeedView');
    el.props.onCardDeepLink({ nativeEvent: { url: 'myapp://cart', card: card2 } });
    expect(routed).toEqual([['myapp://cart', JSON.parse(feedJson).cards[1]]]);
    // No card (an older native view) or a bad one: nothing is called.
    el.props.onCardDeepLink({ nativeEvent: { url: 'myapp://cart' } });
    el.props.onCardDeepLink({ nativeEvent: { url: 'myapp://cart', card: 'not json' } });
    expect(routed).toHaveLength(1);
  });

  it('onRender gets the parsed CardFeed', () => {
    const { JoryioCardFeed } = loadWithView();
    const drawn: any[] = [];
    const el = JoryioCardFeed({ onRender: (feed) => drawn.push(feed) });
    el.props.onCardFeedRender({ nativeEvent: { feed: feedJson } });
    expect(drawn).toEqual([JSON.parse(feedJson)]);
    el.props.onCardFeedRender({ nativeEvent: {} });
    expect(drawn[1]).toEqual({ cards: [], unreadCount: 0, nextCursor: null, stateScope: 'server' });
  });
});

/**
 * The native halves, read as source: no JS test can load Kotlin or Swift.
 * `<JoryioCardFeed />` is the native SDK's own feed view (one link rule and one
 * viewability rule per platform), and every report goes back to the native
 * Card object the bridge handed out, so the native identity check applies.
 */
describe('content cards bridges (source)', () => {
  const ROOT = path.join(__dirname, '..');
  const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
  const KT = read('android/src/main/java/io/joryio/reactnative/JoryioModule.kt');
  const SWIFT = read('ios/JoryioModule.swift');
  const OBJC = read('ios/JoryioModule.m');

  it('both bridges bind every card method', () => {
    for (const m of ['getCards', 'getUnreadCardCount', 'markCardViewed', 'markCardRead', 'markCardClicked', 'dismissCard', 'refreshCards', 'enableCardsUpdates', 'disableCardsUpdates']) {
      expect({ m, android: new RegExp(`@ReactMethod\\s+fun ${m}\\(`).test(KT) }).toEqual({ m, android: true });
      expect({ m, ios: SWIFT.includes(`@objc func ${m}(`) }).toEqual({ m, ios: true });
      expect({ m, objc: OBJC.includes(`RCT_EXTERN_METHOD(${m}`) }).toEqual({ m, objc: true });
    }
  });

  it('reports go to the native Card object handed out, the id overload otherwise', () => {
    for (const m of ['markCardViewed', 'markCardRead', 'markCardClicked', 'dismissCard']) {
      expect(KT).toContain(`lastCards[id]?.let { sdk.${m}(it) } ?: sdk.${m}(id)`);
      expect(SWIFT).toContain(`if let card = lastCard(id) { Joryio.shared.${m}(card) } else { Joryio.shared.${m}(id) }`);
    }
  });

  it('getCards passes the cursor to the native call', () => {
    expect(KT).toMatch(/Joryio\.getInstance\(\)\.getCards\(c\)/);
    expect(SWIFT).toMatch(/Joryio\.shared\.getCards\(cursor: c\)/);
  });

  it('the feed view managers wrap the native feed views', () => {
    expect(read('android/src/main/java/io/joryio/reactnative/JoryioCardFeedViewManager.kt')).toMatch(/CardFeedView\(context\)/);
    expect(read('android/src/main/java/io/joryio/reactnative/JoryioPackage.kt')).toContain('JoryioCardFeedViewManager()');
    expect(read('ios/JoryioCardFeedViewManager.swift')).toMatch(/CardFeedViewController\(\)/);
    expect(read('ios/JoryioCardFeedViewManager.m')).toMatch(/RCT_EXPORT_VIEW_PROPERTY\(emptyText, NSString\)/);
  });

  it('the iOS bridge listens through attachCardFeedListener (nil before initialize, so a later enable retries)', () => {
    expect(SWIFT).toMatch(/cardsSubscription = Joryio\.shared\.attachCardFeedListener/);
    // SDK-internal on iOS (SPI): an app listens with onCardsUpdated.
    expect(SWIFT).toMatch(/^@_spi\(JoryioInternal\) import Joryio$/m);
    expect(SWIFT).toContain('"JoryioCardsUpdated"');
  });

  it('the feed views send the whole card and feed to JS (toJson), not just the id', () => {
    const viewKt = read('android/src/main/java/io/joryio/reactnative/JoryioCardFeedViewManager.kt');
    const viewSwift = read('ios/JoryioCardFeedViewManager.swift');
    expect(viewKt).toContain('putString("card", card.toJson())');
    expect(viewKt).toContain('putString("feed", f.toJson())');
    expect(viewSwift).toContain('"card": Self.jsonText(card.toJson())');
    expect(viewSwift).toContain('"feed": Self.jsonText(f.toJson())');
    expect(viewKt + viewSwift).not.toMatch(/"cardId"/);
  });
});
