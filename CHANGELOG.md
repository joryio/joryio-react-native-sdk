# Changelog

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
