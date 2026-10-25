import { NativeModules, NativeEventEmitter, Platform } from 'react-native';

const { JoryioModule } = NativeModules;

/**
 * Mirrors the backend's SUBSCRIPTION_CHANNELS and the web SDK. Five, including
 * viber - it was added to the backend and to no SDK.
 */
export type SubscriptionChannel = 'email' | 'sms' | 'whatsapp' | 'push' | 'viber';

/**
 * Wire values are camelCase. The backend 400s on `opted_in` - a
 * NormalizeEnumCasing migration renamed the stored value and the enum NAME,
 * not the wire string, is what changed.
 */
export type SubscriptionStatus = 'optedIn' | 'subscribed' | 'unsubscribed';


const MODULE_MISSING_MESSAGE =
  '@joryio/react-native-sdk: NativeModule not found. ' +
  'Make sure you ran `pod install` (iOS) / rebuilt the app (Android). ' +
  'All Joryio calls will be no-ops until the native module is linked.';

// Degrade instead of crashing the whole JS bundle on import: if the native
// module isn't linked, warn once and turn every method into a safe no-op.
const isModuleAvailable = !!JoryioModule;
if (!isModuleAvailable) {
  // eslint-disable-next-line no-console
  console.warn(MODULE_MISSING_MESSAGE);
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface JoryioConfig {
  /**
   * Ask for notification permission automatically, soon after initialize().
   *
   * **Off by default, and that default is the recommendation.** The system
   * prompt can be shown exactly once and a refusal is permanent short of a trip
   * to Settings, so firing it at launch - before the user has any reason to
   * want notifications from you - is how apps spend their single ask for
   * nothing. Prefer a primer (the `request_push_permission` in-app button) and
   * call `requestPushPermission()` when the user says yes.
   *
   * Turn this on only when notifications ARE the product.
   *
   * Works on both platforms. On iOS the prompt fires straight after
   * initialize(); on Android it waits for the first foreground, because the
   * system prompt there needs an Activity.
   */
  requestPushPermissionAtLaunch?: boolean;
  /** Enable debug logging (default: false) */
  enableDebug?: boolean;
  /**
   * Log level: 'debug' | 'info' | 'warn' | 'error'.
   *
   * No fixed default: left unset, both native bridges derive it from
   * `enableDebug` - 'debug' when that is true, 'error' otherwise. Set it only
   * to override that derivation (for example 'warn' with `enableDebug: true`).
   */
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
  /** Event batch size before auto-flush. Omit to use the native default (50). */
  batchSize?: number;
  /** Event flush interval in ms. Omit to use the native default (5000). */
  flushInterval?: number;
  /**
   * Send each event as soon as it is tracked instead of batching (default:
   * false). Not recommended for production - one request per event.
   */
  sendImmediately?: boolean;
  /**
   * Most events the local queue holds while flushes fail; beyond it the oldest
   * are dropped. Omit to use the native default (1000).
   */
  maxQueueSize?: number;
  /** Per-request HTTP timeout in ms. Omit to use the native default (10000). */
  requestTimeout?: number;
  /** Session timeout in ms. Omit to use the native default (1800000 / 30 min). */
  sessionTimeout?: number;
  /** Automatically track session start (default: true) */
  trackSessionStart?: boolean;
  /** Initial user ID if known at init time */
  userId?: string;
  /**
   * Your own anonymous id, if you already have one for this device.
   *
   * Used for this run and stored only when nothing is stored yet, exactly as
   * the native SDKs and the web SDK treat it - so an id set once at init
   * survives the app dropping the option later. Omit to let the SDK generate
   * one.
   */
  anonymousId?: string;
  /**
   * Enable JWT-based SDK Authentication (default: false). When enabled, supply a
   * customer-minted JWT via `sdkAuthenticationToken` and/or
   * `setSdkAuthenticationToken()`; it is attached to every ingest request.
   */
  enableSdkAuthentication?: boolean;
  /** Initial SDK-authentication JWT, if known at init time. */
  sdkAuthenticationToken?: string;

  /**
   * Allow in-app messages authored as HTML, which the native SDK shows in a
   * web view inside your app. Passed through to the native iOS and Android
   * SDKs.
   *
   * OFF BY DEFAULT. The server keeps the markup as written (only `<base>` and
   * meta refresh are removed). Scripts and `on*` handlers in it do NOT run:
   * the native SDKs show the document under a Content-Security-Policy where
   * only their own bridge executes, and the bridge handles buttons and forms.
   * The web view can still execute script, so the residual risk is a gap in
   * that policy - and because the document is authored server-side, a
   * compromised marketing account would then mean code executing in every
   * user's session, which is why regulated apps often prohibit a web view
   * outright.
   *
   * Leaving this off does NOT disable in-app messaging: native messages still
   * display, because they are data your app renders with its own components.
   */
  allowHtmlJsInAppMessages?: boolean;

  /**
   * Your app draws in-app messages itself ({@link JoryioSDK.onInAppMessage})
   * and subscribes AFTER `initialize()` has completed - for example on a
   * screen that mounts later. Until that subscription, the SDK draws nothing:
   * a message that is ready meanwhile is held (not drawn, not reported,
   * nothing spent) and handed to your listener when it subscribes.
   * Calling {@link JoryioSDK.disableInAppMessages} instead ends the hold and
   * the native SDK draws the held message. Off by default.
   *
   * You do NOT need it when you subscribe before `initialize()` completes -
   * at module scope, or in an effect that runs at start-up: the SDK holds
   * every message until `initialize()` has completed and your subscription
   * has reached native, then hands rendering to the native SDK only if
   * nobody subscribed.
   *
   * Same option, same name, on iOS, Android and Unity.
   */
  holdInAppMessagesForHandler?: boolean;

  /**
   * Tracking consent at start-up. Same option and values as the web, iOS,
   * Android and Unity SDKs.
   *
   * Leave it UNSET unless your consent banner has an answer for this launch.
   * Unset means "no decision here": with nothing stored the SDK runs as
   * `'granted'`, and a `'denied'` stored by an earlier launch stays in force.
   * Passing `'granted'` is an explicit decision and lifts a stored denial.
   *
   *  - `'granted'` - normal operation.
   *  - `'pending'` - nothing is SENT: events and attribute writes queue on the
   *    device (bounded by `maxQueueSize`), and there is no session start, no
   *    in-app sync and no push registration until you call
   *    `updateConsent('granted')`. `updateConsent('denied')` discards them.
   *    Applies to this launch only and never replaces a stored `'denied'`.
   *  - `'denied'` - nothing is collected and queued events are cleared. Stored,
   *    so it holds on later launches until `updateConsent('granted')` or an
   *    explicit `trackingConsent: 'granted'`.
   *
   * Consent and the opt-out ({@link JoryioSDK.optOut}) are separate switches,
   * and any "no" wins: `'granted'` never cancels an opt-out.
   */
  trackingConsent?: TrackingConsent;
  /**
   * Start opted out of tracking (default: false). The same as calling
   * {@link JoryioSDK.optOut} straight after initialize(), without the window in
   * between. An opt-out is stored on the device and survives restarts, so
   * passing `false` here does not undo an earlier `optOut()` - call `optIn()`.
   */
  optOut?: boolean;
  /**
   * Android only: the name of the notification channel Joryio push uses, as
   * people see it in system Settings (Android 8+). Pass it localized - for
   * example from your app's own strings. Omit to use the native default,
   * "Notifications". Ignored on iOS, which has no notification channels.
   */
  notificationChannelName?: string;
}

/** Tracking consent values, identical on every Joryio SDK. */
export type TrackingConsent = 'granted' | 'denied' | 'pending';

/**
 * Attribute values. `null` UNSETS the attribute - the same as
 * `unsetAttribute(key)` - on both platforms.
 */
export type UserAttributes = Record<string, string | number | boolean | null>;

/**
 * Notification permission state, identical on iOS and Android.
 *
 * `unavailable` means we could not ask at all (no Activity, SDK not ready, or a
 * platform with no notification support) - distinct from `denied`, which means
 * the user said no and the prompt will not appear again.
 */
export type PushPermissionStatus =
  | 'granted'
  | 'denied'
  | 'notDetermined'
  | 'unavailable';

/** Reason an ingest request was rejected with a 401 `sdk_authentication_error`. */
export interface SdkAuthError {
  reason: 'missing' | 'invalid' | 'expired' | 'sub_mismatch' | 'unknown';
  /**
   * Raw wire `reason` string, for logging / forward-compat.
   *
   * Worth reading whenever `reason` is `'unknown'`: that value means only that
   * THIS SDK version did not recognise what the server sent, and this is the
   * only place the server's actual word survives.
   */
  rawReason?: string;
  /** The ingest endpoint whose request was rejected. */
  endpoint?: string;
  /**
   * The SDK has STOPPED trying for this request - either no fresh token
   * arrived, or one did and was rejected as well.
   *
   * `false` means the SDK is asking you for a token; `true` means it gave up.
   * Branch on this rather than on the arrival of an error, or a handler that
   * signs the user out fires on the first recoverable rejection.
   *
   * Both platforms emit all four fields. Until 2026-08-31 iOS sent
   * {reason, endpoint, refreshExhausted} and Android sent {reason, rawReason},
   * so half of any handler was dead on whichever platform was not tested.
   */
  refreshExhausted?: boolean;
}

/**
 * An in-app message to display.
 *
 * `kind` discriminates the content. BOTH kinds reach JS: a React Native app
 * renders its own UI, so dropping native here would mean native campaigns never
 * display in RN apps while still counting as delivered server-side.
 *
 * Native fields are TEXT, not markup - the server does not HTML-escape them
 * (escaping would show the user `A &amp; B`), so rendering one into a WebView
 * or `dangerouslySetInnerHTML` would reintroduce the injection native avoids.
 * Put them in a <Text>.
 */
export type InAppMessage = InAppMessageBase &
  (
    | {
        kind: 'html';
        html: string;
        css: string;
        /**
         * Widest the message may be, in points/dp, for `modal` and `slideup`
         * (absent otherwise). Your renderer gives the web view
         * min(maxWidth, screen width - your margins) BEFORE the content lays
         * out, so the author's media queries see the real width, and lets only
         * the height follow the content. Default when the server sends none:
         * modal 600, slideup 400 - the same as every SDK.
         *
         * Measure the height from `document.body` (with
         * `body{display:flow-root}`), not `document.documentElement`: the
         * root's scrollHeight is never below the web view's own height, so a
         * message sized from it can grow but never shrink.
         */
        maxWidth?: number;
      }
    | {
        kind: 'native';
        title?: string;
        body: string;
        imageUrl?: string;
        buttons: Array<{
          id: string;
          text: string;
          /**
           * What the button does when your renderer draws it:
           *
           *  - `dismiss` - close the message.
           *  - `url` - open `url` in the browser.
           *  - `deep_link` - route to `url` inside your app.
           *  - `request_push_permission` - a push primer's "yes" button: close
           *    the message and call `Joryio.requestPushPermission()`.
           *
           * Report the tap with `trackInAppImpression(message.id, 'clicked')`
           * in every case.
           */
          action: InAppButtonAction;
          url?: string;
        }>;
        closeButton: boolean;
        backdropDismissible: boolean;
        /**
         * Optional presentation overrides set by the campaign author.
         *
         * Every field is optional and an absent one means INHERIT your app's
         * own styling - which is why a message with no overrides looks like the
         * rest of your UI. Apply the ones that are present; do not substitute
         * defaults of your own for the ones that are not.
         *
         * `fontFamily` is best effort: apply it only if your app bundles that
         * font, and keep your own typeface when it does not - substituting an
         * arbitrary font looks worse than ignoring the override.
         */
        style?: {
          backgroundColor?: string;
          textColor?: string;
          primaryButtonColor?: string;
          primaryButtonTextColor?: string;
          cornerRadius?: number;
          /** Body size; scale the headline from it to keep the hierarchy. */
          fontSize?: number;
          titleWeight?: 'regular' | 'medium' | 'semibold' | 'bold';
          /**
           * `auto` (or absent) means align by the MESSAGE's own language, not
           * the device locale - `I18nManager.isRTL` is the wrong test, because
           * one workspace sends Hebrew and English to the same app. React
           * Native's `writingDirection: 'auto'` does this for you.
           */
          textAlign?: 'auto' | 'start' | 'center' | 'end';
          /** Apply only if your app bundles it; otherwise keep your own. */
          fontFamily?: string;
        };
      }
  );

/** Native in-app button actions, spelled as both native bridges send them. */
export type InAppButtonAction = 'dismiss' | 'url' | 'deep_link' | 'request_push_permission';

export interface InAppMessageBase {
  id: string;
  name: string;
  type: 'modal' | 'banner' | 'slideup' | 'fullscreen' | 'custom';
  priority: number;
}

// ─── Event Emitter ───────────────────────────────────────────────────────────

// Only construct the emitter when the native module exists — NativeEventEmitter
// throws if handed a null module.
const emitter = isModuleAvailable ? new NativeEventEmitter(JoryioModule) : null;

/** The server's verdict on a form submitted from an HTML in-app message. */
export interface InAppFormResult {
  ok: boolean;
  message?: string;
  redirect?: string;
  errors?: string[];
}

/**
 * One meaning for "no capabilities" on both platforms: an omitted or empty
 * list is NOT DECLARED (null). Android already read `[]` that way; iOS
 * forwarded it as "this app can draw nothing", which targets every campaign
 * away from the device.
 */
function normalizeCapabilities(capabilities?: readonly string[] | null): string[] | null {
  const declared = (Array.isArray(capabilities) ? capabilities : []).filter(
    (c) => typeof c === 'string' && c.length > 0,
  );
  return declared.length > 0 ? declared : null;
}

// ─── Host-input guards (contract item 19) ────────────────────────────────────
//
// Null or undefined from host code must never crash the app and never disable
// the SDK. JavaScript does not enforce the TypeScript signatures, and a null
// reaching a non-null Kotlin parameter is a NullPointerException on the native
// modules thread - a crash in a release build, not a red box. So every value
// is checked HERE, before the bridge; the bridges also take nullable
// parameters, as the second line of defence.

function warn(message: string): void {
  // eslint-disable-next-line no-console
  console.warn(`[Joryio] ${message}`);
}

/** A non-empty string, or a warning naming the call and the argument. */
function requireString(caller: string, name: string, value: unknown): value is string {
  if (typeof value === 'string' && value.length > 0) return true;
  warn(`${caller}() needs a non-empty string ${name}; ignored.`);
  return false;
}

/** A plain object (not null, not an array). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * An e-commerce id or label: not empty and not only whitespace, the same as
 * the native trackers. (Event names are different: a whitespace-only name is
 * the server's to judge - requireString does not trim.)
 */
function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Properties as a plain object; null, undefined or a non-object means none. */
function plainObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * A tracking consent value in the one spelling every SDK uses, or null.
 *
 * Case-insensitive, because the two bridges were not: Android matched
 * `'Denied'` and iOS ignored it, so the same config started one platform
 * denied and the other with no decision at all.
 */
function parseConsent(value: unknown): TrackingConsent | null {
  if (typeof value !== 'string') return null;
  const lower = value.trim().toLowerCase();
  return lower === 'granted' || lower === 'denied' || lower === 'pending' ? lower : null;
}

/**
 * The config as the bridges receive it: null values left out (see
 * withoutNullValues) and `trackingConsent` in its lowercase spelling. An
 * unrecognised consent is left out with a warning - UNSET, never a guess -
 * so the native SDK keeps whatever decision it has stored.
 */
function nativeConfig(config: unknown): Record<string, unknown> {
  const out = withoutNullValues(config);
  // Lower-cased like trackingConsent: iOS matched 'Warn' against nothing and
  // fell back to the enableDebug level, while Android upper-cased it.
  if (typeof out.logLevel === 'string') out.logLevel = out.logLevel.trim().toLowerCase();
  if ('trackingConsent' in out) {
    const parsed = parseConsent(out.trackingConsent);
    if (parsed === null) {
      warn(
        `initialize() trackingConsent takes 'granted', 'denied' or 'pending', not ` +
          `'${String(out.trackingConsent)}'; left unset.`,
      );
      delete out.trackingConsent;
    } else {
      out.trackingConsent = parsed;
    }
  }
  return out;
}

/**
 * The config with every null / undefined value left out, so the native SDK
 * applies its own default for it. A present-but-null key used to reach the
 * Android bridge, whose `getInt` threw - initialize() failed and the SDK was
 * off for the whole session because of a `batchSize: null`.
 */
function withoutNullValues(config: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(plainObject(config))) {
    if (value !== null && value !== undefined) out[key] = value;
  }
  return out;
}

/** A number that is NaN or +/-Infinity. */
function isNonFiniteNumber(value: unknown): boolean {
  return typeof value === 'number' && !Number.isFinite(value);
}

/**
 * An object the bridge serializes by its own enumerable keys - a class
 * instance, a MobX observable, a model object - but not a Date, which it
 * serializes as a value. Scanned for NaN like a plain object.
 */
function isKeyedObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
}

/** Plain `{}` / `Object.create(null)` objects - not Dates, class instances or arrays. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Nesting followed when dropping non-finite numbers; the backend allows 5. */
const MAX_FINITE_SCAN_DEPTH = 10;

/**
 * The value with every NaN / Infinity left out (contract v5 49): an object
 * key holding one is omitted, an array element is removed, and the call goes
 * ahead with the rest. Each drop is reported once per call through `dropped`.
 *
 * Not left to the natives, because the bridge changes them on the way: the
 * JSON bridge turns NaN into `null`, which means UNSET to an attribute write,
 * so `setAttribute('score', NaN)` erased the stored score.
 */
function withoutNonFinite(value: unknown, path: string, dropped: string[], depth = 0): unknown {
  if (depth > MAX_FINITE_SCAN_DEPTH) return value;
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    value.forEach((item, i) => {
      if (isNonFiniteNumber(item)) dropped.push(`${path}[${i}]`);
      else out.push(withoutNonFinite(item, `${path}[${i}]`, dropped, depth + 1));
    });
    return out;
  }
  if (isKeyedObject(value)) {
    const droppedBefore = dropped.length;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const at = path ? `${path}.${key}` : key;
      if (isNonFiniteNumber(item)) dropped.push(at);
      else out[key] = withoutNonFinite(item, at, dropped, depth + 1);
    }
    // A class instance (a cart line built from `class Line`, a MobX
    // observable) is scanned too: it reached the bridge with its NaN, which
    // Android read as a quantity of 0 and iOS as none. Copied into a plain
    // object only when something was dropped - the bridge sends the same own
    // keys either way - and otherwise passed on untouched.
    if (!isPlainObject(value) && dropped.length === droppedBefore) return value;
    return out;
  }
  return value;
}

/** {@link withoutNonFinite} for a properties object, warning once naming the keys. */
function finiteProperties(caller: string, properties: Record<string, unknown>): Record<string, unknown> {
  const dropped: string[] = [];
  const out = withoutNonFinite(properties, '', dropped) as Record<string, unknown>;
  if (dropped.length > 0) {
    warn(`${caller}() left out ${dropped.join(', ')}: NaN and Infinity are not valid values.`);
  }
  return out;
}

/**
 * A host callback that can never throw into the event dispatch (contract
 * items 34 and 56). React Native runs every listener of an event in one loop:
 * a callback that threw - a renderer meeting a message shape it did not
 * expect - was a fatal JS error in a release build and skipped every other
 * listener of the same event. A returned promise that rejects is caught too.
 */
function guardedCallback<T>(name: string, callback: (event: T) => unknown): (event: T) => void {
  const report = (err: unknown) => {
    // eslint-disable-next-line no-console
    console.warn(`[Joryio] your ${name} callback threw; the SDK carries on.`, err);
  };
  return (event: T) => {
    try {
      const result = callback(event);
      if (result !== null && typeof result === 'object' && typeof (result as Promise<unknown>).then === 'function') {
        (result as Promise<unknown>).then(undefined, report);
      }
    } catch (err) {
      report(err);
    }
  };
}

/**
 * An APNs device token: hex, 32 bytes or more. Joryio sends iOS push through
 * APNs, so an FCM registration token registered on iOS replaces the device's
 * working APNs token with one APNs refuses - and React Native Firebase's
 * onTokenRefresh hands the FCM token over at every app start on iOS.
 */
const APNS_TOKEN = /^(?:[0-9a-fA-F]{2}){32,100}$/;

/** The highest |rating| both native trackers can take: they hold it as a 32-bit Int. */
const MAX_RATING_MAGNITUDE = 2147483647;

// ─── SDK Class ───────────────────────────────────────────────────────────────

/**
 * How long a value-returning call waits for initialize() before giving up and
 * returning its documented "not available" value. See _awaitReady.
 */
const READY_TIMEOUT_MS = 5000;

/**
 * Most fire-and-forget calls held while initialize() has not completed. Beyond
 * it the OLDEST are dropped. The same cap and policy as every native SDK's
 * pre-initialization buffer (contract item 20), so a call is not kept by one
 * layer and dropped by the next. Before 1.3.0 the hold was unbounded: an app
 * that never called initialize() grew it for the life of the process.
 */
export const MAX_PRE_INIT_CALLS = 1000;

/**
 * What a held call is, which decides what a later privacy decision discards
 * and what a full hold drops first.
 *
 *  - `data`: collects something about the person (an event, an attribute, an
 *    alias, a subscribe). Discarded by an optOut, a denial and a wipe.
 *  - `identity`: identify(). Discarded by a wipe only. Under an opt-out or a
 *    denial native keeps the user id on the device, unsent, so that
 *    withdrawals carry the right person (contract v5 D-b).
 *  - `token`: setSdkAuthenticationToken(). Discarded by a wipe: replayed after
 *    it, the erased person's token was handed to the next visitor.
 *  - `control`: listeners, reset, flush, sync. Kept.
 *  - `withdrawal`: an unsubscribe, leaving a group, a push unregister. Kept
 *    through everything and delivered (contract v4 36).
 *  - `decision`: optOut, optIn, updateConsent, wipeData made while an
 *    initialize() is in flight. Kept.
 */
type CallKind = 'data' | 'identity' | 'token' | 'control' | 'withdrawal' | 'decision';

/**
 * A call held until initialize() succeeds. `tag` marks the two held calls
 * whose identity effect matters to ordering: a wipe (see
 * _handHeldDecisionsToNative) and a reset (see setSdkAuthenticationToken).
 */
interface HeldCall {
  fn: () => void;
  kind: CallKind;
  tag?: 'wipe' | 'reset';
  /**
   * A `data` call made before the decisions STORED by an earlier launch were
   * known: the decisions made in this process by then (null = none). Judged
   * against the stored ones once native has answered (see _settleStored).
   */
  madeUnder?: PrivacySnapshot;
  /**
   * A `data` call made while an initialize() was in flight and judged with
   * that init's config (contract v9 91): the decisions made in this process
   * by then. If that init fails, native never applied the config, so the
   * call is judged again without it (see _rejudgeWithoutInitConfig).
   */
  madeInWindow?: PrivacySnapshot;
}

/** The two privacy switches as decided in this process; null = not decided here. */
interface PrivacySnapshot {
  optedOut: boolean | null;
  denied: boolean | null;
}

/**
 * Longest wait for native's answer about the decisions stored by an earlier
 * launch before initialize() goes ahead without it. Native answers from
 * storage at once; this only guards against a bridge that never settles.
 */
const STORED_DECISIONS_TIMEOUT_MS = 3000;

/** A full pre-init hold drops the oldest of these first, in this order (contract v5 51). */
const EVICTION_ORDER: readonly CallKind[] = ['data', 'identity', 'token', 'control'];
const DISCARDED_BY_WITHDRAWN_CONSENT: readonly CallKind[] = ['data'];
const DISCARDED_BY_WIPE: readonly CallKind[] = ['data', 'identity', 'token'];

/**
 * Outcome of `registerPushToken`. Same four fields as the native
 * `PushRegistrationResult` on Android and iOS.
 */
export interface PushRegistrationResult {
  success: boolean;
  /** Provider or transport message on failure; absent on success. */
  message?: string;
  /** A bad or missing SDK key - retrying will not fix it. */
  isUnauthorized: boolean;
  /** Transient (offline, DNS, 5xx, not initialized yet): worth another try. */
  isRetryable: boolean;
}

class JoryioSDK {
  /**
   * Resolves once initialize() has completed. This is the SDK's readiness
   * primitive, and BOTH call shapes are built on it:
   *
   *  - fire-and-forget calls (track, identify, …) chain onto it, so they run
   *    after init instead of hitting an uninitialized native module;
   *  - value-returning calls (getAnonymousId, getUserId, …) AWAIT it, which a
   *    callback queue could never do — you cannot buffer something the caller
   *    is waiting on the answer to.
   *
   * That gap is what broke React Native in-app messaging: the queue covered the
   * void calls, so every getter called before init threw "Joryio SDK not
   * initialized" straight through to a red box.
   */
  private _ready: Promise<void>;
  private _markReady!: () => void;
  /** True once initialize() has completed SUCCESSFULLY. */
  private _initialized = false;
  /**
   * True when initialize() ran and FAILED. Distinct from "not yet initialized":
   * that one is temporary and worth waiting for, this one never resolves, so
   * every subsequent call must degrade instead of waiting or throwing.
   */
  private _initFailed = false;
  /**
   * Fire-and-forget calls made before initialize() succeeded, in call order,
   * each with its {@link CallKind}. An opt-out or a denial made later
   * discards the held `data` calls, and a wipe also the held `identity` and
   * `token` calls, exactly as the native SDKs discard what they hold. A
   * `withdrawal` is kept through all three and delivered (contract v4 36).
   */
  private _pending: Array<HeldCall> = [];
  /** The initialize() call in progress, if any. A second call joins it. */
  private _initInFlight: Promise<void> | null = null;
  private _warnedPendingOverflow = false;
  /**
   * A wipeData() was handed to native before its initialize(), which runs it
   * inside init. A token set after it must stay held here and follow init:
   * native would apply it before that wipe, which retires it.
   */
  private _wipeHandedToNative = false;
  /**
   * The two privacy switches as decided by calls made in this process
   * before initialize() succeeded (contract v7 73): set by optOut()/optIn()
   * and updateConsent('denied')/'granted' exactly as native records them -
   * 'pending' never reopens a denial. null = no decision made here yet.
   */
  private _preInitOptedOut: boolean | null = null;
  private _preInitDenied: boolean | null = null;
  /**
   * The two switches as the config of the initialize() IN FLIGHT sets them
   * (contract v9 91): `trackingConsent: 'granted'` lifts a stored denial and
   * 'denied' refuses; `optOut: true` refuses, `optOut: false` lifts nothing.
   * Native applies them when that init runs, so a call made meanwhile is
   * judged by them, between this process's decisions and the stored ones.
   * null = the config says nothing; both cleared when that init settles.
   */
  private _initConfigOptedOut: boolean | null = null;
  private _initConfigDenied: boolean | null = null;
  /**
   * The same two switches as STORED on the device by an earlier launch
   * (contract v8 83), read from native when this module loads - both natives
   * answer isUserOptedOut()/getTrackingConsent() from storage before their own
   * initialize() (contract item 44). null until native has answered.
   *
   * Without them, `track('x'); optIn(); initialize()` for a person whose
   * opt-out was stored last launch sent x: the call was held here, optIn went
   * to native straight away, and x reached native only after init, when the
   * opt-out was already lifted.
   */
  private _storedOptedOut: boolean | null = null;
  private _storedDenied: boolean | null = null;
  /** Settles once the stored decisions are known (or could not be read). */
  private _storedKnown: Promise<void> = Promise.resolve();
  private _warnedDroppedWhileOptedOut = false;
  /** Live onInAppMessage subscriptions. Rendering is handed to JS only while > 0. */
  private _inAppListeners = 0;
  /**
   * Rendering is handed to JS: an onInAppMessage listener or a direct
   * enableInAppMessages() is in force. Read when initialize() completes, to
   * decide whether the start-up hold ends with native drawing.
   */
  private _inAppHandedToJs = false;

  constructor() {
    this._ready = new Promise<void>((resolve) => {
      this._markReady = resolve;
    });
    if (isModuleAvailable) this._storedKnown = this._readStoredDecisions();
  }

  /**
   * Ask native, first thing, for the decisions an earlier launch stored. The
   * first call this module makes, so native answers before any decision made
   * in this process reaches it. Never rejects and never waits forever: an
   * unreadable answer counts as "nothing stored", which leaves native's own
   * judgement at replay - the behaviour before this read existed.
   */
  private async _readStoredDecisions(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Both asked synchronously, here in the constructor: native serves
      // calls in the order JS makes them, so these reads are answered before
      // any decision or initialize() made in this process reaches it.
      const asked = Promise.all([JoryioModule.isUserOptedOut?.(), JoryioModule.getTrackingConsent?.()]);
      const read = asked.then(([optedOut, consent]): [boolean, boolean] => [
        optedOut === true,
        parseConsent(consent) === 'denied',
      ]);
      const answer = await Promise.race([
        read,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), STORED_DECISIONS_TIMEOUT_MS);
          // Never keeps a host app's Jest run (or Node) alive on its own.
          (timer as { unref?: () => void }).unref?.();
        }),
      ]);
      if (answer === null) {
        // eslint-disable-next-line no-console
        console.warn('[Joryio] The stored privacy decisions could not be read in time; continuing without them.');
      }
      [this._storedOptedOut, this._storedDenied] = answer ?? [false, false];
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[Joryio] The stored privacy decisions could not be read.', e);
      this._storedOptedOut = false;
      this._storedDenied = false;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    this._settleStored();
  }

  /**
   * Whether collecting is refused before initialize(): a decision made in this
   * process wins over the stored one (it is later). 'unknown' while the stored
   * one is still being read and could make the answer yes.
   */
  private _refusedBeforeInit(at: PrivacySnapshot): boolean | 'unknown' {
    const optedOut = at.optedOut ?? this._storedOptedOut;
    const denied = at.denied ?? this._storedDenied;
    if (optedOut === true || denied === true) return true;
    if (optedOut === null || denied === null) return 'unknown';
    return false;
  }

  /**
   * Native has answered: drop the `data` calls held while its answer was
   * unknown that were made while refused, as they would have been dropped
   * at call time had the answer been there (contract v7 73).
   */
  private _settleStored(): void {
    const kept: HeldCall[] = [];
    let dropped = false;
    for (const call of this._pending) {
      if (call.madeUnder === undefined) {
        kept.push(call);
        continue;
      }
      if (this._refusedBeforeInit(call.madeUnder) === true) {
        dropped = true;
        continue;
      }
      delete call.madeUnder;
      kept.push(call);
    }
    this._pending = kept;
    if (dropped) this._warnDroppedWhileRefused();
  }

  /**
   * An initialize() failed, so native never applied its config: the `data`
   * calls judged with it while it was in flight are judged again by this
   * process's decisions and the stored ones alone (contract v9 91).
   */
  private _rejudgeWithoutInitConfig(): void {
    const kept: HeldCall[] = [];
    let dropped = false;
    for (const call of this._pending) {
      const at = call.madeInWindow;
      if (at !== undefined) {
        delete call.madeInWindow;
        const refused = this._refusedBeforeInit(at);
        if (refused === true) {
          dropped = true;
          continue;
        }
        if (refused === 'unknown') call.madeUnder = at;
      }
      kept.push(call);
    }
    this._pending = kept;
    if (dropped) this._warnDroppedWhileRefused();
  }

  private _warnDroppedWhileRefused(): void {
    if (this._warnedDroppedWhileOptedOut) return;
    this._warnedDroppedWhileOptedOut = true;
    // eslint-disable-next-line no-console
    console.warn(
      '[Joryio] A call that collects data was made while tracking is opted out or consent is ' +
        'denied; it is dropped and a later optIn() or grant does not send it.',
    );
  }

  /**
   * Wait for initialize(), but never forever.
   *
   * An unbounded await would be WORSE than the throw it replaces: a host app
   * that forgets initialize() (or whose init failed) would hang on the first
   * getter with no error to search for. On timeout the caller gets the same
   * "not available" value it already gets when the native module is missing,
   * plus a warning naming the actual cause.
   *
   * @returns true if the SDK became ready, false if it timed out.
   */
  private async _awaitReady(caller: string): Promise<boolean> {
    if (this._initialized) return true;
    if (this._initFailed) return false;
    const timedOut = Symbol('timeout');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      this._ready,
      new Promise<typeof timedOut>((resolve) => {
        timer = setTimeout(() => resolve(timedOut), READY_TIMEOUT_MS);
      }),
    ]);
    // Cleared either way: a timer left running after initialize() won the
    // race keeps a host app's Jest run alive ("worker failed to exit").
    if (timer !== undefined) clearTimeout(timer);
    if (result === timedOut) {
      // eslint-disable-next-line no-console
      console.warn(
        `[Joryio] ${caller}() was called but initialize() has not completed after ` +
          `${READY_TIMEOUT_MS}ms - returning a default. Call Joryio.initialize() at app start.`,
      );
      return false;
    }
    // Readiness settles on a FAILED initialize() too (it must, or every waiter
    // would hang). Settling is not success: answering true here sent a caller
    // that was waiting when init failed on to the native module, which was
    // never initialized - and a native promise that is never settled there
    // (registerPushToken's completion, for one) hung the caller forever.
    return this._initialized && !this._initFailed;
  }

  /**
   * A privacy getter (isUserOptedOut, getTrackingConsent). Both native SDKs
   * answer these from STORED state before their own initialize() (contract
   * item 44), so before initialize() has been called - or after one that
   * failed - native is asked straight away. They used to wait up to five
   * seconds for an initialize() that might never come and then answer
   * `false` / `null`, which reads as "not opted out" for a person whose
   * opt-out is stored on the device.
   *
   * While an initialize() is in flight the answer waits for it, because a
   * decision made in that window is queued behind it and native would not
   * know it yet. Native is asked whatever the outcome (contract v6 65): when
   * that init FAILS, the decisions held meanwhile have just been handed to
   * native (_handHeldDecisionsToNative), so its stored answer is current. It
   * used to answer the default `false` / `null` then without asking native.
   */
  private async _queryDecision<T>(caller: string, fallback: T, fn: () => Promise<T>): Promise<T> {
    if (!isModuleAvailable) return fallback;
    if (this._initInFlight !== null && !this._initialized) await this._awaitReady(caller);
    try {
      const value = await fn();
      return value ?? fallback;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[Joryio] ${caller}() failed`, e);
      return fallback;
    }
  }

  /**
   * Route a fire-and-forget native call safely:
   *  - no-op when the native module isn't linked,
   *  - defer until initialize() resolves so we never hit native before init,
   *  - swallow (and warn) native errors so a bad call can't crash the host app.
   */
  private _dispatch(fn: () => void, kind: CallKind = 'control', tag?: HeldCall['tag']): void {
    if (!isModuleAvailable) return;
    if (this._initialized) {
      this._invoke(fn);
      return;
    }
    // Not ready yet - or initialize() FAILED: hold the call, in order, for the
    // initialize() that succeeds. A failed init used to DROP every call made
    // after it and discard everything held before it, so an app whose first
    // initialize() failed (a wrong key from a remote config) and whose retry
    // worked had lost its onInAppMessage hand-off (native kept drawing and JS
    // never received a message), its SDK-auth error listener and every
    // unsubscribe made meanwhile. Both native SDKs keep what they hold for
    // an initialize() that succeeds; this does the same.
    //
    // Except a data call made while opted out or denied (contract v7 73) -
    // by a decision made in this process or one an earlier launch stored
    // (contract v8 83): dropped now, so a later optIn()/grant never sends
    // it. Identity, tokens, control calls, withdrawals and decisions are kept
    // (D-b keeps a held identify for the withdrawals). While the stored
    // decisions are still being read, the call is held with the decisions
    // made so far and judged when native answers (_settleStored), before any
    // initialize() replays it.
    let madeUnder: PrivacySnapshot | undefined;
    let madeInWindow: PrivacySnapshot | undefined;
    if (kind === 'data') {
      // In-process decision, else the in-flight init's config, else stored.
      const at: PrivacySnapshot = {
        optedOut: this._preInitOptedOut ?? this._initConfigOptedOut,
        denied: this._preInitDenied ?? this._initConfigDenied,
      };
      const refused = this._refusedBeforeInit(at);
      if (refused === true) {
        this._warnDroppedWhileRefused();
        return;
      }
      if (refused === 'unknown') madeUnder = at;
      if (this._initConfigOptedOut !== null || this._initConfigDenied !== null) {
        madeInWindow = { optedOut: this._preInitOptedOut, denied: this._preInitDenied };
      }
    }
    if (this._pending.length >= MAX_PRE_INIT_CALLS) {
      this._evictOneHeld();
      if (!this._warnedPendingOverflow) {
        this._warnedPendingOverflow = true;
        // eslint-disable-next-line no-console
        console.warn(
          `[Joryio] More than ${MAX_PRE_INIT_CALLS} calls were made before initialize() ` +
            'succeeded; the oldest are being dropped (withdrawals and privacy decisions last). ' +
            'Call Joryio.initialize() at app start.',
        );
      }
    }
    const call: HeldCall = { fn, kind };
    if (tag) call.tag = tag;
    if (madeUnder) call.madeUnder = madeUnder;
    if (madeInWindow) call.madeInWindow = madeInWindow;
    this._pending.push(call);
  }

  /**
   * Make room in a full pre-init hold (contract v5 51): the oldest call of the
   * first kind present in EVICTION_ORDER goes. An unsubscribe, a push
   * unregister or a privacy decision is dropped only when the hold holds
   * nothing else. It used to drop the oldest call whatever it was, so an
   * unsubscribe followed by a thousand track() calls lost the unsubscribe.
   */
  private _evictOneHeld(): void {
    for (const kind of EVICTION_ORDER) {
      const i = this._pending.findIndex((call) => call.kind === kind);
      if (i >= 0) {
        this._pending.splice(i, 1);
        return;
      }
    }
    this._pending.shift();
  }

  /**
   * A privacy decision - optOut, optIn, updateConsent, wipeData.
   *
   * Made BEFORE initialize() (contract item 25), it goes to the native module
   * straight away instead of waiting in the queue above. Both native SDKs
   * record a decision made before their own initialize() and apply it INSIDE
   * it, ahead of the Session Start, the in-app sync and the push
   * re-registration. Queued here, it reached native only after all three had
   * run - so an app that called optOut() before initialize() still sent a
   * Session Start for someone who had said no, and then a `tracking_opted_out`
   * marker for a person who had never consented to anything.
   *
   * The native module processes calls in the order JS makes them, so the
   * decision is recorded before the initialize() that follows it.
   *
   * @param discards the kinds of held call the decision drops instead of
   *   replaying after it: `data` for an opt-out or a denial, and also
   *   `identity` and `token` for a wipe. Nothing for optIn or a grant.
   */
  private _decide(fn: () => void, discards: readonly CallKind[]): void {
    if (!isModuleAvailable) return;
    if (discards.length > 0) this._discardHeld(discards);
    if (!this._initialized && this._initInFlight === null) {
      // A wipe erases the identity the withdrawals held here were made under.
      // They go to native first, so native buffers them AHEAD of the wipe and
      // runs them under that identity before erasing it (Unity scan 5, N4).
      // Held here, they replayed after native's init had already wiped, under
      // the new anonymous id - a profile that never received anything.
      if (discards === DISCARDED_BY_WIPE) {
        this._sendHeldWithdrawalsNow();
        this._wipeHandedToNative = true;
      }
      // Not started (or a failed start): native records it for its next init.
      this._invoke(fn);
      return;
    }
    // initialize() already called: the decision comes after it, in order.
    // If that initialize() fails, _handHeldDecisionsToNative passes it on.
    this._dispatch(fn, 'decision', discards === DISCARDED_BY_WIPE ? 'wipe' : undefined);
  }

  /**
   * After a FAILED initialize(), hand the privacy decisions held while it was
   * in flight to native now, in call order (contract v6 65). Nothing is in
   * flight any more, so they take the pre-init path of _decide: native
   * records each for its next initialize() and applies it ahead of that
   * init's Session Start, in-app sync and push registration.
   *
   * Left held, they replayed only after the RETRY's initialize() and its side
   * effects - a person who declined while the first init was failing got a
   * Session Start - and after any decision made since the failure, which goes
   * to native directly: an optIn() held from the failing window overrode a
   * later optOut(), so the person ended opted in.
   *
   * Withdrawals go too, in place, while nothing but decisions and
   * withdrawals precede them. One held behind a data, identity or control
   * call stays held with it: handed ahead of an earlier subscribe for the
   * same channel, the subscribe would replay later and supersede it; ahead of
   * an identify, it would be filed under the wrong person. A wipe takes the
   * withdrawals held before it along first, as _decide does, so native runs
   * them under the identity being erased.
   */
  private _handHeldDecisionsToNative(): void {
    const held = this._pending;
    this._pending = [];
    let onlyPrivacyCallsSoFar = true;
    for (const call of held) {
      if (call.kind === 'decision') {
        if (call.tag === 'wipe') {
          this._sendHeldWithdrawalsNow();
          this._wipeHandedToNative = true;
        }
        this._invoke(call.fn);
      } else if (call.kind === 'withdrawal' && onlyPrivacyCallsSoFar) {
        this._invoke(call.fn);
      } else {
        if (call.kind !== 'withdrawal') onlyPrivacyCallsSoFar = false;
        this._pending.push(call);
      }
    }
  }

  /** Hand the held withdrawals to native now, in order; keep the rest held. */
  private _sendHeldWithdrawalsNow(): void {
    const withdrawals = this._pending.filter((call) => call.kind === 'withdrawal');
    this._pending = this._pending.filter((call) => call.kind !== 'withdrawal');
    withdrawals.forEach((call) => this._invoke(call.fn));
  }

  /** Drop the held calls of these kinds; keep the rest, in order. */
  private _discardHeld(kinds: readonly CallKind[]): void {
    this._pending = this._pending.filter((call) => !kinds.includes(call.kind));
  }

  private _invoke(fn: () => void): void {
    try {
      fn();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[Joryio] native call failed', e);
    }
  }

  /**
   * Replay the calls held before a SUCCESSFUL init. After a failed one they
   * stay held for the next initialize() (see _dispatch).
   */
  private _drainPending(): void {
    if (this._initFailed) return;
    const held = this._pending;
    this._pending = [];
    held.forEach((call) => this._invoke(call.fn));
  }

  /**
   * Value-returning native call, gated on readiness, that never throws into
   * the host app: a missing module, an init that never completed and a native
   * rejection all answer `fallback`.
   */
  private async _query<T>(caller: string, fallback: T, fn: () => Promise<T>): Promise<T> {
    if (!isModuleAvailable) return fallback;
    if (!(await this._awaitReady(caller))) return fallback;
    try {
      const value = await fn();
      return value ?? fallback;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[Joryio] ${caller}() failed`, e);
      return fallback;
    }
  }

  /**
   * Initialize the SDK. Must be called before any other method.
   *
   * @example
   * ```ts
   * import Joryio from '@joryio/react-native-sdk';
   *
   * // Each platform has its own key: iOS keys start with jry_sdk_ios_,
   * // Android keys with jry_sdk_android_. The other platform's key is refused.
   * const sdkKey = Platform.select({
   *   ios: 'jry_sdk_ios_abc123',
   *   android: 'jry_sdk_android_def456',
   * })!;
   * Joryio.initialize(sdkKey, 'api-eu1.joryio.com', {
   *   enableDebug: __DEV__,
   *   trackSessionStart: true,
   * });
   * ```
   */
  async initialize(
    sdkKey: string,
    apiHost: string,
    config: JoryioConfig = {},
  ): Promise<void> {
    if (!isModuleAvailable) {
      // eslint-disable-next-line no-console
      console.warn(`${MODULE_MISSING_MESSAGE} initialize() is a no-op.`);
      return;
    }
    // A missing key or host cannot start anything, but it must not switch the
    // SDK off either: nothing is marked failed, so a later initialize() with
    // real values still works and the calls held meanwhile are replayed.
    if (!requireString('initialize', 'sdkKey', sdkKey)) return;
    if (!requireString('initialize', 'apiHost', apiHost)) return;
    // Two overlapping calls - React StrictMode runs effects twice - share one
    // native initialize(). The second used to run its own: the first resolved
    // and set `_initialized`, the second rejected and set `_initFailed`, and
    // `_dispatch` then dropped every call of a working SDK.
    if (this._initInFlight) return this._initInFlight;
    this._initInFlight = this._initialize(sdkKey, apiHost, config);
    try {
      await this._initInFlight;
    } finally {
      this._initInFlight = null;
    }
  }

  private async _initialize(sdkKey: string, apiHost: string, config: JoryioConfig): Promise<void> {
    if (this._initFailed) {
      // A retry after a failed initialize(). The failure used to be permanent
      // for the life of the JS context: `_initFailed` was never cleared, so
      // even a successful second initialize() left every call dropped.
      // Readiness is re-armed, so calls made from here on are held and
      // replayed again instead of being discarded.
      this._initFailed = false;
      this._ready = new Promise<void>((resolve) => {
        this._markReady = resolve;
      });
    }
    let failure: { error: unknown } | null = null;
    let releaseInAppHold = false;
    const forNative = nativeConfig(config);
    // The first sync can finish before the onInAppMessage subscription
    // reaches native - that subscription is held here until initialize()
    // completes - and native then drew the one message the app meant to draw
    // itself (found testing 1.3.1-beta.2 on Android; the same window exists
    // on iOS). So native ALWAYS starts holding in-app messages, and the hold
    // ends once initialize() has completed and the held calls have run:
    // with the app's listener (its enableInAppMessages takes the held
    // message), or with nobody listening (disableInAppMessages below, and
    // native draws it). `holdInAppMessagesForHandler: true` from the app
    // keeps the hold until its listener subscribes, however late.
    const appHoldsForHandler = forNative.holdInAppMessagesForHandler === true;
    forNative.holdInAppMessagesForHandler = true;
    if (!this._initialized) {
      // Calls made while this init is in flight are judged with its config
      // (contract v9 91): native applies it before replaying them.
      if (forNative.trackingConsent === 'granted') this._initConfigDenied = false;
      if (forNative.trackingConsent === 'denied') this._initConfigDenied = true;
      if (forNative.optOut === true) this._initConfigOptedOut = true;
    }
    try {
      await JoryioModule.initialize(sdkKey, apiHost, forNative);
    } catch (e) {
      failure = { error: e };
    }
    try {
      // The held data calls are judged against the decisions stored by an
      // earlier launch before anything is replayed or sent straight through
      // (contract v8 83). Native was asked for them first thing, ahead of
      // this initialize(), so they are normally known by now; the read never
      // rejects and is bounded.
      await this._storedKnown;
      this._initConfigOptedOut = null;
      this._initConfigDenied = null;
      if (failure === null) {
        this._pending.forEach((call) => delete call.madeInWindow);
        releaseInAppHold = !appHoldsForHandler;
        this._initialized = true;
        this._wipeHandedToNative = false;
        return;
      }
      if (this._initialized) {
        // A later initialize() on an SDK that is already running. Native
        // keeps the running instance, so this is not a failure of the SDK.
        // eslint-disable-next-line no-console
        console.warn('[Joryio] initialize() was called again and ignored; the SDK keeps running.', failure.error);
        return;
      }
      // Record the failure rather than rethrowing into the host app's startup.
      // Everything downstream then degrades to a no-op with one clear warning,
      // instead of each call throwing its own "SDK not initialized".
      this._initFailed = true;
      this._rejudgeWithoutInitConfig();
      this._handHeldDecisionsToNative();
      // eslint-disable-next-line no-console
      console.warn(
        '[Joryio] initialize() failed; calls are held (at most ' +
          `${MAX_PRE_INIT_CALLS}) and sent once a later initialize() succeeds. ` +
          'Calling it again with corrected values is allowed.',
        failure.error,
      );
    } finally {
      // Settle READINESS even when native init THREW. Leaving it unresolved
      // would hang every deferred call and every getter for the life of the
      // process — a failed init must degrade, not deadlock. `_initFailed` is
      // what makes that degradation quiet: fire-and-forget calls stay held
      // for the next initialize() and getters return defaults, rather than
      // each throwing its own red box.
      this._markReady();
      this._drainPending();
      // After the held calls, so a subscription made before initialize()
      // completed has already taken the held message.
      if (releaseInAppHold && !this._inAppHandedToJs) {
        this._dispatch(() => JoryioModule.disableInAppMessages());
      }
    }
  }

  // ─── Event Tracking ──────────────────────────────────────────────────────

  /**
   * Track a custom event.
   *
   * @example
   * ```ts
   * Joryio.track('Tutorial Completed', { step: 4 });
   *
   * // For e-commerce, prefer the typed surface - it applies the platform's
   * // canonical event names and property keys for you. A hand-typed name that
   * // is close but not exact is stored verbatim and matches no report, because
   * // there is deliberately no alias layer:
   * Joryio.ecommerce.addToCart({ productId: '123', name: 'Buds', price: 29.99, quantity: 1 });
   * ```
   */
  track(eventName: string, properties: Record<string, unknown> = {}): void {
    if (!requireString('track', 'eventName', eventName)) return;
    const props = finiteProperties('track', plainObject(properties));
    this._dispatch(() => JoryioModule.track(eventName, props), 'data');
  }

  /**
   * Track a screen view.
   *
   * @example
   * ```ts
   * Joryio.trackScreen('ProductDetail', { productId: '123' });
   * ```
   */
  trackScreen(
    screenName: string,
    properties: Record<string, unknown> = {},
  ): void {
    if (!requireString('trackScreen', 'screenName', screenName)) return;
    const props = finiteProperties('trackScreen', plainObject(properties));
    this._dispatch(() => JoryioModule.trackScreen(screenName, props), 'data');
  }

  // ─── User Identity ───────────────────────────────────────────────────────

  /**
   * Identify the current user by their user ID.
   * Call this after login or when you know who the user is.
   *
   * @example
   * ```ts
   * Joryio.identify('user-123');
   * ```
   */
  identify(userId: string): void {
    if (!requireString('identify', 'userId', userId)) return;
    this._dispatch(() => JoryioModule.identify(userId), 'identity');
  }

  /**
   * Attach a labelled alias to the current person - an id from another system,
   * such as `addAlias('crm_id', 'C-1042')`. Works for anonymous visitors as
   * well as identified users: the alias is stored against the anonymous id and
   * travels with it when the visitor is identified later.
   *
   * There is no unlabelled `alias(userId)`; to name the current person, call
   * {@link identify}.
   *
   * @param aliasLabel what kind of id this is, e.g. `crm_id`
   * @param aliasName  the id itself
   */
  addAlias(aliasLabel: string, aliasName: string): void {
    if (!requireString('addAlias', 'aliasLabel', aliasLabel)) return;
    if (!requireString('addAlias', 'aliasName', aliasName)) return;
    this._dispatch(() => JoryioModule.addAlias(aliasLabel, aliasName), 'data');
  }

  /**
   * Reset the user identity. Call this on logout.
   * Clears user ID, starts new anonymous session, clears in-app messages.
   */
  reset(): void {
    this._dispatch(() => JoryioModule.reset(), 'control', 'reset');
  }

  // ─── Tracking consent ────────────────────────────────────────────────────

  /**
   * Stop collecting and sending. Call when a user declines tracking.
   *
   * TRACKING consent, not marketing subscription - this does not unsubscribe
   * anyone from email or SMS. Those live on the contact's subscription state
   * and are changed through the API or the preference centre.
   *
   * Existed on web, Android, iOS and Unity; React Native had no consent surface
   * at all, so an app built on it could not honour a "do not track" choice
   * through the SDK. The native SDKs record `tracking_opted_out` on the profile
   * as part of opting out, so that behaviour comes through this bridge
   * unchanged - nothing about the wire is decided here.
   *
   * Stored on the device: it holds across restarts until {@link optIn}.
   * Independent of tracking consent - `updateConsent('granted')` does not
   * cancel it.
   *
   * Safe before initialize(), and applied FIRST: the SDK then starts opted out,
   * with no Session Start, in-app sync or push registration in between. Calls
   * that collect data made before it, or after it until {@link optIn}, are
   * dropped: a later optIn() does not send them.
   */
  optOut(): void {
    this._preInitOptedOut = true;
    this._decide(() => JoryioModule.optOut(), DISCARDED_BY_WITHDRAWN_CONSENT);
  }

  /**
   * Resume collecting and sending after {@link optOut}. The only call that
   * lifts an opt-out. It does not change tracking consent: with consent
   * `'denied'` or `'pending'` nothing is sent until consent is granted too.
   * Safe before initialize(), and applied before the SDK starts. Calls that
   * collect data made before it while an opt-out was in force - one made in
   * this launch or one stored by an earlier launch - are not sent by it.
   */
  optIn(): void {
    this._preInitOptedOut = false;
    this._decide(() => JoryioModule.optIn(), []);
  }

  /**
   * Erase everything this device holds for the current person - identity,
   * queued events, pending writes, in-app state, session, device id and push
   * token - and unregister the token on the server. The opt-out is KEPT, so a
   * person who opted out and asked for erasure stays opted out. Push stays
   * unregistered until {@link registerPushToken} or a permission grant.
   *
   * Safe before initialize(), and applied before the SDK starts: nothing is
   * sent under the erased identity first. Calls made before it that collect
   * data are dropped, since the wipe would erase them anyway.
   */
  wipeData(): void {
    this._decide(() => JoryioModule.wipeData(), DISCARDED_BY_WIPE);
  }

  /**
   * Whether the user has opted out of tracking - the opt-out switch only
   * ({@link optOut} / {@link optIn}). Consent is a separate switch; read it
   * with {@link getTrackingConsent}.
   *
   * Safe before initialize(): the answer then comes from what is stored on the
   * device, so an opt-out from an earlier launch reads as `true` straight
   * away. While initialize() is running it waits for it, and then asks native
   * whether that initialize() succeeded or failed. Answers `false` when the
   * native module is not linked or the native read fails.
   */
  isUserOptedOut(): Promise<boolean> {
    return this._queryDecision('isUserOptedOut', false, () => {
      return JoryioModule.isUserOptedOut();
    });
  }

  /**
   * Change tracking consent - typically when the user answers your consent
   * banner, for example after you initialized with `trackingConsent: 'pending'`.
   *
   *  - `'granted'` releases everything held while consent was pending and
   *    starts normal collection. It lifts a stored `'denied'`, but never an
   *    opt-out: only {@link optIn} does that.
   *  - `'denied'` discards what was held and collects nothing more - calls
   *    made while denied are dropped, and a later `'granted'` does not send
   *    them. Stored, so it holds on later launches until `'granted'`.
   *  - `'pending'` holds data on the device and sends nothing, for this launch
   *    only. It never replaces a stored `'denied'`.
   *
   * It does not opt the user out and {@link isUserOptedOut} does not change.
   * Safe before initialize(), and applied before the SDK starts.
   */
  updateConsent(consent: TrackingConsent): void {
    const parsed = parseConsent(consent);
    if (parsed === null) {
      warn(`updateConsent() takes 'granted', 'denied' or 'pending', not '${String(consent)}'; ignored.`);
      return;
    }
    if (parsed === 'denied') this._preInitDenied = true;
    if (parsed === 'granted') this._preInitDenied = false;
    const discards = parsed === 'denied' ? DISCARDED_BY_WITHDRAWN_CONSENT : [];
    this._decide(() => JoryioModule.updateConsent(parsed), discards);
  }

  /**
   * The current tracking consent: `'granted'`, `'denied'` or `'pending'`.
   * Separate from the opt-out, which {@link isUserOptedOut} reports.
   *
   * Safe before initialize(): the answer then comes from what is stored on the
   * device (a stored `'denied'` reads as `'denied'`) and from any decision
   * made earlier in this launch; with nothing decided and nothing stored it
   * is `'granted'`, the state the SDK runs in, on both platforms. While
   * initialize() is running it waits for it, and then asks native whether
   * that initialize() succeeded or failed. Native's answer is passed through
   * as it is. Answers `null` only when the native module is not linked or the
   * native call fails.
   */
  getTrackingConsent(): Promise<TrackingConsent | null> {
    return this._queryDecision<TrackingConsent | null>('getTrackingConsent', null, async () => {
      const raw = await JoryioModule.getTrackingConsent?.();
      return parseConsent(raw);
    });
  }

  // ─── Marketing subscription ──────────────────────────────────────────────

  /**
   * Set the marketing subscription status for one channel.
   *
   * A DIFFERENT consent from {@link optOut}: that controls whether we may
   * OBSERVE this person, this controls whether we may MESSAGE them. Neither
   * implies the other - somebody can decline tracking and still want the
   * newsletter.
   *
   * This is what an in-app preference centre writes. It existed on web only,
   * so a mobile user had to find an email and click its unsubscribe link -
   * unsubscribing being harder in the app than on the web, which is the wrong
   * way round for the one action that must always be easy.
   *
   * @param channel one of email, sms, whatsapp, push, viber
   * @param status  one of optedIn, subscribed, unsubscribed
   */
  setSubscription(channel: SubscriptionChannel, status: SubscriptionStatus): void {
    if (!requireString('setSubscription', 'channel', channel)) return;
    if (!requireString('setSubscription', 'status', status)) return;
    // An unsubscribe is a withdrawal: a pre-init optOut, denial or wipe never
    // discards it (contract v4 36).
    const kind = status === 'unsubscribed' ? 'withdrawal' : 'data';
    this._dispatch(() => JoryioModule.setSubscription(channel, status), kind);
  }

  /** Join a subscription group (list) on a channel. */
  addToSubscriptionGroup(groupId: string, channel: SubscriptionChannel): void {
    if (!requireString('addToSubscriptionGroup', 'groupId', groupId)) return;
    if (!requireString('addToSubscriptionGroup', 'channel', channel)) return;
    this._dispatch(() => JoryioModule.addToSubscriptionGroup(groupId, channel), 'data');
  }

  /** Leave a subscription group (list) on a channel. */
  removeFromSubscriptionGroup(groupId: string, channel: SubscriptionChannel): void {
    if (!requireString('removeFromSubscriptionGroup', 'groupId', groupId)) return;
    if (!requireString('removeFromSubscriptionGroup', 'channel', channel)) return;
    this._dispatch(() => JoryioModule.removeFromSubscriptionGroup(groupId, channel), 'withdrawal');
  }

  // ─── User Attributes ─────────────────────────────────────────────────────

  /**
   * Set multiple user attributes at once.
   *
   * @example
   * ```ts
   * Joryio.setAttributes({
   *   firstName: 'John',
   *   plan: 'premium',
   *   age: 28,
   * });
   * ```
   */
  setAttributes(attributes: UserAttributes): void {
    // `null` means UNSET, on both platforms. Split here so the two bridges
    // receive the same thing; they also treat a null as an unset themselves.
    // Android used to crash the app on a null value (a NullPointerException
    // casting it to Any), and iOS forwarded it as NSNull.
    if (attributes === null || typeof attributes !== 'object' || Array.isArray(attributes)) {
      warn('setAttributes() needs an object of attributes; ignored.');
      return;
    }
    const values: Record<string, string | number | boolean> = {};
    const unset: string[] = [];
    const nonFinite: string[] = [];
    for (const [key, value] of Object.entries(attributes)) {
      if (value === null || value === undefined) unset.push(key);
      else if (isNonFiniteNumber(value)) nonFinite.push(key);
      else values[key] = value;
    }
    // Left out, not unset: a NaN is a mistake, not a request to erase.
    if (nonFinite.length > 0) {
      warn(`setAttributes() left out ${nonFinite.join(', ')}: NaN and Infinity are not valid values.`);
    }
    if (Object.keys(values).length > 0) {
      this._dispatch(() => JoryioModule.setAttributes(values), 'data');
    }
    unset.forEach((key) => this._dispatch(() => JoryioModule.unsetAttribute(key), 'data'));
  }

  /**
   * Set a single user attribute. `null` unsets it.
   */
  setAttribute(key: string, value: string | number | boolean | null): void {
    if (!requireString('setAttribute', 'key', key)) return;
    if (value === null || value === undefined) {
      this._dispatch(() => JoryioModule.unsetAttribute(key), 'data');
      return;
    }
    if (isNonFiniteNumber(value)) {
      // Over the bridge a NaN arrives as null - an UNSET of the stored value.
      warn(`setAttribute('${key}') needs a finite number, not ${String(value)}; ignored.`);
      return;
    }
    this._dispatch(() => JoryioModule.setAttribute(key, value), 'data');
  }

  /**
   * Increment a numeric user attribute.
   *
   * @example
   * ```ts
   * Joryio.incrementAttribute('loginCount', 1);
   * ```
   */
  incrementAttribute(key: string, by: number = 1): void {
    if (!requireString('incrementAttribute', 'key', key)) return;
    // null means the default step, like an omitted argument.
    const step = by === null || by === undefined ? 1 : by;
    if (typeof step !== 'number' || !Number.isFinite(step)) {
      warn(`incrementAttribute('${key}') needs a finite number to add; ignored.`);
      return;
    }
    this._dispatch(() => JoryioModule.incrementAttribute(key, step), 'data');
  }

  /**
   * Remove a user attribute.
   */
  unsetAttribute(key: string): void {
    if (!requireString('unsetAttribute', 'key', key)) return;
    this._dispatch(() => JoryioModule.unsetAttribute(key), 'data');
  }

  // ─── Push Notifications ──────────────────────────────────────────────────

  /**
   * Register a push notification token (FCM on Android, APNs on iOS).
   * Typically called after receiving the token from Firebase or Apple.
   *
   * Resolves with the registration outcome - it never rejects, so a caller
   * that ignores the promise gets exactly the previous fire-and-forget
   * behaviour. Before 1.3.0 the bridge dropped the native result: a
   * device-side DNS blip left the device unregistered for push with no
   * signal and nothing to retry (Teamder, 2026-09-29). `isRetryable` says
   * whether trying again is worth it; `isUnauthorized` says the SDK key is
   * wrong and a retry will not help.
   *
   * On iOS register the APNs device token, never the FCM one: Joryio sends
   * iOS push through APNs. A token that is not an APNs token (hex) is refused
   * on iOS with `isRetryable: false`; registered, it would replace the
   * device's working APNs token with one APNs rejects.
   *
   * @example
   * ```ts
   * // With @react-native-firebase/messaging
   * const token = Platform.OS === 'ios'
   *   ? await messaging().getAPNSToken() // APNs device token (hex)
   *   : await messaging().getToken();    // FCM token
   * if (token) {
   *   const result = await Joryio.registerPushToken(token);
   *   if (!result.success && result.isRetryable) {
   *     // transient (offline, DNS, 5xx): register again when the network is back
   *   }
   * }
   *
   * // onTokenRefresh delivers the FCM token - on iOS too, at every app start.
   * // Register it on Android only.
   * messaging().onTokenRefresh((fcmToken) => {
   *   if (Platform.OS === 'android') Joryio.registerPushToken(fcmToken);
   * });
   * ```
   */
  async registerPushToken(token: string): Promise<PushRegistrationResult> {
    if (!isModuleAvailable) {
      return {success: false, message: 'Joryio native module is not linked', isUnauthorized: false, isRetryable: false};
    }
    // Trimmed first, like both native SDKs (contract v6 69): a token read
    // with a trailing newline was refused on iOS as "not an APNs token" here
    // while native would have trimmed and registered it.
    token = typeof token === 'string' ? token.trim() : token;
    if (!requireString('registerPushToken', 'token', token)) {
      return {success: false, message: 'A push token is required', isUnauthorized: false, isRetryable: false};
    }
    if (Platform?.OS === 'ios' && !APNS_TOKEN.test(token)) {
      const message =
        'On iOS registerPushToken() needs the APNs device token (hex), from ' +
        'messaging().getAPNSToken() - this looks like an FCM token. Not registered.';
      warn(message);
      return {success: false, message, isUnauthorized: false, isRetryable: false};
    }
    if (!(await this._awaitReady('registerPushToken'))) {
      // The token was not sent. Retryable only when initialize() is merely
      // late - calling again after it resolves works. After a FAILED
      // initialize() a plain retry cannot work: the token has to be registered
      // again once a later initialize() succeeds, so `isRetryable` is false
      // (contract item 48) - retrying in a backoff loop would spin.
      return this._initFailed
        ? {success: false, message: 'SDK initialization failed', isUnauthorized: false, isRetryable: false}
        : {success: false, message: 'SDK not initialized', isUnauthorized: false, isRetryable: true};
    }
    try {
      const r = await JoryioModule.registerPushToken(token);
      return {
        success: !!r?.success,
        message: r?.message ?? undefined,
        isUnauthorized: !!r?.isUnauthorized,
        isRetryable: !!r?.isRetryable,
      };
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[Joryio] native call failed', e);
      return {success: false, message: String((e as Error)?.message ?? e), isUnauthorized: false, isRetryable: true};
    }
  }

  /**
   * Report that a push ARRIVED on this device.
   *
   * Needed because most React Native apps run their OWN messaging service -
   * @react-native-firebase/messaging, Expo notifications - so a push never
   * passes through our native service and would report no delivery at all.
   * The same apps already call `registerPushToken`; this is the matching half.
   *
   * ```ts
   * messaging().onMessage(async (msg) => {
   *   if (msg.data?.trackingId) Joryio.reportPushDelivered(msg.data.trackingId);
   * });
   * messaging().setBackgroundMessageHandler(async (msg) => {
   *   if (msg.data?.trackingId) Joryio.reportPushDelivered(msg.data.trackingId);
   * });
   * ```
   *
   * @param trackingId the `trackingId` from the message's data payload.
   */
  reportPushDelivered(trackingId: string): void {
    if (!requireString('reportPushDelivered', 'trackingId', trackingId)) return;
    this._dispatch(() => JoryioModule.reportPushDelivered(trackingId), 'data');
  }

  /**
   * Unregister from push notifications.
   */
  unregisterPush(): void {
    // A withdrawal (contract v4 36): held before initialize() through an
    // optOut, a denial or a wipe, and the last thing a full hold drops.
    this._dispatch(() => JoryioModule.unregisterPush(), 'withdrawal');
  }

  /**
   * Where the user stands on notifications, without asking them anything.
   *
   * Check this BEFORE showing a primer: `notDetermined` is the ONLY state in
   * which the system prompt can still appear. Push permission is one-shot on
   * iOS and Android 13+ - a denial is recoverable only in system Settings - so a
   * primer shown to an already-denied user spends their goodwill on a prompt
   * that can never be displayed.
   */
  async getPushPermissionStatus(): Promise<PushPermissionStatus> {
    return this._query<PushPermissionStatus>('getPushPermissionStatus', 'unavailable', () => {
      return JoryioModule.getPushPermissionStatus();
    });
  }

  /**
   * Show the system notification prompt, resolving the resulting status.
   *
   * The SDK never calls this for you. The prompt can only be shown once, and
   * neither `initialize()` nor a dashboard toggle can know when your app has
   * earned the right to ask - so the moment is yours. Ask after a booking, a
   * purchase, or from a notification settings screen; not on first launch.
   *
   * ```ts
   * if ((await Joryio.getPushPermissionStatus()) === 'notDetermined') {
   *   // show your own primer first, then:
   *   const status = await Joryio.requestPushPermission();
   * }
   * ```
   *
   * On Android this covers the API 33+ POST_NOTIFICATIONS runtime permission and
   * registers the FCM token on a grant. Below API 33 nothing is shown and the
   * current Settings state is reported.
   *
   * The same on both platforms when the user has opted out of tracking: the
   * prompt is still shown (whether the app may NOTIFY is the user's choice in
   * the OS, not a tracking decision) and the resulting status is resolved, but
   * nothing is registered or reported to Joryio while opted out. iOS used to
   * skip the prompt and answer `notDetermined`, so a primer asked forever.
   *
   * Always settles. If Android recreates the Activity while the prompt is up
   * (a rotation, a theme change), the answer is lost with it; the promise then
   * resolves with the status as it stands once the app is back in front.
   */
  async requestPushPermission(): Promise<PushPermissionStatus> {
    return this._query<PushPermissionStatus>('requestPushPermission', 'unavailable', () => {
      return JoryioModule.requestPushPermission();
    });
  }

  /**
   * Check if push notifications are enabled.
   */
  async isPushEnabled(): Promise<boolean> {
    return this._query('isPushEnabled', false, () => {
      return JoryioModule.isPushEnabled();
    });
  }

  /**
   * Track a push notification click (for analytics).
   * Call this when the user taps a push notification.
   */
  trackPushClick(trackingId: string): void {
    if (!requireString('trackPushClick', 'trackingId', trackingId)) return;
    this._dispatch(() => JoryioModule.trackPushClick(trackingId), 'data');
  }

  // ─── In-App Messaging ────────────────────────────────────────────────────

  /**
   * Listen for in-app messages that are ready to display.
   * Returns an unsubscribe function.
   *
   * Subscribing OVERRIDES the SDK's own rendering: you draw the message, and
   * therefore YOU MUST REPORT what happened via {@link trackInAppImpression}.
   * The SDK cannot see a message it did not draw. Handing a message to you
   * neither emits `in_app.displayed` nor spends the campaign's frequency
   * budget: both happen when you report `'displayed'`, once, as the message
   * appears - the same rule on iOS and Android. Report it exactly once per
   * message you show; a message you never report counts toward no frequency
   * cap and reads as delivered to nobody, which also breaks revenue
   * attribution, which joins on that event.
   *
   * Declare what YOUR renderer can draw via `options.capabilities`. Campaigns
   * are targeted on it, and an undeclared capability is read as "cannot" rather
   * than "unknown" - so an app with `react-native-webview` should include
   * `content.html`, and one without it should not. Omitting the option keeps the
   * previous behaviour, where the value came from a native config flag
   * describing the native SDK's own views, which never run here.
   *
   * @example
   * ```ts
   * const unsubscribe = Joryio.onInAppMessage((message) => {
   *   showMyOwnUI(message);
   *   Joryio.trackInAppImpression(message.id, 'displayed');
   *   // ... 'clicked' (with the button's id) when a button is tapped, and
   *   // 'dismissed' whenever the message leaves the screen - after a click too.
   * });
   *
   * // Later:
   * unsubscribe();
   * ```
   *
   * A message you reported `'displayed'` holds the display slot until you
   * report `'dismissed'`: until then no other in-app message is shown on iOS,
   * and the same campaign is not shown again on Android. If `'dismissed'`
   * never comes, the SDK frees the slot after 5 minutes. So report it whenever
   * the message leaves the screen, including after a click.
   *
   * A callback that throws (or returns a promise that rejects) is caught and
   * logged; it never crashes the app or stops other listeners.
   *
   * Subscribe before `initialize()` has completed (at module scope, or in an
   * effect that runs at start-up) and no message is ever drawn natively: the SDK holds every message
   * until `initialize()` has completed and this subscription has reached
   * native, then hands the held one to you. If you subscribe LATER (a screen
   * that mounts after initialize() has completed), pass
   * `holdInAppMessagesForHandler: true` to initialize(), or the native SDK
   * draws what is ready before you subscribe.
   *
   * Unsubscribing the LAST listener hands rendering back to the native SDK, so
   * messages that arrive afterwards are drawn natively instead of being handed
   * to a listener that no longer exists. Before 1.3.0 they were silently lost
   * on both platforms for the rest of the session.
   */
  onInAppMessage(
    callback: (message: InAppMessage) => unknown,
    options?: { capabilities?: Array<'content.native' | 'content.html'> },
  ): () => void {
    if (typeof callback !== 'function') {
      warn('onInAppMessage() needs a callback function; ignored.');
      return () => {};
    }
    if (!isModuleAvailable || !emitter) {
      return () => {};
    }
    const subscription = emitter.addListener(
      'JoryioInAppMessage',
      guardedCallback('onInAppMessage', callback),
    );
    this._inAppListeners += 1;
    // Via _dispatch, like every other native call. Called directly, this threw
    // "Joryio SDK not initialized" and RN surfaced a red box: a host app
    // naturally subscribes on mount, which is BEFORE initialize() resolves, so
    // in-app messaging never enabled at all. _dispatch queues the call until the
    // SDK is ready and then replays it, in order with the matching disable.
    // Declared capabilities describe YOUR renderer, not the SDK's.
    const capabilities = normalizeCapabilities(options?.capabilities);
    this._inAppHandedToJs = true;
    this._dispatch(() => JoryioModule.enableInAppMessages(capabilities));

    let removed = false;
    return () => {
      // Idempotent: a second call must not decrement someone else's listener.
      if (removed) return;
      removed = true;
      subscription.remove();
      this._inAppListeners = Math.max(0, this._inAppListeners - 1);
      if (this._inAppListeners === 0) {
        this._inAppHandedToJs = false;
        this._dispatch(() => JoryioModule.disableInAppMessages());
      }
    };
  }

  /**
   * Hand in-app messages to JavaScript and say what YOUR renderer can draw
   * (`content.native`, `content.html`). `onInAppMessage` calls this for you;
   * call it directly only when you listen for the `JoryioInAppMessage` event
   * some other way, and pair it with {@link disableInAppMessages}.
   *
   * An empty or omitted list means "not declared" on both platforms - the SDK
   * then describes its own renderer - never "this app can draw nothing".
   */
  enableInAppMessages(capabilities?: string[]): void {
    const declared = normalizeCapabilities(capabilities);
    this._inAppHandedToJs = true;
    this._dispatch(() => JoryioModule.enableInAppMessages(declared));
  }

  /**
   * Hand in-app rendering back to the native SDK after
   * {@link enableInAppMessages}. Removing the last `onInAppMessage` listener
   * does this for you.
   */
  disableInAppMessages(): void {
    this._inAppHandedToJs = false;
    this._dispatch(() => JoryioModule.disableInAppMessages());
  }

  private _ecommerce?: JoryioEcommerce;

  /**
   * E-commerce events with the platform's canonical names applied for you:
   * `Joryio.ecommerce.purchase(order)`.
   *
   * A real typed property, not something bolted on after construction. The
   * first version assigned it with `(Joryio as any).ecommerce = ...`, which
   * worked at runtime and was invisible to TypeScript - so every call site got
   * "Property 'ecommerce' does not exist". The demo app found it immediately,
   * which is what a reference integration is for.
   */
  get ecommerce(): JoryioEcommerce {
    return (this._ecommerce ??= new JoryioEcommerce(this));
  }

  /**
   * Report what happened to an in-app message YOUR app rendered.
   *
   * @param campaignId the message's `id`
   * @param action     `'displayed'` once when it appears (this is also what
   *                   spends the campaign's frequency budget), `'clicked'`
   *                   when a button is tapped, and `'dismissed'` whenever it
   *                   leaves the screen - after a click too, because the
   *                   message holds the display slot until then
   * @param elementId  for a click, the id of the button or link tapped - sent
   *                   as `elementId`, the same name on every SDK, so reports can
   *                   say which button. Omit it for other actions.
   */
  trackInAppImpression(campaignId: string, action: string, elementId?: string): void {
    if (!requireString('trackInAppImpression', 'campaignId', campaignId)) return;
    if (!requireString('trackInAppImpression', 'action', action)) return;
    const element = typeof elementId === 'string' && elementId.length > 0 ? elementId : null;
    this._dispatch(() => JoryioModule.trackInAppImpression(campaignId, action, element), 'data');
  }

  /**
   * Submit a form shown inside an HTML in-app message that your app renders
   * itself (a `<form data-jry-form>` in the campaign's html). The values are
   * posted with the SDK's identity; the backend validates them against the
   * form the campaign carries and writes the person. Resolves with the
   * server's verdict - `{ ok, message?, redirect?, errors? }` - and never
   * throws: a failure is `ok: false`.
   */
  async submitInAppForm(campaignId: string, values: Record<string, string | string[]>): Promise<InAppFormResult> {
    const failed: InAppFormResult = { ok: false, message: 'Something went wrong. Please try again.' };
    if (!requireString('submitInAppForm', 'campaignId', campaignId)) return failed;
    const fields = plainObject(values);
    return this._query<InAppFormResult>('submitInAppForm', failed, async () => {
      const raw = await JoryioModule.submitInAppForm(campaignId, fields);
      // Android answers a JSON string, iOS an object; both mean the same thing.
      return typeof raw === 'string' ? (JSON.parse(raw) as InAppFormResult) : raw;
    });
  }

  // ─── SDK Authentication ──────────────────────────────────────────────────

  /**
   * Set/replace the customer-minted JWT used for SDK Authentication.
   * Attached as the `X-Joryio-Auth` header on every subsequent ingest request.
   * Call after login, and again from your `onSdkAuthenticationError` handler to
   * supply a freshly minted token.
   *
   * @example
   * ```ts
   * const jwt = await mintJoryioJwt(); // your backend mints it
   * Joryio.setSdkAuthenticationToken(jwt);
   * ```
   */
  setSdkAuthenticationToken(token: string): void {
    if (!requireString('setSdkAuthenticationToken', 'token', token)) return;
    const send = () => JoryioModule.setSdkAuthenticationToken(token);
    // Before initialize() has started, straight to native, which holds a
    // token set before its own init and applies it ahead of the Session Start
    // and the in-app sync. Held here until init resolved, it arrived after
    // both, so a stored identified user's first requests went out with no
    // token, were refused 401 `missing` and waited on the refresh round-trip.
    //
    // Only when no identify() or reset() is held: the token belongs to the
    // identity those set up, and handed over ahead of them it would be
    // applied to the previous one (a held reset() replayed after init would
    // even retire it). Nor after a wipeData() handed to native: native runs
    // that wipe inside init and would retire the new visitor's token with
    // the erased person's. A wipe made AFTER it is native's to apply: both
    // natives keep a token recorded before their pre-init wipe and the wipe
    // retires it to the erased person's own withdrawals, so it is never
    // carried over to the next visitor.
    if (
      isModuleAvailable &&
      !this._initialized &&
      this._initInFlight === null &&
      !this._wipeHandedToNative &&
      !this._pending.some((call) => call.kind === 'identity' || call.kind === 'token' || call.tag === 'reset')
    ) {
      this._invoke(send);
      return;
    }
    this._dispatch(send, 'token');
  }

  /**
   * Listen for SDK-authentication failures (the backend rejected the JWT with a
   * 401 `sdk_authentication_error`). Mint a fresh JWT in the callback and call
   * `setSdkAuthenticationToken()`; the refreshed token is carried on the next
   * flush. Returns an unsubscribe function.
   *
   * @example
   * ```ts
   * const unsubscribe = Joryio.onSdkAuthenticationError(async ({ reason }) => {
   *   const jwt = await mintJoryioJwt(); // re-mint (esp. on 'expired')
   *   Joryio.setSdkAuthenticationToken(jwt);
   * });
   * ```
   */
  // Works on BOTH platforms, by different routes: Android exposes an explicit
  // enable call, iOS registers the handler during initialize(). The asymmetry is
  // invisible to callers and is handled below.
  onSdkAuthenticationError(callback: (error: SdkAuthError) => unknown): () => void {
    if (typeof callback !== 'function') {
      warn('onSdkAuthenticationError() needs a callback function; ignored.');
      return () => {};
    }
    if (!isModuleAvailable || !emitter) {
      return () => {};
    }
    const subscription = emitter.addListener(
      'JoryioSdkAuthError',
      guardedCallback('onSdkAuthenticationError', callback),
    );
    // Straight to native, before initialize() too, and as an optional call:
    //
    //  - straight away: the Android bridge installs the handler through the
    //    native SDK's pre-init-aware setter, so one set before initialize()
    //    is in place for the first requests (Session Start, in-app sync) and
    //    survives a pre-init wipeData() (contract v8 84). Held here until
    //    init, it arrived after those requests, whose 401s nobody heard.
    //  - `?.()`: the method exists on ANDROID ONLY. iOS registers the same
    //    handler inside initialize() instead, so the callback works there
    //    either way - but calling a method iOS does not export would throw
    //    "undefined is not a function". Same convention as syncInAppCampaigns.
    //
    // Safe before init on both platforms (the same shape as the pre-init token
    // in setSdkAuthenticationToken): Android's bridge calls the companion
    // setter, iOS has no such method. _invoke catches a native throw.
    const enable = () => JoryioModule.enableSdkAuthenticationErrors?.();
    this._invoke(enable);
    return () => subscription.remove();
  }

  // ─── Utilities ───────────────────────────────────────────────────────────

  /**
   * Flush the event queue immediately.
   * Events are normally batched and sent periodically.
   */
  flush(): void {
    this._dispatch(() => JoryioModule.flush());
  }

  /**
   * Fetch in-app campaigns now and display any that are eligible.
   *
   * The SDK already syncs on session start and on foreground; use this for the
   * moments in between - after resetDisplayedCampaigns(), or once the user has
   * done something that should make them newly eligible.
   *
   * Both platforms. It was iOS-only, which was a missing BINDING rather than a
   * missing capability - the Android facade has exposed `syncInAppCampaigns()`
   * all along and the module simply never bound it, so this call was
   * `undefined` on Android and did nothing at all.
   *
   * `?.()` is kept for a different reason than before: an app on an older
   * native module than this JS package would otherwise throw
   * "undefined is not a function".
   */
  syncInAppCampaigns(): void {
    this._dispatch(() => JoryioModule.syncInAppCampaigns?.());
  }

  /**
   * Forget which in-app campaigns have already been shown on this device.
   *
   * The SDK skips any campaign it has displayed before, and that set is
   * persisted - so a message appears once per install and then never again.
   * Useful when testing: without it you must delete and reinstall the app to
   * see the same campaign twice.
   *
   * Both platforms, but they forget different things, and the difference is
   * real rather than an oversight:
   *
   *   iOS      clears the persisted show-once-ever set AND the per-campaign
   *            impression history.
   *   Android  has no show-once-ever set - a campaign with no frequency cap
   *            repeats there by design - so it clears the impression history
   *            and the cross-campaign gap, which is the state that actually
   *            suppresses a repeat on that platform.
   *
   * This was documented as "iOS ONLY - Android has nothing to reset", which was
   * out of date: Joryio.kt has exposed resetDisplayedCampaigns() throughout and
   * it does the second thing above. Debug-gated natively, so release builds are
   * unaffected on both.
   */
  resetDisplayedCampaigns(): void {
    // `?.()` guards an app on an older native module than this JS package, not
    // a platform gap.
    this._dispatch(() => JoryioModule.resetDisplayedCampaigns?.());
  }

  /**
   * What the SDK is EXPERIENCING: which server it talks to, and the last
   * transport failure (null once a call succeeds again).
   *
   * "Initialized" and "the server accepts us" are different claims. Without
   * this, a wrong SDK key looks identical to a healthy integration - the SDK
   * reports itself up while every request is rejected 401.
   *
   * Implemented on BOTH platforms. It was iOS-only, which meant the one call you
   * reach for when an integration misbehaves was absent on Android.
   *
   * It is also what the SDK is ACTUALLY doing, as opposed to the config your
   * app believes it set: `initialize()` ignores a second call, so changing
   * settings without restarting leaves the SDK on the old values while your UI
   * shows the new ones.
   */
  async getDiagnostics(): Promise<{
    apiEndpoint: string | null;
    lastError?: {message: string; isUnauthorized: boolean; isRetryable: boolean; at: number};
  }> {
    // Gated like the other getters. "initialize() never completed" IS the
    // diagnostic in that case, and _awaitReady logs exactly that.
    return this._query('getDiagnostics', {apiEndpoint: null}, () => {
      return JoryioModule.getDiagnostics();
    });
  }

  /**
   * Get the anonymous ID assigned to this device.
   */
  async getAnonymousId(): Promise<string> {
    return this._query('getAnonymousId', '', () => {
      return JoryioModule.getAnonymousId();
    });
  }

  /**
   * Get the current user ID (null if not identified).
   */
  async getUserId(): Promise<string | null> {
    return this._query<string | null>('getUserId', null, () => {
      return JoryioModule.getUserId();
    });
  }

  /**
   * Get the current session ID.
   */
  async getSessionId(): Promise<string> {
    return this._query('getSessionId', '', () => {
      return JoryioModule.getSessionId();
    });
  }
}

// Export singleton
/** A product as the e-commerce tracker expects it. */
export interface EcommerceProduct {
  productId: string;
  name: string;
  price: number;
  quantity?: number;
  category?: string;
  brand?: string;
  variant?: string;
  variantId?: string;
  sku?: string;
  imageUrl?: string;
  url?: string;
}

/** A cart line. `quantity` is required here; a line without one is not a line. */
export interface EcommerceCartItem extends EcommerceProduct {
  quantity: number;
}

export interface EcommerceOrder {
  orderId: string;
  items: EcommerceCartItem[];
  value: number;
  currency?: string;
  shipping?: number;
  tax?: number;
  discount?: number;
  coupon?: string;
}
/**
 * E-commerce events, with the platform's canonical names applied for you.
 *
 * WHY THIS EXISTS. The web, iOS and Android SDKs have always had this; React
 * Native did not, so every RN integration hand-typed event names - and there is
 * deliberately NO alias layer server-side. "Added to Cart" is not a near-miss
 * for "Product Added", it is a different event: stored verbatim, matching no
 * e-commerce report, no revenue attribution and no recommendation feature.
 *
 * Our own demo shop did exactly that and recorded zero revenue while looking
 * completely healthy on screen, which is the failure mode this closes: not an
 * error, a plausible number.
 *
 * Every call forwards to the native tracker, which owns the vocabulary. Nothing
 * here re-spells an event name.
 */
/** The lines of a cart or order without its null entries. */
function withoutNullLines(items: unknown[]): unknown[] {
  return items.filter((item) => item !== null && item !== undefined);
}

class JoryioEcommerce {
  private readonly sdk: JoryioSDK;

  constructor(sdk: JoryioSDK) {
    this.sdk = sdk;
  }

  private send(method: string, payload: Record<string, unknown>): void {
    // Optional arguments left out rather than sent as null: the bridges read a
    // present key as a value, and a null where a number was expected is the
    // native SDK's default, not an error (contract item 19).
    const clean = withoutNullValues(payload);
    // A null line is skipped (see lines()), so it must not reach the bridge
    // either: both bridges turned it into a line with no productId, and both
    // native trackers then refused the WHOLE call - an order lost, with
    // nothing in JS to say so.
    if (Array.isArray(clean.items)) clean.items = withoutNullLines(clean.items);
    if (isRecord(clean.order) && Array.isArray(clean.order.items)) {
      clean.order = { ...clean.order, items: withoutNullLines(clean.order.items) };
    }
    // An optional count that is NaN or Infinity (a line's quantity, a search's
    // resultCount) is left out with a warning, so the native default applies
    // (contract v5 49). Android read NaN as 0 and iOS as absent.
    const finite = finiteProperties(`ecommerce.${method}`, clean);
    // Same queue-until-ready path as every other call, so a tracker built in a
    // module field before initialize() resolves does not silently drop events.
    (this.sdk as any)._dispatch(() => JoryioModule.ecommerce(method, finite), 'data');
  }

  // ── Required arguments (contract items 19 and 42) ──────────────────────
  //
  // A missing required argument warns and sends NOTHING. Both bridges used to
  // fill the gap with a default, so `purchase(null)` tracked an Order
  // Completed with orderId "" and total 0 - not an error anyone would see, a
  // plausible zero in the revenue report. The native trackers check again.
  //
  // ONE set on every Joryio SDK and wrapper (pinned by the backend's
  // ecommerce-guard-parity spec): a product - and every cart/order line -
  // needs a productId and a finite price; cart calls a finite cartValue;
  // purchase an orderId and a finite value (the items may be empty); every
  // other id or label is required; an optional amount may be left out, but
  // one given must be finite. An id that is only whitespace counts as missing.

  private product(caller: string, value: unknown, name = 'product'): boolean {
    if (!isRecord(value) || !isNonBlankString(value.productId)) {
      warn(`ecommerce.${caller}() needs a ${name} with a productId; ignored.`);
      return false;
    }
    return this.amount(caller, `${name}.price`, value.price);
  }

  /** Every line (a null entry is skipped, and not sent) a valid product. */
  private lines(caller: string, items: unknown[]): boolean {
    return items.every((item) => item == null || this.product(caller, item, 'item'));
  }

  private text(caller: string, name: string, value: unknown): boolean {
    if (isNonBlankString(value)) return true;
    warn(`ecommerce.${caller}() needs a non-empty string ${name}; ignored.`);
    return false;
  }

  private amount(caller: string, name: string, value: unknown): boolean {
    if (typeof value === 'number' && Number.isFinite(value)) return true;
    warn(`ecommerce.${caller}() needs a number ${name}; ignored.`);
    return false;
  }

  /** Absent is fine; present must be finite. */
  private optionalAmount(caller: string, name: string, value: unknown): boolean {
    return value === undefined || value === null || this.amount(caller, name, value);
  }

  private cart(caller: string, items: unknown, cartValue: unknown): boolean {
    if (!Array.isArray(items)) {
      warn(`ecommerce.${caller}() needs an array of items; ignored.`);
      return false;
    }
    return this.lines(caller, items) && this.amount(caller, 'cartValue', cartValue);
  }

  viewProduct(product: EcommerceProduct): void {
    if (!this.product('viewProduct', product)) return;
    this.send('viewProduct', {product});
  }
  viewCategory(categoryId: string, categoryName: string): void {
    if (!this.text('viewCategory', 'categoryId', categoryId)) return;
    if (!this.text('viewCategory', 'categoryName', categoryName)) return;
    this.send('viewCategory', {categoryId, categoryName});
  }
  search(query: string, resultCount?: number): void {
    if (!this.text('search', 'query', query)) return;
    this.send('search', {query, resultCount});
  }
  addToCart(item: EcommerceCartItem, cartValue?: number): void {
    if (!this.product('addToCart', item, 'item')) return;
    if (!this.optionalAmount('addToCart', 'cartValue', cartValue)) return;
    this.send('addToCart', {item, cartValue});
  }
  removeFromCart(product: EcommerceProduct, quantity = 1): void {
    if (!this.product('removeFromCart', product)) return;
    this.send('removeFromCart', {product, quantity});
  }
  cartViewed(items: EcommerceCartItem[], cartValue: number): void {
    if (!this.cart('cartViewed', items, cartValue)) return;
    this.send('cartViewed', {items, cartValue});
  }
  updateCart(items: EcommerceCartItem[], cartValue: number): void {
    if (!this.cart('updateCart', items, cartValue)) return;
    this.send('updateCart', {items, cartValue});
  }
  startCheckout(items: EcommerceCartItem[], cartValue: number): void {
    if (!this.cart('startCheckout', items, cartValue)) return;
    this.send('startCheckout', {items, cartValue});
  }
  addPaymentInfo(paymentMethod: string): void {
    if (!this.text('addPaymentInfo', 'paymentMethod', paymentMethod)) return;
    this.send('addPaymentInfo', {paymentMethod});
  }
  /**
   * An order. `orderId`, `items` (an array, may be empty) and a finite `value`
   * are required: the value is sent as `total`, the key revenue reports read,
   * and a purchase missing any of them is ignored with a warning rather than
   * recorded as a zero or an empty order.
   */
  purchase(order: EcommerceOrder): void {
    if (!isRecord(order) || !isNonBlankString(order.orderId)) {
      warn('ecommerce.purchase() needs an order with an orderId; ignored.');
      return;
    }
    if (!Array.isArray(order.items)) {
      warn('ecommerce.purchase() needs an order with an items array; ignored.');
      return;
    }
    if (!this.amount('purchase', 'order.value', order.value)) return;
    if (!this.lines('purchase', order.items)) return;
    if (!this.optionalAmount('purchase', 'order.shipping', order.shipping)) return;
    if (!this.optionalAmount('purchase', 'order.tax', order.tax)) return;
    if (!this.optionalAmount('purchase', 'order.discount', order.discount)) return;
    this.send('purchase', {order});
  }
  orderFulfilled(orderId: string, trackingNumber?: string, carrier?: string): void {
    if (!this.text('orderFulfilled', 'orderId', orderId)) return;
    this.send('orderFulfilled', {orderId, trackingNumber, carrier});
  }
  orderDelivered(orderId: string): void {
    if (!this.text('orderDelivered', 'orderId', orderId)) return;
    this.send('orderDelivered', {orderId});
  }
  orderCancelled(orderId: string, reason?: string): void {
    if (!this.text('orderCancelled', 'orderId', orderId)) return;
    this.send('orderCancelled', {orderId, reason});
  }
  orderRefunded(orderId: string, refundAmount?: number, reason?: string): void {
    if (!this.text('orderRefunded', 'orderId', orderId)) return;
    if (!this.optionalAmount('orderRefunded', 'refundAmount', refundAmount)) return;
    this.send('orderRefunded', {orderId, refundAmount, reason});
  }
  addToWishlist(product: EcommerceProduct): void {
    if (!this.product('addToWishlist', product)) return;
    this.send('addToWishlist', {product});
  }
  removeFromWishlist(product: EcommerceProduct): void {
    if (!this.product('removeFromWishlist', product)) return;
    this.send('removeFromWishlist', {product});
  }
  shareProduct(product: EcommerceProduct, shareMethod: string): void {
    if (!this.product('shareProduct', product)) return;
    if (!this.text('shareProduct', 'shareMethod', shareMethod)) return;
    this.send('shareProduct', {product, shareMethod});
  }
  applyCoupon(couponCode: string, discountAmount?: number, discountType?: string): void {
    if (!this.text('applyCoupon', 'couponCode', couponCode)) return;
    if (!this.optionalAmount('applyCoupon', 'discountAmount', discountAmount)) return;
    this.send('applyCoupon', {couponCode, discountAmount, discountType});
  }
  removeCoupon(couponCode: string): void {
    if (!this.text('removeCoupon', 'couponCode', couponCode)) return;
    this.send('removeCoupon', {couponCode});
  }
  submitReview(productId: string, rating: number, reviewText?: string): void {
    if (!this.text('submitReview', 'productId', productId)) return;
    if (!this.amount('submitReview', 'rating', rating)) return;
    // Both native trackers take an Int. Swift's Int(Double) TRAPS past
    // Int.max - a crash of the host app from `Number(userInput)` - and
    // Kotlin's toInt() quietly saturates, so the platforms disagreed too.
    if (Math.abs(rating) > MAX_RATING_MAGNITUDE) {
      warn(`ecommerce.submitReview() needs a rating a whole-number type can hold, not ${rating}; ignored.`);
      return;
    }
    this.send('submitReview', {productId, rating, reviewText});
  }
}

const Joryio = new JoryioSDK();

/** Also exported standalone, for `import {ecommerce} from ...`. */
export const ecommerce = Joryio.ecommerce;
export default Joryio;
