import * as fs from 'fs';
import * as path from 'path';

/**
 * The two native bridges, read as source.
 *
 * No JavaScript test can load Kotlin or Swift, and these properties are about
 * the SIGNATURES React Native calls into - what happens when JS hands a bridge
 * a null. The JS layer already filters nulls (see sdk.test.ts); these pin the
 * second line of defence, because a JS null in a non-null Kotlin parameter is a
 * NullPointerException on the native modules thread, which is a release-build
 * crash rather than a red box. Each assertion failed before the 1.3.0 round-2
 * fixes.
 */
const ROOT = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const KT = read('android/src/main/java/io/joryio/reactnative/JoryioModule.kt');
const SWIFT = read('ios/JoryioModule.swift');
const OBJC = read('ios/JoryioModule.m');

/** [method, param name, param type] for every @ReactMethod. */
function androidParams(): Array<[string, string, string]> {
  const out: Array<[string, string, string]> = [];
  for (const m of KT.matchAll(/@ReactMethod\s+fun (\w+)\(([^)]*)\)/g)) {
    for (const raw of m[2].split(',')) {
      const p = raw.trim();
      if (!p) continue;
      const [name, type] = p.split(':').map((x) => x.trim());
      out.push([m[1], name, type]);
    }
  }
  return out;
}

/** [method, param label, param type] for every @objc func. */
function iosParams(): Array<[string, string, string]> {
  const out: Array<[string, string, string]> = [];
  for (const m of SWIFT.matchAll(/@objc func (\w+)\(([^)]*)\)/g)) {
    // Split on commas that are not inside a closure type's parentheses.
    for (const raw of m[2].split(/,(?![^(]*\))/)) {
      const p = raw.trim();
      if (!p) continue;
      const colon = p.indexOf(':');
      out.push([m[1], p.slice(0, colon).trim(), p.slice(colon + 1).trim()]);
    }
  }
  return out;
}

describe('Android bridge', () => {
  it('reads the method list (guards against an empty comparison)', () => {
    expect(androidParams().length).toBeGreaterThan(40);
  });

  it('takes every object parameter as nullable', () => {
    const nonNull = androidParams().filter(
      ([, , type]) => /^(String|ReadableMap|ReadableArray|Dynamic)$/.test(type),
    );
    expect(nonNull).toEqual([]);
  });

  it('takes no primitive number a JS null could reach', () => {
    // React Native reads a Double/Int parameter with getDouble/getInt, which
    // throws on null before the method runs. removeListeners is called by
    // React Native itself, always with a number.
    const primitives = androidParams().filter(
      ([method, , type]) => /^(Double|Int|Long|Float|Boolean)$/.test(type) && method !== 'removeListeners',
    );
    expect(primitives).toEqual([]);
  });

  it('never reads a config or payload value with a throwing getter', () => {
    // getInt/getDouble/getBoolean throw on a present-but-null key; one
    // `batchSize: null` failed initialize() and left the SDK off.
    expect(KT.match(/\b(config|payload|m)\.get(Int|Double|Boolean|String|Map|Array)\(/g)).toBeNull();
  });

  it('releases the native callbacks it installed when the module is invalidated', () => {
    const body = KT.slice(KT.indexOf('override fun invalidate()'));
    expect(body.length).toBeLessThan(KT.length);
    const fn = body.slice(0, body.indexOf('super.invalidate()'));
    expect(fn).toContain('clearInAppMessageCallback()');
    expect(fn).toContain('setSdkAuthenticationErrorHandler(null)');
  });

  // A consent decision made before initialize() must be applied INSIDE init
  // (the static form), not replayed after init's first sync (whenReady).
  it('forwards updateConsent through the static native call', () => {
    const fn = KT.slice(KT.indexOf('fun updateConsent('));
    expect(fn.slice(0, 700)).toMatch(/\bJoryio\.updateConsent\(parsed\)/);
    expect(fn.slice(0, 700)).not.toMatch(/whenReady \{ it\.updateConsent/);
  });

  // Scan 8 S2 (contract v8 84): through whenReady the token was an ordinary
  // buffered action - applied after the constructor's first requests, and
  // deleted by a pre-init wipeData(), so the erased person's unsubscribe went
  // out with no token. The companion setters record both for the constructor
  // and keep them through a pre-init wipe.
  it('sets the SDK-auth token and handler through the pre-init-aware companion setters', () => {
    const token = KT.slice(KT.indexOf('fun setSdkAuthenticationToken('), KT.indexOf('fun enableSdkAuthenticationErrors('));
    expect(token).toMatch(/\n\s+Joryio\.setSdkAuthenticationToken\(token\)/);
    expect(token).not.toContain('whenReady');
    const handler = KT.slice(KT.indexOf('fun enableSdkAuthenticationErrors('), KT.indexOf('// ─── Utilities'));
    expect(handler).toMatch(/\n\s+Joryio\.setSdkAuthenticationErrorHandler \{ error ->/);
    expect(handler).not.toContain('whenReady');
    expect(handler).not.toMatch(/\bsdk\.setSdkAuthenticationErrorHandler/);
  });

  // The iOS counterparts: Joryio.shared's setters hold a token or handler set
  // before initialize() (pendingAuthToken / pendingAuthHandler) and apply them
  // at init, so the bridge calls them directly.
  it('iOS sets the SDK-auth token through the native pre-init-aware setter', () => {
    const token = SWIFT.slice(SWIFT.indexOf('@objc func setSdkAuthenticationToken('));
    expect(token.slice(0, 300)).toContain('Joryio.shared.setSdkAuthenticationToken(token)');
    const iosSdk = fs.readFileSync(path.join(ROOT, '../sdk-ios/Sources/Joryio/Core/JoryioSDK.swift'), 'utf8');
    for (const setter of ['public func setSdkAuthenticationToken(', 'public func setSdkAuthenticationErrorHandler(']) {
      const body = iosSdk.slice(iosSdk.indexOf(setter), iosSdk.indexOf(setter) + 900);
      expect(body).toMatch(/guard isInitialized else \{\s*Self\.withPreInit \{ Self\.pendingAuth(Token|Handler) = /);
    }
  });

  it('spells permission statuses with the native publicName, not a re-spelling', () => {
    expect(KT).toContain('.publicName');
    expect(KT).not.toContain('toCamel');
  });

  // Scan 3 #5: a bad key built a no-send native instance and resolved, so a
  // corrected initialize() got the broken instance back until a restart.
  it('refuses a key without the SDK prefix BEFORE creating a native instance', () => {
    const fn = KT.slice(KT.indexOf('fun initialize('), KT.indexOf('// ─── Null-safe reads'));
    const check = fn.indexOf('startsWith(SDK_KEY_PREFIX)');
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(fn.indexOf('context = reactApplicationContext.currentActivity'));
    // Contract v5 60: Android keys only - the backend issues jry_sdk_<platform>_.
    expect(KT).toMatch(/const val SDK_KEY_PREFIX = "jry_sdk_android_"/);
  });

  // Consent model A: an unset consent must reach native as unset, never as
  // GRANTED, or every default config lifts a stored denial.
  it('leaves trackingConsent unset unless JS set it', () => {
    const fn = KT.slice(KT.indexOf('fun initialize('), KT.indexOf('// ─── Null-safe reads'));
    expect(fn).toContain('joryioConfig.copy(trackingConsent = null)');
    expect(fn.indexOf('trackingConsent = null')).toBeLessThan(fn.indexOf('optString("trackingConsent")'));
  });

  // Scan 3 #2: required e-commerce arguments were filled with defaults.
  it('never defaults a required e-commerce id or total', () => {
    const fn = KT.slice(KT.indexOf('fun ecommerce('), KT.indexOf('private fun product(m: ReadableMap?)'));
    expect(fn).not.toMatch(/optString\("(orderId|productId|couponCode|paymentMethod|query)"\) \?: ""/);
    expect(fn).not.toMatch(/optDouble\("cartValue"\) \?: 0\.0/);
    expect(fn).toContain('needs an order with an orderId');
    // Contract item 42: the items array is required as well.
    expect(fn).toContain('needs an order with an items array');
  });
});

describe('iOS bridge', () => {
  it('reads the method list', () => {
    expect(iosParams().length).toBeGreaterThan(40);
  });

  it('takes every String / NSDictionary / NSArray / number parameter as optional', () => {
    const nonOptional = iosParams().filter(([, , type]) =>
      /^(String|NSDictionary|NSArray|NSNumber)$/.test(type),
    );
    expect(nonOptional).toEqual([]);
  });

  it('declares no nonnull argument React Native would refuse a null for', () => {
    expect(OBJC).not.toMatch(/nonnull/);
  });

  it('releases the native callbacks on invalidate and on deinit', () => {
    expect(SWIFT).toMatch(/override func invalidate\(\) \{\s*releaseNativeCallbacks\(\)\s*super\.invalidate\(\)/);
    expect(SWIFT).toMatch(/deinit \{\s*releaseNativeCallbacks\(\)/);
    const release = SWIFT.slice(SWIFT.indexOf('private func releaseNativeCallbacks()'));
    expect(release.slice(0, 600)).toContain('clearInAppMessageCallback()');
    // The auth handler is cleared, not replaced by a no-op that stays installed.
    expect(release.slice(0, 600)).toContain('clearSdkAuthenticationErrorHandler()');
  });

  // Scan 3 #5: the native SDK refuses a bad key by staying uninitialized,
  // and the bridge resolved anyway. Scan 4 #1: the fix for that rejected on
  // `currentApiEndpoint == nil`, which is ALSO what a deferred init (a launch
  // before the first unlock since boot) looks like - JS then marked the SDK
  // failed for the whole process. The refusal is now the key prefix itself,
  // checked before anything starts; everything else resolves.
  it('rejects initialize() only for a key without the iOS prefix, and resolves a deferred init', () => {
    const fn = SWIFT.slice(SWIFT.indexOf('@objc func initialize('), SWIFT.indexOf('// MARK: - Event Tracking'));
    expect(SWIFT).toContain('private static let sdkKeyPrefix = "jry_sdk_ios_"');
    const prefix = fn.indexOf('guard sdkKey.hasPrefix(Self.sdkKeyPrefix) else');
    expect(prefix).toBeGreaterThan(0);
    expect(prefix).toBeLessThan(fn.indexOf('DispatchQueue.main.async'));
    // Not a rejection on "not started (yet)".
    expect(fn).not.toMatch(/Joryio\.shared\.currentApiEndpoint/);
    const body = fn.slice(fn.indexOf('DispatchQueue.main.async'));
    expect(body).not.toContain('reject(');
    expect(body).toContain('resolve(nil)');
    // The deferral is named through the native SDK's public flag.
    expect(body).toContain('Joryio.shared.isInitializationPending');
  });

  // Scan 4 #1: installed after a DEFERRED native initialize(), the handler
  // went to the not-yet-initialized SDK's pre-init slot only by luck of
  // ordering; installed before it, the native pre-init path always carries it
  // into the init that runs on unlock.
  it('installs the SDK-auth handler before calling native initialize()', () => {
    const fn = SWIFT.slice(SWIFT.indexOf('@objc func initialize('), SWIFT.indexOf('// MARK: - Event Tracking'));
    const handler = fn.indexOf('Joryio.shared.setSdkAuthenticationErrorHandler');
    const init = fn.indexOf('Joryio.shared.initialize(sdkKey:');
    expect(handler).toBeGreaterThan(0);
    expect(init).toBeGreaterThan(0);
    expect(fn.indexOf('self.takeOwnership(.auth)')).toBeLessThan(handler);
    expect(handler).toBeLessThan(init);
  });

  // Consent model A: never fill in `.granted` for an app that set nothing.
  it('leaves trackingConsent out of the native config unless JS set it', () => {
    expect(SWIFT).toMatch(/var trackingConsent: JoryioConfig\.TrackingConsent\?\n/);
    expect(SWIFT).not.toMatch(/trackingConsent: JoryioConfig\.TrackingConsent = \.granted/);
  });

  it('never defaults a required e-commerce id or total', () => {
    const fn = SWIFT.slice(SWIFT.indexOf('@objc func ecommerce('), SWIFT.indexOf('private static func product('));
    expect(fn).not.toMatch(/p\["(orderId|productId|couponCode|paymentMethod|query)"\] as\? String \?\? ""/);
    expect(fn).not.toMatch(/p\["cartValue"\] as\? Double \?\? 0/);
    expect(fn).toContain('Self.order(order)');
    // Contract item 42: the items array is required as well.
    expect(fn).toMatch(/orderItems\(order\["items"\]\),\s*amount\("order\.value"/);
  });
});

describe('both bridges and the JS layer', () => {
  it('bind getTrackingConsent', () => {
    expect(KT).toMatch(/@ReactMethod\s+fun getTrackingConsent\(promise: Promise\)/);
    expect(SWIFT).toContain('@objc func getTrackingConsent(');
    expect(OBJC).toContain('RCT_EXTERN_METHOD(getTrackingConsent:');
  });
});

describe('scan 5: second line of defence in both bridges', () => {
  // D-c: no old-name leftovers in the bridges.
  it('carries no old product name', () => {
    // `hipp?` also covers the old company name, which no shipped file spells.
    expect(KT).not.toMatch(/\bhipp?\w*/i);
    expect(SWIFT).not.toMatch(/\bhipp?\w*/i);
  });

  // S1: a null line became a line with no productId and the native tracker
  // refused the WHOLE order.
  it('skip a null cart/order line instead of turning it into an empty line', () => {
    const kt = KT.slice(KT.indexOf('private fun cartItems(arr: ReadableArray?): List<EcommerceCartItem> {'));
    expect(kt.slice(0, 600)).toMatch(/\.filter \{ i -> a\.getType\(i\) == ReadableType\.Map \}/);
    const sw = SWIFT.slice(SWIFT.indexOf('private static func cartItems('));
    expect(sw.slice(0, 500)).toContain('compactMap { $0 as? [String: Any] }');
  });

  // S5: Swift's Int(Double) traps past Int.max.
  it('bound the submitReview rating before converting it to Int', () => {
    const sw = SWIFT.slice(SWIFT.indexOf('case "submitReview":'), SWIFT.indexOf('rating: Int(rating)'));
    expect(sw).toContain('guard abs(rating) <= Double(Int32.max) else');
    const kt = KT.slice(KT.indexOf('"submitReview" ->'), KT.indexOf('rating.toInt()'));
    expect(kt).toContain('abs(r) <= Int.MAX_VALUE.toDouble()');
  });
});

describe('podspec', () => {
  it('declares the Swift version the bridge is written in', () => {
    expect(read('joryio-react-native.podspec')).toMatch(/s\.swift_version\s*=\s*"5\.9"/);
  });
});
