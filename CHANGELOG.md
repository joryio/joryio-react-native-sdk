# Changelog

## 1.4.0 - 2026-11-18

Added: `resetTo(anonymousId)`, bound on both bridges to the native `resetTo` (the native SDK checks the id) - everything `reset()` does, then the anonymous id you pass instead of a random one, for an app that keeps its own visitor id (BACKLOG D366). The id must be 8 to 255 letters, digits, `.`, `_`, `:` or `-`, must not have the shape of a Joryio profile id (24 lowercase hex) and must not be the user id the SDK holds; a refused id is logged and the call is a plain `reset()` (a random id), so a logout is never skipped. The same name and rule on all five SDKs. No wire changes: the server sees an ordinary anonymous id. Like `reset()`, `resetTo` drops a click-link token the SDK has not sent yet (one held while consent is pending), so the link is never attributed to the next person on the device.

Changed (BACKLOG D366, before any release of resetTo): it also refuses the anonymous id the SDK holds while a user is signed in - that id is tied to the signed-in person's profile, and adopting it would hand their in-app messages, events, form attribution and push subscription to the next person on a shared device (a random id is used instead). `resetTo` returns `Promise<boolean>`: `true` adopted, `false` refused; both bridges resolve the native answer. The same on all five SDKs.

Changed (BACKLOG D366): `resetTo` also refuses the last 20 anonymous ids this device held for a signed-in user when a reset signed them out (stored locally, newest kept; `wipeData()` forgets them) - a random id is used and it answers `false`, the same message and cap on all five SDKs. A `resetTo` held before `initialize()` and discarded before it runs (pushed out of a full hold) now resolves `false` instead of never settling; the native SDKs answer the same way.

Added: `identifyFromLink(url)`, bound on both bridges to the native `identifyFromLink` (the url is passed through unchanged; native reads the token and applies the rules) - click-link identity. Pass the URL from `Linking.getInitialURL()` and `Linking.addEventListener('url', ...)`; when it carries the `jr_t` token a tracked Joryio message link adds, the native SDK sends it to `POST /v1/identify-link`. The server uses it only to attribute this app's session and later events (Session Start, screen views, conversions) to the contact the message was sent to - it never identifies the person: the app's profile does not become the contact and is never merged into it, and nothing set in the app is written to the contact. Only `identify` joins the two. Held before `initialize()` like other data calls. Nothing happens when a user is identified, the person opted out or consent is denied; while consent is pending the token is held in memory and sent on `'granted'`. The same name, parameter, path and body on all five SDKs.

## 1.3.3 - 2026-11-03

Fixed (from the iOS and Android SDKs this bridge uses): an in-app message the native SDK draws counts as displayed only once someone could have seen it. It is shown only on a screen that is in the foreground and not mid-transition or closing, and `in_app.displayed` is reported - and the campaign's frequency cap spent - only after it has been on screen for `IN_APP_DISPLAY_DWELL_MS` (1000 ms) with the app in the foreground. A tap or a close before then counts as seen (displayed first, then the click or dismissal); a message that leaves the screen sooner is not counted and stays eligible. Before, a message drawn during a screen change was counted and could use up its cap unseen.

Added: `IN_APP_DISPLAY_DWELL_MS` is exported. If your app draws in-app messages itself (`onInAppMessage`), report `'displayed'` by the same rule - see `trackInAppImpression`. No bridge or wire changes.

## 1.3.2 - 2026-10-25

Fixed: an app that subscribes with `onInAppMessage` could get its first in-app message drawn by the native SDK. The subscription is held until `initialize()` completes, and the sync native `initialize()` starts could finish first - seen on Android, where clicks and forms on that message then went through native-only paths; the same window existed on iOS. The SDK now always asks native to hold in-app messages at `initialize()`, and ends the hold once `initialize()` has completed and the held calls have run: your listener takes the held message, or, with nobody subscribed, the native SDK draws it. No message is drawn twice or lost.

Added: `holdInAppMessagesForHandler` in the `initialize()` config, for an app that subscribes AFTER `initialize()` has completed (a screen that mounts later): messages ready before the subscription are held for it. `disableInAppMessages()` instead lets the native SDK draw them. The same option, by the same name, on iOS, Android and Unity.

## 1.3.1 - 2026-10-24

Changed: on iOS the bridge now takes the Joryio iOS SDK as a Swift package (`https://github.com/joryio/joryio-ios-sdk.git`, products `Joryio` and `JoryioUI`, pinned to exactly this version) through React Native's `spm_dependency`, instead of the `Joryio` CocoaPods pod. `pod install` works as before; Xcode resolves the package when the app builds.

- Requires React Native 0.75 or newer (the peer dependency is now `>=0.75.0`). On older React Native, `pod install` stops with an error that says so.
- On React Native 0.75-0.86, the Pods project that `pod install` writes could be reported by Xcode as damaged (a duplicated object id in React Native's Swift package support); the bridge applies the fix React Native 0.87 ships.
- On React Native 0.87 and newer, React Native moves the module map of a pod that uses a Swift package and then looks for it under the pod name, which differs from this module's name; the bridge points the app at the moved file (without it the app does not compile: "module map file '.../joryio-react-native/joryio_react_native.modulemap' not found").
- `JORYIO_IOS_SDK_SPM_URL`, set before `pod install`, builds the native SDK from another git URL (or a local path on React Native 0.84+) - for SDK development only.

Added: `maxWidth` on HTML `InAppMessage` objects (modal and slide-up; modal 600 and slide-up 400 when the server sends none), forwarded by both native bridges. If you draw messages yourself with `Joryio.onInAppMessage()`, give your web view min(maxWidth, screen width - your margins) before the content lays out, and measure the height from `document.body` (with `body{display:flow-root}`), not the root element - the root never reports less than the web view's own height, so a message sized from it can grow but never shrink.

Fixed (through the native SDKs, which draw messages when no `onInAppMessage` handler is set): HTML in-app messages did not work on Android since 1.3.0, and native HTML modals and slide-ups could grow but never shrink. See the iOS and Android release notes.

No other JavaScript API changes.

## 1.3.0 - 2026-10-06

First public release.
