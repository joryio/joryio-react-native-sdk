# Joryio React Native SDK

The Joryio SDK for React Native apps: one TypeScript API over the native Joryio iOS and Android SDKs for identity, event tracking, push notifications and in-app messages.

Every call forwards to the native SDK, so batching, offline queueing, retries and in-app rendering behave exactly as in a native integration. For platform details, see the [iOS SDK](https://github.com/joryio/joryio-ios-sdk) and [Android SDK](https://github.com/joryio/joryio-android-sdk).

## Features

- **Event tracking** and screen views, batched and queued offline by the native SDKs
- **Identity** - anonymous ID out of the box, `identify`, labelled aliases with `addAlias`
- **User attributes** - set, increment and unset
- **Push notifications** - register APNs / FCM tokens, delivery receipts, click tracking, permission prompts
- **In-app messages** drawn by the native SDKs with no JavaScript, or rendered by your own React components
- **E-commerce helpers** that send the standard event names Joryio reports on
- **Subscription preferences** per channel and subscription group
- **Privacy controls** - opt-out and tracking consent
- **SDK authentication** (optional) - a customer-minted JWT on every ingest request
- **TypeScript** types included

## Requirements

- React Native 0.75 or newer (on iOS the native SDK is linked as a Swift package through React Native's `spm_dependency`, added in 0.75); with Expo, SDK 52 or newer. Old and New Architecture both work; on the New Architecture the module runs through React Native's interop layer for legacy modules, which is on by default
- iOS 14.0+
- Android 6.0 (API level 23)+
- A Joryio workspace with an **iOS app** and an **Android app**, each with its own SDK key (`jry_sdk_ios_...`, `jry_sdk_android_...`) from **Settings → Apps** in the dashboard

## Installation

```bash
npm install @joryio/react-native-sdk
# or
yarn add @joryio/react-native-sdk
```

The package is autolinked on both platforms. Do not also register `JoryioPackage` by hand.

### iOS

The native dependency is the Joryio iOS SDK's **Swift package** (`https://github.com/joryio/joryio-ios-sdk`, products `Joryio` and `JoryioUI`: tracking, identity, push and in-app display), pinned to this package's version. `pod install` adds it to the Pods project through React Native's `spm_dependency`, and Xcode downloads it on the first build, which needs network access to `github.com`. Nothing comes from CocoaPods trunk, which stops accepting new versions on 2 December 2026.

The SDK needs iOS 14.0, while some React Native versions default lower, so raise the platform in `ios/Podfile`:

```ruby
platform :ios, [min_ios_version_supported, '14.0'].max
```

Then:

```bash
cd ios && pod install
```

React Native prints two `[SPM] WARNING` lines during `pod install` for any library that uses Swift packages (reopen the workspace on Xcode 15 or earlier; the package is linked statically). If your app then fails to link, install with `USE_FRAMEWORKS=dynamic pod install`.

Upgrading from a version that used the `Joryio/UI` pod: if you added a `pod 'Joryio...'` line to your Podfile yourself, delete it and run `pod install` again.

### Android

Nothing to add. The bridge depends on `io.joryio:joryio-android-ui` from Maven Central, at the same version as this package; React Native projects already list `mavenCentral()` in their repositories.

### Expo

The SDK is a native module, so it does not run in Expo Go. Use a development build (`npx expo prebuild` or EAS Build) on Expo SDK 52 or newer. Expo's default iOS deployment target can be lower than the 14.0 the SDK needs; raise it with `expo-build-properties` in `app.json`:

```json
{
  "expo": {
    "plugins": [["expo-build-properties", { "ios": { "deploymentTarget": "14.0" } }]]
  }
}
```

### Building the native SDKs from source (optional)

If you build the native SDKs from a checkout instead of the registries:

- **Android** - include both modules in `android/settings.gradle` under these names, and the bridge uses them instead of Maven Central:

  ```groovy
  include ':joryio-sdk'
  project(':joryio-sdk').projectDir = new File(rootProject.projectDir, '../path/to/joryio-android-sdk/joryio')
  include ':joryio-sdk-ui'
  project(':joryio-sdk-ui').projectDir = new File(rootProject.projectDir, '../path/to/joryio-android-sdk/joryio-ui')
  ```

- **iOS** - set `JORYIO_IOS_SDK_SPM_URL` when you run `pod install`: another git URL for the Swift package (it must carry a tag equal to this package's version), or, on React Native 0.84 and newer, the absolute path of a `joryio-ios-sdk` checkout: `JORYIO_IOS_SDK_SPM_URL=/abs/path/to/joryio-ios-sdk pod install`.

If you link this package from a source checkout rather than installing it from npm, run `npm run build` in it once: `main` points at the compiled `lib/`, which is built on publish and is not in the repository.

## Quick start

```typescript
import { Platform } from 'react-native';
import Joryio from '@joryio/react-native-sdk';

// Once, at app start (e.g. in App.tsx)
await Joryio.initialize(
  Platform.select({
    ios: 'jry_sdk_ios_YOUR_IOS_KEY',
    android: 'jry_sdk_android_YOUR_ANDROID_KEY',
  })!,
  'api-eu1.joryio.com', // your workspace's API host
  {
    enableDebug: __DEV__,
  },
);

// Track events
Joryio.track('Product Added', { productId: '123', price: 29.99 });
Joryio.trackScreen('ProductDetail', { productId: '123' });

// Identify users
Joryio.identify('user-123');
Joryio.setAttributes({ firstName: 'Jane', plan: 'premium' });
Joryio.incrementAttribute('loginCount', 1);

// Attach an id from another system - works before identify() too
Joryio.addAlias('crm_id', 'C-1042');

// Logout
Joryio.reset();
```

Calls made before `initialize()` resolves are held and sent once it does (at most 1,000, the same cap as the native SDKs; past that the oldest are dropped, with a warning - data calls first, and an unsubscribe, `unregisterPush()` or a privacy decision only when nothing else is left). If `initialize()` fails, the SDK logs why and keeps holding calls the same way until a later `initialize()` succeeds - you can call it again with corrected values, your `onInAppMessage` and `onSdkAuthenticationError` listeners and any unsubscribes made meanwhile are kept, and nothing throws into your app. Use the API host shown for your workspace in the dashboard; a bare host is fine.

Each platform has its own SDK key: iOS keys start with `jry_sdk_ios_`, Android keys with `jry_sdk_android_`. A key the platform refuses makes `initialize()` log a warning and leaves the SDK off until you call it again with the right key. Two overlapping `initialize()` calls - React StrictMode runs effects twice - share one start.

`null` and `undefined` never crash your app: a `null` configuration value means the default, a call missing a required argument (an event name, a user id, a token) logs a warning and does nothing, and a `null` attribute value unsets the attribute. `NaN` and `Infinity` are never sent: an attribute value or event property holding one is left out with a warning, and the rest of the call goes ahead (`setAttribute(key, NaN)` is ignored rather than unsetting the attribute). A callback you pass to `onInAppMessage` or `onSdkAuthenticationError` that throws, or returns a promise that rejects, is caught and logged - it never crashes your app or stops other listeners.

On Android the bridge passes the current Activity to the native SDK at `initialize()`, so in-app messages and `requestPushPermissionAtLaunch` work in the very first session, not only after the app has been backgrounded once.

## Configuration options

All options are optional:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enableDebug` | `boolean` | `false` | Verbose native logging; also enables the testing-only APIs |
| `logLevel` | `'debug' \| 'info' \| 'warn' \| 'error'` | follows `enableDebug` | Override the native log level |
| `batchSize` | `number` | `50` | Events per batch |
| `flushInterval` | `number` | `5000` | Milliseconds between automatic flushes |
| `sendImmediately` | `boolean` | `false` | Send each event immediately |
| `maxQueueSize` | `number` | `1000` | Most events held while sends fail |
| `requestTimeout` | `number` | `10000` | Per-request timeout in ms |
| `sessionTimeout` | `number` | `1800000` | Milliseconds of inactivity before a new session |
| `trackSessionStart` | `boolean` | `true` | Track "Session Start" automatically |
| `userId` | `string` | - | Start with a known user ID |
| `anonymousId` | `string` | generated | Use your own anonymous ID |
| `requestPushPermissionAtLaunch` | `boolean` | `false` | Ask for notification permission at startup. Prefer asking at a moment the user understands |
| `allowHtmlJsInAppMessages` | `boolean` | `false` | Allow HTML in-app messages (see below) |
| `enableSdkAuthentication` | `boolean` | `false` | Attach a customer-minted JWT to every ingest request |
| `sdkAuthenticationToken` | `string` | - | Initial JWT |
| `trackingConsent` | `'granted' \| 'denied' \| 'pending'` | unset | Consent at startup. Leave it unset unless your consent banner has an answer - see [Privacy controls](#privacy-controls) |
| `optOut` | `boolean` | `false` | Start opted out of tracking |
| `notificationChannelName` | `string` | `"Notifications"` | Android only: the notification channel name people see in system settings (Android 8+). Pass it localized. Ignored on iOS |

## Push notifications

Upload your push credentials in the dashboard first: [APNs for iOS](https://docs.joryio.com/developers/apps/apns-credentials), [Firebase for Android](https://docs.joryio.com/developers/apps/fcm-credentials). Joryio sends iOS push through APNs, so on iOS register the **APNs** token, not the FCM one.

Ask for permission when the user has a reason to say yes - the system prompt is one-shot:

```typescript
if ((await Joryio.getPushPermissionStatus()) === 'notDetermined') {
  // show your own primer first, then:
  const status = await Joryio.requestPushPermission(); // 'granted' | 'denied' | 'notDetermined' | 'unavailable'
}
```

### Registering the token (example with React Native Firebase)

```typescript
import { Platform } from 'react-native';
import messaging from '@react-native-firebase/messaging';

const token = Platform.OS === 'ios'
  ? await messaging().getAPNSToken()   // APNs device token (hex)
  : await messaging().getToken();      // FCM token

if (token) {
  const result = await Joryio.registerPushToken(token);
  if (!result.success && result.isRetryable) {
    // transient failure (offline, DNS, 5xx): register again when the network is back
  }
}

messaging().onTokenRefresh((newToken) => {
  // onTokenRefresh delivers the FCM token - on iOS too, at every app start.
  // Register it on Android only; on iOS the APNs token above is the one.
  if (Platform.OS === 'android') Joryio.registerPushToken(newToken);
});
```

On iOS register only the APNs device token. React Native Firebase's `onTokenRefresh` hands over the **FCM** token on iOS as well, at every app start, and registered it would replace the device's working APNs token with one APNs refuses - so register it on Android only, as above. On iOS `registerPushToken` refuses a token that is not an APNs token (hex) with `success: false` and `isRetryable: false`.

If the user has turned push off and you called `unregisterPush()`, do not register tokens from automatic callbacks (`onTokenRefresh`, a `getToken()` at launch) until they turn it back on: `registerPushToken()` is the explicit "push on" and lifts the unregister. Check your own push setting before registering.

`registerPushToken` resolves with `{ success, message, isUnauthorized, isRetryable }` and never rejects. `isRetryable` is `true` when `initialize()` simply has not finished yet, and `false` after it failed: register the token again once a later `initialize()` succeeds.

`requestPushPermission()` behaves the same on both platforms:

- It always settles. On Android, if the Activity is recreated while the prompt is showing (a rotation, a theme change), it resolves with the status as it stands once your app is back in front.
- When the user has opted out of tracking, the prompt is still shown and the result returned - whether your app may notify is the user's choice in the OS - but nothing is registered with or reported to Joryio while they stay opted out.

### Delivery receipts and clicks

When your own messaging library handles notifications, report them with the `trackingId` from the message's data payload:

```typescript
messaging().onMessage(async (msg) => {
  if (msg.data?.trackingId) Joryio.reportPushDelivered(String(msg.data.trackingId));
});

messaging().onNotificationOpenedApp((msg) => {
  if (msg.data?.trackingId) Joryio.trackPushClick(String(msg.data.trackingId));
});
```

A Joryio push carries the same data keys on every platform: `joryio` (always `"true"`), `trackingId`, `jry_campaign_id` (campaign or journey id), `jry_deep_link` (what a tap opens) and `jry_image_url`. On Android the native SDK also records the tap itself when your app is opened from a notification; reporting it as well is harmless, a click is counted once per notification.

Also available: `isPushEnabled()` and `unregisterPush()`, which stops pushes to this device and stays in effect across restarts until you call `registerPushToken()` again.

## In-app messaging

**Messages display on their own.** Install the SDK, send a campaign, and the native SDK draws it with your app's fonts, colours and dark mode. Impressions, clicks and dismissals are tracked for you.

HTML messages are off by default, because the native SDK shows them in a web view inside your app; pass `allowHtmlJsInAppMessages: true` to `initialize` to opt in. Scripts written into a message do not run there - only the native SDK's bridge does, and it handles buttons and forms. Native messages display either way.

### Rendering messages in React

Subscribe to draw messages yourself. Subscribing takes over from the native rendering, so you will not get two copies, and removing your last subscription hands rendering back to the native SDK, so no message is lost after you unsubscribe:

```typescript
const unsubscribe = Joryio.onInAppMessage(
  (message) => {
    if (message.kind === 'native') {
      // message.title, message.body, message.imageUrl, message.buttons, message.style
      // Plain text: put it in a <Text>, never in a WebView.
    } else {
      // message.html + message.css - render in a WebView
    }
    Joryio.trackInAppImpression(message.id, 'displayed');
    // ... then 'clicked' (with the button's id) when a button is tapped, and
    // 'dismissed' whenever the message leaves the screen - after a click too:
    // Joryio.trackInAppImpression(message.id, 'clicked', button.id);
    // Joryio.trackInAppImpression(message.id, 'dismissed');
  },
  { capabilities: ['content.native'] }, // add 'content.html' only if you render HTML
);

// Later
unsubscribe();
```

You must report what happened with `trackInAppImpression(campaignId, action, elementId?)`. Report `'displayed'` once, when the message appears: that report records the impression and is what counts toward the campaign's frequency caps - handing the message to your code does neither, on both platforms. For `'clicked'`, pass the id of the tapped button or link as `elementId` so reports can say which one. A message you never report counts toward no cap and shows no displays in reporting.

Report `'dismissed'` whenever the message leaves the screen, including after a click. Until then the message holds the display slot: on iOS no other in-app message is shown, and on Android the same campaign is not shown again. If `'dismissed'` never comes, the SDK frees the slot after 5 minutes. When you render an HTML message in a WebView, escape `</` in `message.css` (`message.css.replace(/<\//g, '<\\/')`) so the campaign's CSS cannot close your `<style>` tag.

A form inside an HTML message you render yourself is submitted with `submitInAppForm(campaignId, values)`, which resolves `{ ok, message?, redirect?, errors? }` and never rejects.

Native button actions are `dismiss`, `url` (open `url` in the browser), `deep_link` (route to `url` inside your app) and `request_push_permission` - a push primer's "yes" button: close the message and call `Joryio.requestPushPermission()`.

An empty `capabilities` list means the same as leaving it out (not declared) on both platforms. `enableInAppMessages(capabilities?)` and `disableInAppMessages()` are the lower-level pair `onInAppMessage` uses; call them yourself only if you listen for the `JoryioInAppMessage` event another way.

`syncInAppCampaigns()` fetches campaigns now. `resetDisplayedCampaigns()` is a testing helper that only runs when `enableDebug` is on. When JavaScript reloads, the bridge hands rendering back to the native SDK until your code subscribes again.

## E-commerce

```typescript
import Joryio from '@joryio/react-native-sdk';

Joryio.ecommerce.viewProduct({ productId: 'SKU123', name: 'Blue Shirt', price: 29.99 });
Joryio.ecommerce.addToCart({ productId: 'SKU123', name: 'Blue Shirt', price: 29.99, quantity: 1 });
Joryio.ecommerce.purchase({
  orderId: 'ORD123',
  items: [{ productId: 'SKU123', name: 'Blue Shirt', price: 29.99, quantity: 1 }],
  value: 29.99,
  currency: 'USD',
});
```

`purchase` sends an `Order Completed` event with `orderId` and `total` (the order's `value`) - the keys revenue reporting and attribution read. A hand-typed `track('Order Completed', { order_id, value })` records a $0 order with no order id; if you track a purchase yourself, use `orderId` and `total`.

A call missing a required argument - a `purchase` without `orderId`, `items` or a numeric `value`, a product without `productId`, a cart without `items` - logs a warning and sends nothing, so it never records a $0 order.

Also available: `viewCategory`, `search`, `removeFromCart`, `cartViewed`, `updateCart`, `startCheckout`, `addPaymentInfo`, `orderFulfilled`, `orderDelivered`, `orderCancelled`, `orderRefunded`, `addToWishlist`, `removeFromWishlist`, `shareProduct`, `applyCoupon`, `removeCoupon` and `submitReview`. See [E-commerce tracking](https://docs.joryio.com/developers/sdk/ecommerce-tracking).

## Subscription preferences

Whether a person may be **messaged** on a channel - separate from `optOut()`, which is whether they may be **tracked**.

```typescript
Joryio.setSubscription('email', 'unsubscribed');
Joryio.addToSubscriptionGroup('list_abc123', 'email');
Joryio.removeFromSubscriptionGroup('list_abc123', 'email');
```

Channels: `email`, `sms`, `whatsapp`, `push`, `viber`. Statuses: `optedIn`, `subscribed`, `unsubscribed`.

## Privacy controls

Two separate switches decide whether the SDK collects anything, and any "no" wins:

- **Consent** - the answer from your consent banner: `'granted'`, `'denied'` or `'pending'`. Set with `trackingConsent` at `initialize()` or with `updateConsent()`.
- **Opt-out** - the person's own choice. Set with `optOut()` and lifted only by `optIn()`.

The SDK collects only while consent is `granted` and the person has not opted out. Granting consent never cancels an opt-out, and opting out never changes the stored consent.

```typescript
Joryio.optOut();
Joryio.optIn();
const optedOut = await Joryio.isUserOptedOut();    // the opt-out switch only
const consent = await Joryio.getTrackingConsent(); // 'granted' | 'denied' | 'pending'
```

With nothing decided and nothing stored, `getTrackingConsent()` answers `'granted'` - the state the SDK runs in - on both platforms.

`wipeData()` erases everything the device holds for the current person - identity, queued events, pending writes, in-app state, session, device id and push token - and unregisters the token on the server. The opt-out is kept. Push stays off until `registerPushToken()` or a permission grant.

An opt-out is stored on the device and survives restarts. To decide before anything is sent, pass consent to `initialize()`:

```typescript
await Joryio.initialize(sdkKey, apiHost, { trackingConsent: 'pending' });

// later, from your consent prompt
Joryio.updateConsent('granted'); // 'granted' | 'denied' | 'pending'
```

- Leave `trackingConsent` unset unless your banner has an answer for this launch. Unset, with nothing stored, behaves as `granted`; a `denied` stored by an earlier launch stays in force.
- `denied` is stored on the device and survives restarts. Only `updateConsent('granted')` or an explicit `trackingConsent: 'granted'` lifts it.
- `pending` applies to this launch only and never replaces a stored `denied`. While consent is `pending` nothing is sent: events and attribute changes wait on the device (up to `maxQueueSize`), and there is no session start, in-app sync or push registration. `updateConsent('granted')` sends what waited; `updateConsent('denied')` discards it.
- `optOut: true` at `initialize()` starts the SDK opted out; `optOut: false` does not undo an earlier `optOut()` - call `optIn()`.
- If your app already knows the answer when it starts - a banner choice it stored itself, for example - pass it as `trackingConsent` to `initialize()` instead of calling `updateConsent()` after it, so the SDK starts with that answer in force. Letter case does not matter (`'Denied'` is read as `'denied'`); an unknown value is ignored with a warning and consent stays unset.

`optOut()`, `optIn()`, `updateConsent()` and `wipeData()` can be called before `initialize()`, and they are applied first: no session start, in-app sync or push registration goes out before them. Calls made earlier that collect data - events, attributes, aliases, subscription changes - are dropped by an `optOut()`, `updateConsent('denied')` or `wipeData()` that follows them. Calls like these made while opted out or denied - before `initialize()` too, whether the decision was made in this launch or stored by an earlier one - are dropped as well, and a later `optIn()` or `updateConsent('granted')` does not send them. `identify` is dropped only by `wipeData()`. An earlier `setSdkAuthenticationToken()` is never carried over to the next visitor: on iOS and Android alike the wipe keeps it only for the erased person's own withdrawals, or drops it. After an `optOut()` or a denial the user id is kept on the device, unsent, only so that an unsubscribe reaches the right person. Withdrawals are the exception: `setSubscription(channel, 'unsubscribed')`, `removeFromSubscriptionGroup` and `unregisterPush()` made earlier are kept and sent.

`setAttributes({ nickname: null })` and `setAttribute('nickname', null)` unset the attribute, the same as `unsetAttribute('nickname')`.

## SDK authentication (optional)

```typescript
await Joryio.initialize(sdkKey, 'api-eu1.joryio.com', {
  enableSdkAuthentication: true,
  sdkAuthenticationToken: initialToken,
});

const stop = Joryio.onSdkAuthenticationError(async (error) => {
  // error.reason: 'missing' | 'invalid' | 'expired' | 'sub_mismatch' | 'unknown'
  // error.refreshExhausted: true once the SDK has stopped retrying this request
  Joryio.setSdkAuthenticationToken(await fetchFreshToken());
});
```

With SDK authentication on, a request that carries a user id must carry a JWT your backend minted for that user; calls for anonymous visitors are accepted without one.

## API reference

| Area | Methods |
|------|---------|
| Setup | `initialize(sdkKey, apiHost, config?)` |
| Events | `track(eventName, properties?)`, `trackScreen(screenName, properties?)`, `flush()` |
| Identity | `identify(userId)`, `addAlias(aliasLabel, aliasName)`, `reset()`, `getUserId()`, `getAnonymousId()`, `getSessionId()` |
| Attributes | `setAttributes(attributes)`, `setAttribute(key, value)`, `incrementAttribute(key, by?)`, `unsetAttribute(key)` |
| Push | `registerPushToken(token)`, `unregisterPush()`, `isPushEnabled()`, `getPushPermissionStatus()`, `requestPushPermission()`, `reportPushDelivered(trackingId)`, `trackPushClick(trackingId)` |
| In-app | `onInAppMessage(callback, options?)`, `enableInAppMessages(capabilities?)`, `disableInAppMessages()`, `trackInAppImpression(campaignId, action, elementId?)`, `submitInAppForm(campaignId, values)`, `syncInAppCampaigns()`, `resetDisplayedCampaigns()` |
| Consent | `optOut()`, `optIn()`, `isUserOptedOut()`, `getTrackingConsent()`, `updateConsent(consent)`, `wipeData()` |
| Subscriptions | `setSubscription(channel, status)`, `addToSubscriptionGroup(groupId, channel)`, `removeFromSubscriptionGroup(groupId, channel)` |
| SDK authentication | `setSdkAuthenticationToken(token)`, `onSdkAuthenticationError(callback)` |
| E-commerce | `Joryio.ecommerce.*` (also exported as `ecommerce`) |
| Diagnostics | `getDiagnostics()` - the API endpoint in use and the last transport error |

The getters return promises, wait for `initialize()` (up to 5 seconds) and never reject: without a linked native module or a completed `initialize()` they resolve a default (`false`, `null`, `''` or `'unavailable'`). After a failed `initialize()` they resolve that default at once. `isUserOptedOut()` and `getTrackingConsent()` are different: while `initialize()` is running they wait for it, and otherwise they answer at once from what is stored on the device - before `initialize()` and after a failed one too - so an opt-out or a `denied` from an earlier launch reads as such straight away.

## Testing with Jest

The package's `main` is compiled JavaScript, so your Jest setup needs no `transformIgnorePatterns` entry for it. Mock the native module the way you mock any other, or leave it unmocked: without `NativeModules.JoryioModule` every call is a no-op.

## Documentation

- [React Native SDK guide](https://docs.joryio.com/developers/sdk/react-native-sdk)
- [iOS SDK guide](https://docs.joryio.com/developers/sdk/ios-sdk) and [Android SDK guide](https://docs.joryio.com/developers/sdk/android-sdk) for platform details
- [Tracking events](https://docs.joryio.com/developers/sdk/tracking-events)
- [Changelog](./CHANGELOG.md)

## Support

- Issues: https://github.com/joryio/joryio-react-native-sdk/issues
- Email: support@joryio.com

## License

Commercial - see [LICENSE](./LICENSE). Use of the SDK requires an active Joryio subscription or agreement.
