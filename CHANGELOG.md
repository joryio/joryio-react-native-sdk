# Changelog

## 1.3.1 - 2026-10-24

Changed: on iOS the bridge now takes the Joryio iOS SDK as a Swift package (`https://github.com/joryio/joryio-ios-sdk.git`, products `Joryio` and `JoryioUI`, pinned to exactly this version) through React Native's `spm_dependency`, instead of the `Joryio` CocoaPods pod. `pod install` works as before; Xcode resolves the package when the app builds.

- Requires React Native 0.75 or newer (the peer dependency is now `>=0.75.0`). On older React Native, `pod install` stops with an error that says so.
- On React Native 0.75-0.86, the Pods project that `pod install` writes could be reported by Xcode as damaged (a duplicated object id in React Native's Swift package support); the bridge applies the fix React Native 0.87 ships.
- On React Native 0.87 and newer, React Native moves the module map of a pod that uses a Swift package and then looks for it under the pod name, which differs from this module's name; the bridge points the app at the moved file (without it the app does not compile: "module map file '.../joryio-react-native/joryio_react_native.modulemap' not found").
- `JORYIO_IOS_SDK_SPM_URL`, set before `pod install`, builds the native SDK from another git URL (or a local path on React Native 0.84+) - for SDK development only.

No JavaScript API changes. Android is unchanged.

## 1.3.0 - 2026-10-06

First public release.
