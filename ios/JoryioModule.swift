import Foundation
import UserNotifications
// RCTEventEmitter, RCTPromiseResolveBlock and friends live in React-Core. The
// podspec already depends on it, but a Swift file still has to import the
// module - without this the whole bridge fails to compile with "cannot find
// type 'RCTEventEmitter' in scope", which is what happened here: iOS had never
// been built for either demo app, so nothing had ever compiled this file.
import React
// attachCardFeedListener is SDK-internal (SPI): apps use onCardsUpdated.
@_spi(JoryioInternal) import Joryio

/// React Native bridge for the Joryio iOS SDK.
/// Each method delegates to the native `Joryio.shared` singleton using its
/// real public API (see sdk-ios `JoryioSDK.swift`).
@objc(JoryioModule)
class JoryioModule: RCTEventEmitter {

  /// The prefix the native SDK requires of an iOS SDK key (it refuses any
  /// other). Checked here so a wrong key rejects initialize() instead of
  /// resolving into an SDK that sends nothing.
  private static let sdkKeyPrefix = "jry_sdk_ios_"

  private var hasListeners = false
  /// True while in-app messages are handed to JS instead of drawn natively.
  private var inAppHandedToJS = false

  /// The module whose callbacks the native SDK currently holds (contract item
  /// 18). Only that module may release them: on a reload the new module can
  /// install its own before the old one is torn down, and a blind clear would
  /// take the NEW one away. An ObjectIdentifier rather than a weak reference,
  /// because a weak reference already reads nil inside `deinit`.
  private enum NativeCallback { case inApp, auth, link }
  private static var owners: [NativeCallback: ObjectIdentifier] = [:]
  private static let ownerLock = NSLock()

  /// Clears `callback`'s owner when this module holds it; true if it did.
  private func releaseOwnership(_ callback: NativeCallback) -> Bool {
    Self.ownerLock.lock()
    defer { Self.ownerLock.unlock() }
    guard Self.owners[callback] == ObjectIdentifier(self) else { return false }
    Self.owners[callback] = nil
    return true
  }

  private func takeOwnership(_ callback: NativeCallback) {
    Self.ownerLock.lock()
    Self.owners[callback] = ObjectIdentifier(self)
    Self.ownerLock.unlock()
  }

  /// Hand the native callbacks back when this module goes away - a reload, a
  /// dev-menu refresh, React Native tearing down. The callbacks capture `self`
  /// weakly, so once the module is gone they silently RETURN: every in-app
  /// message was then "handed to JS" and dropped, with no native rendering
  /// either, until the next process start.
  private func releaseNativeCallbacks() {
    // This module's flags subscription (BACKLOG D446) goes with it.
    flagsSubscription?.cancel()
    flagsSubscription = nil
    if releaseOwnership(.inApp) {
      inAppHandedToJS = false
      Joryio.shared.clearInAppMessageCallback()
    }
    if releaseOwnership(.auth) {
      Joryio.shared.clearSdkAuthenticationErrorHandler()
    }
    // The link handler forwards to THIS module's JS; without it links open natively again.
    if releaseOwnership(.link) {
      Joryio.shared.clearLinkHandler()
    }
    releasePendingLinks()
    // This module's card feed listener (D444 Phase 3); a reload's new module installs its own.
    cardsSubscription?.cancel()
    cardsSubscription = nil
  }

  override func invalidate() {
    releaseNativeCallbacks()
    super.invalidate()
  }

  deinit {
    releaseNativeCallbacks()
  }

  // `requiresMainQueueSetup` is declared in JoryioModule.m (the RCT_EXTERN
  // category) to avoid a duplicate Objective-C selector definition.

  override func supportedEvents() -> [String]! {
    return ["JoryioInAppMessage", "JoryioSdkAuthError", "JoryioPlacementsUpdated", "JoryioCardsUpdated", "JoryioLink", "JoryioFlagsUpdated"]
  }

  override func startObserving() {
    hasListeners = true
  }

  override func stopObserving() {
    hasListeners = false
    // Every JS listener is gone, so nobody can draw a handed-off message: give
    // rendering back to the native SDK. The JS layer asks for this itself when
    // its last onInAppMessage listener unsubscribes; this covers a listener
    // removed some other way (removeAllListeners, a reload).
    if inAppHandedToJS, releaseOwnership(.inApp) {
      inAppHandedToJS = false
      Joryio.shared.clearInAppMessageCallback()
    }
  }

  // MARK: - Initialization

  // Every String / NSDictionary parameter is OPTIONAL (contract item 19): a JS
  // null arrives as nil, and a nil in a non-optional parameter is undefined
  // behaviour in Swift - at best a crash. The JS layer checks first; this is
  // the second line of defence. A null CONFIG VALUE arrives as NSNull, which
  // every `as?` below reads as "not set", so the native default applies.
  @objc func initialize(
    _ sdkKey: String?,
    apiHost: String?,
    config: NSDictionary?,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard let sdkKey, !sdkKey.isEmpty, let apiHost, !apiHost.isEmpty else {
      reject("INIT_ERROR", "initialize() needs a non-empty sdkKey and apiHost", nil)
      return
    }
    // A key the native SDK would refuse is refused HERE, with the prefix the
    // native SDK checks (the Android bridge does the same). This is the ONLY
    // refusal: anything else resolves - see the comment at the native call.
    guard sdkKey.hasPrefix(Self.sdkKeyPrefix) else {
      reject(
        "INIT_ERROR",
        "initialize() was refused: iOS SDK keys start with '\(Self.sdkKeyPrefix)'. "
          + "Copy your SDK key from the Joryio dashboard.",
        nil
      )
      return
    }
    let config: NSDictionary = config ?? [:]
    // JoryioConfig is an immutable struct — build it via its initializer
    // rather than mutating fields (which are `let`).
    let enableDebug = config["enableDebug"] as? Bool ?? false

    let logLevel: JoryioConfig.LogLevel = {
      // Lower-cased: 'Warn' matched no case here while Android upper-cases.
      if let raw = config["logLevel"] as? String,
         let level = JoryioConfig.LogLevel(rawValue: raw.lowercased()) {
        return level
      }
      return enableDebug ? .debug : .error
    }()

    let batchSize = config["batchSize"] as? Int ?? ConfigDefaults.batchSize
    // JS sends milliseconds; the iOS SDK expects seconds.
    let flushInterval = (config["flushInterval"] as? Double).map { $0 / 1000.0 }
      ?? ConfigDefaults.flushInterval
    let sessionTimeout = (config["sessionTimeout"] as? Double).map { $0 / 1000.0 }
      ?? ConfigDefaults.sessionTimeout
    let trackSessionStart = config["trackSessionStart"] as? Bool ?? true
    // Opt-in auto-prompt; see JoryioConfig.requestPushPermissionAtLaunch.
    let requestPushPermissionAtLaunch = config["requestPushPermissionAtLaunch"] as? Bool ?? false
    let userId = config["userId"] as? String

    // Four options the native SDKs honour that this bridge dropped on the
    // floor (audit 2026-09-26, D26): a JS app setting any of them got the
    // native default and no error. Same names as native; `requestTimeout`
    // follows flushInterval - JS sends milliseconds, iOS wants seconds.
    let anonymousId = config["anonymousId"] as? String
    let sendImmediately = config["sendImmediately"] as? Bool ?? false
    let maxQueueSize = config["maxQueueSize"] as? Int ?? ConfigDefaults.maxQueueSize
    let requestTimeout = (config["requestTimeout"] as? Double).map { $0 / 1000.0 }
      ?? ConfigDefaults.requestTimeout

    // Optional SDK authentication (opt-in). Mirrors the sdk-ios
    // JoryioConfig fields; both default off/nil so behaviour is unchanged.
    let enableSdkAuthentication = config["enableSdkAuthentication"] as? Bool ?? false
    let sdkAuthenticationToken = config["sdkAuthenticationToken"] as? String

    // In-app: HTML messages render in a web view that can execute script (the
    // SDK's own bridge runs there), so this is opt-in and OFF by default. The
    // server keeps the markup as written; author <script> and on* handlers do
    // not run because sdk-ios shows the document under `script-src 'none'`
    // with the bridge injected outside it. The Android bridge already forwarded
    // it; without this arm the same JS config silently did nothing on iOS and
    // an app that opted in still had every HTML campaign skipped.
    let allowHtmlJsInAppMessages = config["allowHtmlJsInAppMessages"] as? Bool ?? false
    // Sent by the JS layer on EVERY initialize(): native holds in-app messages
    // until JS has had its chance to subscribe, so the first sync can no
    // longer draw natively the message an onInAppMessage app meant to draw
    // itself. JS ends the hold with enableInAppMessages (its listener takes
    // the message) or disableInAppMessages (nobody listens; native draws it).
    // Same key as the Android bridge.
    let holdInAppMessagesForHandler = config["holdInAppMessagesForHandler"] as? Bool ?? false
    // iOS only (Android routes verified App Links itself): an https link on
    // one of the app's associated domains goes to its own universal-link
    // handling instead of Safari. Same key as Unity's ForwardUniversalLinks.
    let forwardUniversalLinks = config["forwardUniversalLinks"] as? Bool ?? false

    // Consent and opt-out at start-up, the same options every Joryio SDK takes.
    // Missing here, so an RN app could only opt out AFTER initialize() - by
    // which time the session start had been sent.
    let optOut = config["optOut"] as? Bool ?? false
    // UNSET unless JS set it (consent model A, contract item 24): an unset
    // consent keeps a denial stored by an earlier launch, while an explicit
    // `.granted` lifts it. This used to fill in `.granted` for every app that
    // passed nothing, which made the default config an explicit grant.
    var trackingConsent: JoryioConfig.TrackingConsent?
    if let raw = config["trackingConsent"] as? String {
      if let parsed = JoryioConfig.TrackingConsent(rawValue: raw) {
        trackingConsent = parsed
      } else {
        NSLog("[Joryio] Unknown trackingConsent '\(raw)' - ignored")
      }
    }

    // Two forms, so an unset consent is left OUT and the native SDK's own
    // "unset" default applies rather than a value chosen here.
    let joryioConfig: JoryioConfig
    if let trackingConsent {
      joryioConfig = JoryioConfig(
        userId: userId,
        anonymousId: anonymousId,
        batchSize: batchSize,
        flushInterval: flushInterval,
        sendImmediately: sendImmediately,
        maxQueueSize: maxQueueSize,
        sessionTimeout: sessionTimeout,
        trackSessionStart: trackSessionStart,
        requestPushPermissionAtLaunch: requestPushPermissionAtLaunch,
        inApp: InAppConfig(
          allowHtmlJsInAppMessages: allowHtmlJsInAppMessages,
          holdInAppMessagesForHandler: holdInAppMessagesForHandler
        ),
        requestTimeout: requestTimeout,
        enableSdkAuthentication: enableSdkAuthentication,
        sdkAuthenticationToken: sdkAuthenticationToken,
        optOut: optOut,
        trackingConsent: trackingConsent,
        enableDebug: enableDebug,
        logLevel: logLevel,
        forwardUniversalLinks: forwardUniversalLinks
      )
    } else {
      joryioConfig = JoryioConfig(
        userId: userId,
        anonymousId: anonymousId,
        batchSize: batchSize,
        flushInterval: flushInterval,
        sendImmediately: sendImmediately,
        maxQueueSize: maxQueueSize,
        sessionTimeout: sessionTimeout,
        trackSessionStart: trackSessionStart,
        requestPushPermissionAtLaunch: requestPushPermissionAtLaunch,
        inApp: InAppConfig(
          allowHtmlJsInAppMessages: allowHtmlJsInAppMessages,
          holdInAppMessagesForHandler: holdInAppMessagesForHandler
        ),
        requestTimeout: requestTimeout,
        enableSdkAuthentication: enableSdkAuthentication,
        sdkAuthenticationToken: sdkAuthenticationToken,
        optOut: optOut,
        enableDebug: enableDebug,
        logLevel: logLevel,
        forwardUniversalLinks: forwardUniversalLinks
      )
    }

    DispatchQueue.main.async {
      // Forward SDK-authentication rejections to JS via the event emitter so the
      // RN layer can mint a fresh token and call setSdkAuthenticationToken.
      // Harmless when SDK auth is disabled (the handler simply never fires).
      //
      // Installed BEFORE initialize(), through the native SDK's pre-init path:
      // the native SDK may DEFER its initialization (a launch before the first
      // unlock since boot) and run it later, when protected data becomes
      // available. A handler held for init is applied then; one installed
      // after a deferred initialize() would never have been registered.
      self.takeOwnership(.auth)
      Joryio.shared.setSdkAuthenticationErrorHandler { [weak self] authError in
        self?.emitSdkAuthError(authError)
      }

      // Every request names this bridge and its version (D427):
      // X-Joryio-SDK-Wrapper: react-native + X-Joryio-SDK-Wrapper-Version.
      // The JS layer sends its package version on every initialize().
      if let wrapperVersion = config["sdkWrapperVersion"] as? String {
        Joryio.setSdkWrapper(name: "react-native", version: wrapperVersion)
      }
      Joryio.shared.initialize(sdkKey: sdkKey, apiHost: apiHost, config: joryioConfig)

      // Resolved even when the native SDK has not started YET. Before the
      // first unlock since boot it defers its initialization
      // (`isInitializationPending`) and finishes it on unlock, holding every
      // call made meanwhile - so this is not a failure (contract v4 47). This
      // used to reject whenever `currentApiEndpoint` was nil, which a deferred
      // init also is: JS then marked the SDK failed and dropped every call for
      // the whole process, although native would have started a moment later.
      // The real refusals (no key, no host, a key without the iOS prefix) are
      // rejected above, before anything starts.
      if Joryio.shared.isInitializationPending {
        NSLog("[Joryio] initialize(): the device has not been unlocked since it started; the SDK starts at the first unlock and holds every call until then")
      }
      resolve(nil)
    }
  }

  // MARK: - Event Tracking

  /// Logs and answers false for a missing required string argument.
  private func present(_ caller: String, _ name: String, _ value: String?) -> Bool {
    if let value, !value.isEmpty { return true }
    NSLog("[Joryio] \(caller)() needs a non-empty \(name) - ignored")
    return false
  }

  @objc func track(_ eventName: String?, properties: NSDictionary?) {
    guard present("track", "eventName", eventName), let eventName else { return }
    let props = properties as? [String: Any] ?? [:]
    Joryio.shared.track(eventName, properties: props)
  }

  @objc func trackScreen(_ screenName: String?, properties: NSDictionary?) {
    guard present("trackScreen", "screenName", screenName), let screenName else { return }
    let props = properties as? [String: Any] ?? [:]
    Joryio.shared.trackScreen(screenName, properties: props)
  }

  // MARK: - Identity

  @objc func identify(_ userId: String?) {
    guard present("identify", "userId", userId), let userId else { return }
    Joryio.shared.identify(userId)
  }

  /// A labelled alias (`crm_id` -> `C-1042`). Works before identify(): the
  /// native SDK sends it with the anonymous id. The unlabelled alias(userId) is
  /// gone from every SDK - identify() is how you name the current person.
  @objc func addAlias(_ aliasLabel: String?, aliasName: String?) {
    guard present("addAlias", "aliasLabel", aliasLabel), let aliasLabel,
          present("addAlias", "aliasName", aliasName), let aliasName else { return }
    Joryio.shared.addAlias(aliasLabel, name: aliasName)
  }

  /// Click-link identity: the URL that opened the app, passed through to the
  /// native SDK unchanged. Native reads `jr_t` and applies the rules
  /// (identified, opted out, consent, once per token).
  @objc func identifyFromLink(_ url: String?) {
    guard present("identifyFromLink", "url", url), let url, let parsed = URL(string: url) else { return }
    Joryio.shared.identifyFromLink(parsed)
  }

  @objc func reset() {
    Joryio.shared.reset()
  }

  /// Joryio.resetTo: reset(), then the caller's anonymous id (validated
  /// natively; a missing or refused id is a plain reset()). Resolves true
  /// when the id was adopted, false when it was refused.
  @objc func resetTo(_ anonymousId: String?, resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
    Joryio.shared.resetTo(anonymousId ?? "") { adopted in resolve(adopted) }
  }

  // MARK: - Tracking consent
  //
  // Tracking consent, NOT marketing subscription. optOut stops the SDK
  // collecting and sending; it does not unsubscribe anyone from email.
  //
  // Bridged because it was missing: web, Android, iOS and Unity all had these
  // and React Native had no consent surface at all. The native call already
  // records `tracking_opted_out` on the profile, so bridging is the whole fix.

  @objc func optOut() {
    Joryio.shared.optOut()
  }

  @objc func optIn() {
    Joryio.shared.optIn()
  }

  /// Erase this device's data for the current person and unregister its push
  /// token on the server; the opt-out is kept (same on every Joryio SDK).
  @objc func wipeData() {
    Joryio.shared.wipeData()
  }

  @objc func isUserOptedOut(_ resolve: @escaping RCTPromiseResolveBlock,
                            rejecter reject: @escaping RCTPromiseRejectBlock) {
    resolve(Joryio.shared.isUserOptedOut())
  }

  /// The current tracking consent ('granted' | 'denied' | 'pending'), separate
  /// from the opt-out that isUserOptedOut reports. Safe before initialize().
  @objc func getTrackingConsent(_ resolve: @escaping RCTPromiseResolveBlock,
                                rejecter reject: @escaping RCTPromiseRejectBlock) {
    resolve(Joryio.shared.getTrackingConsent().rawValue)
  }

  /// 'granted' releases what was held while consent was pending; 'denied'
  /// discards it; 'pending' holds for this launch. Made before initialize(),
  /// the native SDK records it and applies it inside init.
  @objc func updateConsent(_ consent: String?) {
    guard let consent, let parsed = JoryioConfig.TrackingConsent(rawValue: consent) else {
      NSLog("[Joryio] updateConsent: unknown value '\(consent ?? "null")' - ignored")
      return
    }
    Joryio.shared.updateConsent(parsed)
  }

  // MARK: - Marketing subscription
  //
  // A DIFFERENT consent from optIn/optOut above: that is whether we may
  // OBSERVE, this is whether we may MESSAGE.

  @objc func setSubscription(_ channel: String?, status: String?) {
    guard present("setSubscription", "channel", channel), let channel,
          present("setSubscription", "status", status), let status else { return }
    Joryio.shared.setSubscription(channel: channel, status: status)
  }

  @objc func addToSubscriptionGroup(_ groupId: String?, channel: String?) {
    guard present("addToSubscriptionGroup", "groupId", groupId), let groupId,
          present("addToSubscriptionGroup", "channel", channel), let channel else { return }
    Joryio.shared.addToSubscriptionGroup(groupId, channel: channel)
  }

  @objc func removeFromSubscriptionGroup(_ groupId: String?, channel: String?) {
    guard present("removeFromSubscriptionGroup", "groupId", groupId), let groupId,
          present("removeFromSubscriptionGroup", "channel", channel), let channel else { return }
    Joryio.shared.removeFromSubscriptionGroup(groupId, channel: channel)
  }

  // MARK: - Attributes

  /// A null value UNSETS that attribute, the same as on Android. The JS layer
  /// already splits nulls out; this is the guard for anything that reaches the
  /// bridge directly. It used to forward NSNull as if it were a value.
  @objc func setAttributes(_ attributes: NSDictionary?) {
    guard let attrs = attributes as? [String: Any] else {
      NSLog("[Joryio] setAttributes() needs a map of attributes - ignored")
      return
    }
    var values: [String: Any] = [:]
    var unset: [String] = []
    for (key, value) in attrs {
      if value is NSNull { unset.append(key) } else { values[key] = value }
    }
    if !values.isEmpty { Joryio.shared.setAttributes(values) }
    unset.forEach { Joryio.shared.unsetAttribute($0) }
  }

  @objc func setAttribute(_ key: String?, value: Any?) {
    guard present("setAttribute", "key", key), let key else { return }
    guard let value, !(value is NSNull) else {
      Joryio.shared.unsetAttribute(key)
      return
    }
    Joryio.shared.setAttribute(key, value: value)
  }

  /// `by` is untyped so a JS null reaches us at all - a `nonnull NSNumber`
  /// made React Native refuse the call. Null means the default step, 1.
  @objc func incrementAttribute(_ key: String?, by: Any?) {
    guard present("incrementAttribute", "key", key), let key else { return }
    let step: Double
    switch by {
    case nil, is NSNull: step = 1
    case let n as NSNumber: step = n.doubleValue
    default:
      NSLog("[Joryio] incrementAttribute('\(key)') needs a number to add - ignored")
      return
    }
    Joryio.shared.incrementAttribute(key, by: step)
  }

  @objc func unsetAttribute(_ key: String?) {
    guard present("unsetAttribute", "key", key), let key else { return }
    Joryio.shared.unsetAttribute(key)
  }

  // MARK: - Push

  @objc func reportPushDelivered(_ trackingId: String?) {
    guard present("reportPushDelivered", "trackingId", trackingId), let trackingId else { return }
    Joryio.shared.reportPushDelivered(trackingId)
  }

  /// Resolves with the native PushRegistrationResult. The single-arg form
  /// dropped it, so from JS a failed registration was indistinguishable from a
  /// successful one (Teamder, 2026-09-29).
  @objc func registerPushToken(
    _ token: String?,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard let token, !token.isEmpty else {
      resolve([
        "success": false,
        "message": "A push token is required",
        "isUnauthorized": false,
        "isRetryable": false,
      ])
      return
    }
    Joryio.shared.registerPushToken(token) { r in
      resolve([
        "success": r.success,
        "message": r.message.map { $0 as Any } ?? NSNull(),
        "isUnauthorized": r.isUnauthorized,
        "isRetryable": r.isRetryable,
      ])
    }
  }

  @objc func unregisterPush() {
    Joryio.shared.unregisterPush()
  }

  /// Show the system notification prompt, resolving the resulting status.
  ///
  /// Resolves a status string rather than a bare boolean so JS can tell "denied"
  /// from "we could not ask" - that difference decides whether showing a primer
  /// again is worth anything. Vocabulary matches the Android bridge.
  ///
  /// Opted out of tracking: the prompt is STILL shown, as on Android - whether
  /// the app may notify is the user's choice in the OS, not a tracking decision.
  /// It is asked for directly, so nothing registers or reports to Joryio. The
  /// native call skips the prompt while opted out, which left a JS primer
  /// reading `notDetermined` and asking again forever.
  @objc func requestPushPermission(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    Task {
      if Joryio.shared.isUserOptedOut() {
        _ = try? await UNUserNotificationCenter.current()
          .requestAuthorization(options: [.alert, .badge, .sound])
      } else {
        _ = await Joryio.shared.requestPushPermission()
      }
      resolve(await Joryio.shared.getPushPermissionStatus())
    }
  }

  @objc func getPushPermissionStatus(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    Task { resolve(await Joryio.shared.getPushPermissionStatus()) }
  }

  @objc func isPushEnabled(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    // isPushEnabled() is async on the iOS SDK — await it before resolving.
    Task {
      let enabled = await Joryio.shared.isPushEnabled()
      resolve(enabled)
    }
  }

  @objc func trackPushClick(_ trackingId: String?) {
    guard present("trackPushClick", "trackingId", trackingId), let trackingId else { return }
    Joryio.shared.trackPushClick(trackingId: trackingId)
  }

  // MARK: - E-commerce

  /// ONE bridge method, not nineteen - see the Android module for the reasoning.
  /// The canonical event names and purchase property keys live in the native
  /// tracker; rebuilding them in JS would be a fifth copy of a vocabulary that
  /// has no server-side alias layer, so a near-miss is stored verbatim and
  /// matches no report.
  ///
  /// The case list here MUST match the Android `when` and the JS surface. A spec
  /// compares all three, because nothing else can: three languages, none
  /// importing another.
  @objc func ecommerce(_ method: String?, payload: NSDictionary?) {
    guard present("ecommerce", "method", method), let method else { return }
    let p = payload as? [String: Any] ?? [:]

    // Every required argument is checked before anything is sent (contract
    // item 19). A missing one used to become a default - an empty orderId, a
    // zero total - so `purchase(null)` tracked an Order Completed worth
    // nothing instead of being refused. The JS layer checks first.
    func need(_ name: String, _ value: Any?) -> String? {
      if let text = value as? String, !text.isEmpty { return text }
      NSLog("[Joryio] ecommerce.\(method)() needs a non-empty \(name) - event NOT sent")
      return nil
    }
    func amount(_ name: String, _ value: Any?) -> Double? {
      if let n = value as? NSNumber, n.doubleValue.isFinite { return n.doubleValue }
      NSLog("[Joryio] ecommerce.\(method)() needs a number \(name) - event NOT sent")
      return nil
    }
    func product(_ key: String) -> EcommerceProduct? {
      guard let m = p[key] as? [String: Any], let id = m["productId"] as? String, !id.isEmpty else {
        NSLog("[Joryio] ecommerce.\(method)() needs a \(key) with a productId - event NOT sent")
        return nil
      }
      return Self.product(m)
    }
    /// Contract item 42: an order without an items array is not sent either,
    /// rather than recorded as an empty order.
    func orderItems(_ value: Any?) -> Bool {
      if value is [Any] { return true }
      NSLog("[Joryio] ecommerce.\(method)() needs an order with an items array - event NOT sent")
      return false
    }
    func items() -> [EcommerceCartItem]? {
      guard let raw = p["items"] as? [Any] else {
        NSLog("[Joryio] ecommerce.\(method)() needs an array of items - event NOT sent")
        return nil
      }
      return Self.cartItems(raw)
    }

    let tracker = Joryio.shared.ecommerce()

    switch method {
    case "viewProduct":
      guard let product = product("product") else { return }
      tracker.viewProduct(product)
    case "viewCategory":
      guard let id = need("categoryId", p["categoryId"]),
            let name = need("categoryName", p["categoryName"]) else { return }
      tracker.viewCategory(categoryId: id, categoryName: name)
    case "search":
      guard let query = need("query", p["query"]) else { return }
      tracker.search(query: query, resultCount: p["resultCount"] as? Int)
    case "addToCart":
      guard product("item") != nil else { return }
      tracker.addToCart(item: Self.cartItem(p["item"]), cartValue: p["cartValue"] as? Double)
    case "removeFromCart":
      guard let product = product("product") else { return }
      tracker.removeFromCart(product: product, quantity: p["quantity"] as? Int ?? 1)
    case "cartViewed":
      guard let items = items(), let value = amount("cartValue", p["cartValue"]) else { return }
      tracker.cartViewed(items: items, cartValue: value)
    case "updateCart":
      guard let items = items(), let value = amount("cartValue", p["cartValue"]) else { return }
      tracker.updateCart(items: items, cartValue: value)
    case "startCheckout":
      guard let items = items(), let value = amount("cartValue", p["cartValue"]) else { return }
      tracker.startCheckout(items: items, cartValue: value)
    case "addPaymentInfo":
      guard let paymentMethod = need("paymentMethod", p["paymentMethod"]) else { return }
      tracker.addPaymentInfo(paymentMethod: paymentMethod)
    case "purchase":
      guard let order = p["order"] as? [String: Any],
            need("order.orderId", order["orderId"]) != nil,
            orderItems(order["items"]),
            amount("order.value", order["value"]) != nil else { return }
      tracker.purchase(order: Self.order(order))
    case "orderFulfilled":
      guard let orderId = need("orderId", p["orderId"]) else { return }
      tracker.orderFulfilled(
        orderId: orderId,
        trackingNumber: p["trackingNumber"] as? String,
        carrier: p["carrier"] as? String)
    case "orderDelivered":
      guard let orderId = need("orderId", p["orderId"]) else { return }
      tracker.orderDelivered(orderId: orderId)
    case "orderCancelled":
      guard let orderId = need("orderId", p["orderId"]) else { return }
      tracker.orderCancelled(orderId: orderId, reason: p["reason"] as? String)
    case "orderRefunded":
      guard let orderId = need("orderId", p["orderId"]) else { return }
      tracker.orderRefunded(
        orderId: orderId,
        refundAmount: p["refundAmount"] as? Double,
        reason: p["reason"] as? String)
    case "addToWishlist":
      guard let product = product("product") else { return }
      tracker.addToWishlist(product: product)
    case "removeFromWishlist":
      guard let product = product("product") else { return }
      tracker.removeFromWishlist(product: product)
    case "shareProduct":
      guard let product = product("product"),
            let shareMethod = need("shareMethod", p["shareMethod"]) else { return }
      tracker.shareProduct(product: product, shareMethod: shareMethod)
    case "applyCoupon":
      guard let couponCode = need("couponCode", p["couponCode"]) else { return }
      tracker.applyCoupon(
        couponCode: couponCode,
        discountAmount: p["discountAmount"] as? Double,
        discountType: p["discountType"] as? String)
    case "removeCoupon":
      guard let couponCode = need("couponCode", p["couponCode"]) else { return }
      tracker.removeCoupon(couponCode: couponCode)
    case "submitReview":
      // Read as a Double on BOTH bridges, then converted the same way: `as?
      // Int` read 4.5 as 0 here (it fails on a fraction) while Android gave 4.
      // The native trackers take an Int rating, so a fraction is truncated
      // identically on both until they take a Double like the web SDK.
      guard let productId = need("productId", p["productId"]),
            let rating = amount("rating", p["rating"]) else { return }
      // Int(Double) TRAPS past Int.max - a crash of the host app from
      // `submitReview('p', Number(userInput))`. Refused instead, at the same
      // bound as Android (a 32-bit Int); the JS layer refuses it first.
      guard abs(rating) <= Double(Int32.max) else {
        NSLog("[Joryio] ecommerce.submitReview() needs a rating an Int can hold - event NOT sent")
        return
      }
      tracker.submitReview(
        productId: productId,
        rating: Int(rating),
        reviewText: p["reviewText"] as? String)
    default:
      // Loudly, not silently: a typo'd method name would otherwise be a no-op
      // that looks exactly like the SDK working.
      NSLog("[Joryio] Unknown ecommerce method '\(method)' - event NOT sent")
    }
  }

  private static func product(_ raw: Any?) -> EcommerceProduct {
    let m = raw as? [String: Any] ?? [:]
    return EcommerceProduct(
      productId: m["productId"] as? String ?? "",
      name: m["name"] as? String ?? "",
      price: m["price"] as? Double ?? 0,
      quantity: m["quantity"] as? Int,
      category: m["category"] as? String,
      brand: m["brand"] as? String,
      variant: m["variant"] as? String,
      variantId: m["variantId"] as? String,
      sku: m["sku"] as? String,
      imageUrl: m["imageUrl"] as? String,
      url: m["url"] as? String)
  }

  private static func cartItem(_ raw: Any?) -> EcommerceCartItem {
    let m = raw as? [String: Any] ?? [:]
    return EcommerceCartItem(
      productId: m["productId"] as? String ?? "",
      name: m["name"] as? String ?? "",
      price: m["price"] as? Double ?? 0,
      // Defaults to 1, not 0: a cart line with zero quantity has an item total
      // of zero, which is a silently wrong revenue number rather than an
      // obviously wrong one. Matches Android.
      quantity: m["quantity"] as? Int ?? 1,
      category: m["category"] as? String,
      brand: m["brand"] as? String,
      variant: m["variant"] as? String,
      variantId: m["variantId"] as? String,
      sku: m["sku"] as? String,
      imageUrl: m["imageUrl"] as? String,
      url: m["url"] as? String)
  }

  private static func cartItems(_ raw: Any?) -> [EcommerceCartItem] {
    guard let arr = raw as? [Any] else { return [] }
    // A null (NSNull) or non-object entry is SKIPPED, as the JS layer skips
    // it. Mapped to a line it had no productId, and the native tracker
    // refused the whole order because of it.
    return arr.compactMap { $0 as? [String: Any] }.map { cartItem($0) }
  }

  private static func order(_ raw: Any?) -> EcommerceOrder {
    let m = raw as? [String: Any] ?? [:]
    return EcommerceOrder(
      orderId: m["orderId"] as? String ?? "",
      items: cartItems(m["items"]),
      value: m["value"] as? Double ?? 0,
      currency: m["currency"] as? String,
      shipping: m["shipping"] as? Double,
      tax: m["tax"] as? Double,
      discount: m["discount"] as? Double,
      coupon: m["coupon"] as? String)
  }

  // MARK: - In-App Messaging

  /// Hand in-app messages to JS, exactly as the Android module does.
  ///
  /// This was a no-op, on a premise that had expired: the comment said the iOS
  /// SDK "renders natively, so there is no callback to forward", which was true
  /// when written. iOS later gained setInAppMessageCallback and the bridge was
  /// never updated - so onInAppMessage fired on Android and never on iOS, and
  /// one React Native app showed its own branded UI on Android and a
  /// native-styled dialog on iOS. The docs promised the first for both.
  ///
  /// THE PAYLOAD MUST MATCH ANDROID FIELD FOR FIELD, because the same
  /// JavaScript renders both. Two places where reflection would have been
  /// wrong, and silently:
  ///
  ///   - `deepLink` in Swift is `DEEP_LINK` in Kotlin, whose lowercased name is
  ///     `deep_link`. String(describing:) yields "deepLink", which no JS
  ///     renderer branches on - every deep-link button would quietly do nothing
  ///     on iOS only.
  ///   - MessageType is already a String enum with the right raw values, so it
  ///     uses rawValue rather than a second spelling of the same list.
  ///
  /// So the mapping is written out explicitly. It is longer, and it cannot
  /// drift into a wrong string without someone editing that string.
  @objc func enableInAppMessages(_ capabilities: NSArray?) {
    // What THIS app can render, declared from JS - see the Android module.
    // Null keeps the previous behaviour rather than asserting anything, and an
    // EMPTY list means the same as null (not declared), as on Android. It used
    // to reach the server as "this app can draw nothing".
    let filtered = (capabilities as? [String])?.filter { !$0.isEmpty } ?? []
    let declared: [String]? = filtered.isEmpty ? nil : filtered
    inAppHandedToJS = true
    takeOwnership(.inApp)

    Joryio.shared.setInAppMessageCallback({ [weak self] campaign in
      guard let self else { return }

      // RCTEventEmitter requires an active listener; matches emitSdkAuthError.
      // Deliberately checked BEFORE the content guard so the two reasons a
      // message is dropped stay distinguishable in the log.
      guard self.hasListeners else {
        NSLog("[Joryio] No JS listener for JoryioInAppMessage; dropping \(campaign.id)")
        return
      }

      guard let content = campaign.content else {
        // A campaign with no renderable document is DROPPED rather than emitted
        // with empty strings - JS would otherwise render a blank container the
        // user has to dismiss, and count an impression for it. Matches Android.
        NSLog("[Joryio] Campaign \(campaign.id) has no content; not emitting")
        return
      }

      var params: [String: Any] = [
        "id": campaign.id,
        "name": campaign.name,
        // Wire value, not the case name: JS types this as
        // 'modal' | 'banner' | 'slideup' | 'fullscreen' | 'custom'.
        "type": campaign.type.rawValue,
        "priority": campaign.priority,
      ]

      switch content {
      case let .html(html, css):
        params["kind"] = "html"
        params["html"] = html
        params["css"] = css
        // The resolved width cap (modal / slideup only); the host draws the
        // message, so it needs the number.
        if let maxWidth = campaign.maxWidth { params["maxWidth"] = maxWidth }

      case let .native(native):
        params["kind"] = "native"
        if let title = native.title { params["title"] = title }
        params["body"] = native.body
        if let imageUrl = native.imageUrl { params["imageUrl"] = imageUrl }
        params["closeButton"] = native.closeButton
        params["backdropDismissible"] = native.backdropDismissible

        // Author style overrides. Forwarded rather than applied: the HOST draws
        // the message, so resolving these here would compute the campaign's
        // colours and then throw them away.
        if let st = native.style {
          var style: [String: Any] = [:]
          if let v = st.backgroundColor { style["backgroundColor"] = v }
          if let v = st.textColor { style["textColor"] = v }
          if let v = st.primaryButtonColor { style["primaryButtonColor"] = v }
          if let v = st.primaryButtonTextColor { style["primaryButtonTextColor"] = v }
            if let v = st.cornerRadius { style["cornerRadius"] = v }
        if let v = st.fontSize { style["fontSize"] = v }
          if let v = st.titleWeight { style["titleWeight"] = v }
          if let v = st.textAlign { style["textAlign"] = v }
          if let v = st.fontFamily { style["fontFamily"] = v }
          params["style"] = style
        }

        params["buttons"] = native.buttons.map { b -> [String: Any] in
          var button: [String: Any] = [
            "id": b.id,
            "text": b.text,
            "action": Self.buttonActionWireValue(b.action),
          ]
          if let url = b.url { button["url"] = url }
          return button
        }
      }

      self.sendEvent(withName: "JoryioInAppMessage", body: params)
    }, capabilities: declared)
  }

  /// Hand in-app rendering back to the native SDK. The JS layer calls this
  /// when its last onInAppMessage listener unsubscribes; before it existed,
  /// messages kept being handed to JS and dropped for want of a listener, for
  /// the rest of the session.
  @objc func disableInAppMessages() {
    inAppHandedToJS = false
    _ = releaseOwnership(.inApp)
    Joryio.shared.clearInAppMessageCallback()
  }

  /// The wire spelling Android sends, written out rather than derived.
  ///
  /// Kotlin's DEEP_LINK.lowercase() is "deep_link"; Swift's `.deepLink`
  /// described is "deepLink". Deriving either from the case name produces a
  /// value the JS renderer does not branch on, on one platform only.
  private static func buttonActionWireValue(_ action: ButtonAction) -> String {
    switch action {
    case .dismiss: return "dismiss"
    case .url: return "url"
    case .deepLink: return "deep_link"
    case .requestPushPermission: return "request_push_permission"
    }
  }

  /// Report an impression for a message JS rendered.
  ///
  /// Also previously a no-op, and it could not stay one once the callback above
  /// works: the SDK cannot see a message it did not draw. Reporting
  /// `displayed` is what emits in_app.displayed AND spends the campaign's
  /// frequency budget (contract item 17); an unreported campaign reads as
  /// delivered to nobody and breaks revenue attribution.
  @objc func trackInAppImpression(_ campaignId: String?, action: String?, elementId: String?) {
    guard present("trackInAppImpression", "campaignId", campaignId), let campaignId,
          present("trackInAppImpression", "action", action), let action else { return }
    let element = (elementId?.isEmpty ?? true) ? nil : elementId
    Joryio.shared.trackInAppImpression(campaignId: campaignId, action: action, elementId: element)
  }

  /// A form inside an HTML message the app rendered itself. Resolves with the
  /// server's verdict ({ ok, message?, redirect?, errors? }) - never rejects,
  /// a failure is `ok: false`. Mirrors sdk-ios `Joryio.submitInAppForm`.
  @objc func submitInAppForm(_ campaignId: String?, values: NSDictionary?, resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
    guard present("submitInAppForm", "campaignId", campaignId), let campaignId else {
      resolve(["ok": false, "message": "Something went wrong. Please try again."])
      return
    }
    let dict = (values as? [String: Any]) ?? [:]
    Task {
      let r = await Joryio.shared.submitInAppForm(campaignId: campaignId, values: dict)
      var out: [String: Any] = ["ok": r.ok]
      if let m = r.message { out["message"] = m }
      if let u = r.redirect { out["redirect"] = u }
      if let e = r.errors { out["errors"] = e }
      if let why = r.reason { out["reason"] = why }
      resolve(out)
    }
  }

  // MARK: - SDK Authentication

  /// Supply/replace the customer-minted SDK-authentication JWT.
  /// Mirrors sdk-ios `Joryio.setSdkAuthenticationToken(_:)`.
  @objc func setSdkAuthenticationToken(_ token: String?) {
    guard present("setSdkAuthenticationToken", "token", token), let token else { return }
    Joryio.shared.setSdkAuthenticationToken(token)
  }

  /// Forward an SDK-authentication rejection to JS. Only emits when the JS side
  /// has an active listener (RCTEventEmitter requirement).
  private func emitSdkAuthError(_ authError: SdkAuthError) {
    guard hasListeners else { return }
    // All four fields, on both platforms. A JS handler is written once; it used
    // to receive {reason, endpoint, refreshExhausted} here and
    // {reason, rawReason} on Android, so half of any handler was silently dead
    // on whichever platform the developer had not tested.
    sendEvent(withName: "JoryioSdkAuthError", body: [
      "reason": authError.reason.rawValue,
      "rawReason": authError.rawReason as Any,
      "endpoint": authError.endpoint,
      "refreshExhausted": authError.refreshExhausted
    ])
  }

  // MARK: - Feature flags (BACKLOG D446)
  //
  // Every getter carries the app's key AND default to the native getter,
  // which answers value-or-default and logs the exposure as for a Swift
  // caller. getFlag and getJsonFlag resolve `{ value }`, so a JSON null stays
  // null in JS. Before initialize() the native getters answer the default.

  /// The one native subscription this module holds; cancelled in invalidate().
  private var flagsSubscription: JoryioSubscription?

  /// A JS null arrives as nil or NSNull: both mean "no default".
  private func flagDefault(_ value: Any?) -> Any? {
    value is NSNull ? nil : value
  }

  private func wrapFlagValue(_ value: Any?) -> [String: Any] {
    ["value": value ?? NSNull()]
  }

  @objc func getFlag(_ key: String?, defaultValue: Any?, resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
    let fallback = flagDefault(defaultValue)
    guard let key, !key.isEmpty else { resolve(wrapFlagValue(fallback)); return }
    resolve(wrapFlagValue(Joryio.shared.getFlag(key, default: fallback)))
  }

  @objc func getBoolFlag(_ key: String?, defaultValue: Bool, resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
    guard let key, !key.isEmpty else { resolve(defaultValue); return }
    resolve(Joryio.shared.getBoolFlag(key, default: defaultValue))
  }

  @objc func getStringFlag(_ key: String?, defaultValue: String?, resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
    let fallback = defaultValue ?? ""
    guard let key, !key.isEmpty else { resolve(fallback); return }
    resolve(Joryio.shared.getStringFlag(key, default: fallback))
  }

  @objc func getNumberFlag(_ key: String?, defaultValue: Double, resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
    guard let key, !key.isEmpty else { resolve(defaultValue); return }
    resolve(Joryio.shared.getNumberFlag(key, default: defaultValue))
  }

  @objc func getJsonFlag(_ key: String?, defaultValue: Any?, resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
    let fallback = flagDefault(defaultValue)
    guard let key, !key.isEmpty else { resolve(wrapFlagValue(fallback)); return }
    resolve(wrapFlagValue(Joryio.shared.getJsonFlag(key, default: fallback)))
  }

  /// Every flag held, key -> value. Logs no exposure.
  @objc func getAllFlags(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    resolve(Joryio.shared.getAllFlags())
  }

  /// Resolves once the answer is in (or the request failed: the held flags stay).
  @objc func refreshFlags(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    Joryio.shared.refreshFlags { resolve(nil) }
  }

  /// Start JoryioFlagsUpdated events (one native subscription; JS fans out).
  @objc func enableFlagsUpdates() {
    guard flagsSubscription == nil else { return }
    flagsSubscription = Joryio.shared.onFlagsUpdated { [weak self] keys in
      guard let self, self.hasListeners else { return }
      self.sendEvent(withName: "JoryioFlagsUpdated", body: ["keys": keys])
    }
  }

  // MARK: - Utilities

  @objc func flush() {
    Joryio.shared.flush()
  }

  @objc func getAnonymousId(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    resolve(Joryio.shared.getAnonymousId())
  }

  /// Fetch in-app campaigns now, and display any that are eligible.
  ///
  /// The SDK syncs on session start and on foreground; this is for the moments
  /// in between - after a reset, or after the user does something that should
  /// make them newly eligible. The RN bridge had no sync at all, so a React
  /// Native app could only wait for the next lifecycle event.
  @objc func syncInAppCampaigns() {
    Task { await Joryio.shared.syncInAppCampaigns() }
  }

  // MARK: - Placements (docs/PLACEMENTS_PLAN.md, D444)
  //
  // The native SDK does the work - fetching, caching, viewability rules,
  // reporting, the identity guard. The bridge hands the data to JS as JSON and
  // routes JS's mark* calls back to the native objects it last handed out, so
  // a report always goes through the native generation check.

  private var lastPlacements: [String: Placement] = [:]
  private let placementsLock = NSLock()
  private var placementsSubscription: JoryioSubscription?

  private func placementsJson(_ map: [String: Placement]) -> String {
    placementsLock.lock()
    for (k, p) in map { lastPlacements[k] = p }
    placementsLock.unlock()
    let dict = map.mapValues { $0.toJson() }
    guard let data = try? JSONSerialization.data(withJSONObject: dict), let text = String(data: data, encoding: .utf8) else { return "{}" }
    return text
  }

  @objc func getPlacements(_ keys: NSArray?, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    let list = (keys as? [Any])?.compactMap { $0 as? String } ?? []
    Joryio.shared.getPlacements(list) { [weak self] map in
      resolve(self?.placementsJson(map) ?? "{}")
    }
  }

  @objc func refreshPlacements(_ keys: NSArray?) {
    Joryio.shared.refreshPlacements((keys as? [Any])?.compactMap { $0 as? String })
  }

  @objc func enablePlacementsUpdates() {
    guard placementsSubscription == nil else { return }
    placementsSubscription = Joryio.shared.onPlacementsUpdated { [weak self] map in
      guard let self, self.hasListeners else { return }
      self.sendEvent(withName: "JoryioPlacementsUpdated", body: ["json": self.placementsJson(map)])
    }
  }

  @objc func disablePlacementsUpdates() {
    placementsSubscription?.cancel()
    placementsSubscription = nil
  }

  /// `action`: displayed | clicked | dismissed for an item, `control` for the holdout spot.
  @objc func markPlacement(_ placementKey: String?, itemId: String?, action: String?, elementId: String?) {
    guard let placementKey, let action else { return }
    placementsLock.lock()
    let placement = lastPlacements[placementKey]
    placementsLock.unlock()
    guard let placement else { return }
    if action == "control" {
      placement.markDisplayed()
      return
    }
    guard let item = placement.items.first(where: { $0.id == itemId }) else { return }
    switch action {
    case "displayed": item.markDisplayed()
    case "clicked": item.markClicked(elementId: (elementId?.isEmpty ?? true) ? nil : elementId)
    case "dismissed": item.markDismissed()
    default: break
    }
  }

  // MARK: - Content cards (docs/PLACEMENTS_PLAN.md section 11, D444 Phase 3)
  //
  // The native SDK does the work - fetching, caching, the rate limit, the
  // anonymous visitor's device state, reporting, the identity guard. The
  // bridge hands the feed to JS as JSON (CardFeed.toJson, no delivery tokens)
  // and routes JS's reports back to the native Card values it last handed
  // out, so a report carries the card's own token and a card of a person who
  // is no longer here is dropped by the native check. An id the bridge never
  // handed out goes to the id overload (the native SDK looks it up).

  private var lastCards: [String: Card] = [:]
  private let cardsLock = NSLock()
  private var cardsSubscription: JoryioSubscription?

  /// `page`: a cursor page (added to what was handed out) rather than the whole feed (which replaces it).
  private func cardsJson(_ feed: CardFeed, page: Bool) -> String {
    cardsLock.lock()
    if !page { lastCards.removeAll() }
    for card in feed.cards { lastCards[card.id] = card }
    cardsLock.unlock()
    guard let data = try? JSONSerialization.data(withJSONObject: feed.toJson()), let text = String(data: data, encoding: .utf8) else { return "{}" }
    return text
  }

  private func lastCard(_ id: String) -> Card? {
    cardsLock.lock()
    defer { cardsLock.unlock() }
    return lastCards[id]
  }

  /// `cursor`: a feed's `nextCursor` for the next page, nil for the feed.
  @objc func getCards(_ cursor: String?, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    let c = (cursor?.isEmpty ?? true) ? nil : cursor
    Joryio.shared.getCards(cursor: c) { [weak self] feed in
      resolve(self?.cardsJson(feed, page: c != nil) ?? "{}")
    }
  }

  /// From the native cache, never a network call.
  @objc func getUnreadCardCount(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    resolve(Joryio.shared.getUnreadCardCount())
  }

  @objc func markCardViewed(_ cardId: String?) {
    guard let id = cardId, !id.isEmpty else { return }
    if let card = lastCard(id) { Joryio.shared.markCardViewed(card) } else { Joryio.shared.markCardViewed(id) }
  }

  @objc func markCardRead(_ cardId: String?) {
    guard let id = cardId, !id.isEmpty else { return }
    if let card = lastCard(id) { Joryio.shared.markCardRead(card) } else { Joryio.shared.markCardRead(id) }
  }

  @objc func markCardClicked(_ cardId: String?) {
    guard let id = cardId, !id.isEmpty else { return }
    if let card = lastCard(id) { Joryio.shared.markCardClicked(card) } else { Joryio.shared.markCardClicked(id) }
  }

  @objc func dismissCard(_ cardId: String?) {
    guard let id = cardId, !id.isEmpty else { return }
    if let card = lastCard(id) { Joryio.shared.dismissCard(card) } else { Joryio.shared.dismissCard(id) }
  }

  @objc func refreshCards() {
    Joryio.shared.refreshCards()
  }

  @objc func enableCardsUpdates() {
    guard cardsSubscription == nil else { return }
    // nil before initialize(): JS enables again after it (the call is dispatched).
    cardsSubscription = Joryio.shared.attachCardFeedListener { [weak self] feed in
      guard let self, self.hasListeners else { return }
      self.sendEvent(withName: "JoryioCardsUpdated", body: ["json": self.cardsJson(feed, page: false)])
    }
  }

  @objc func disableCardsUpdates() {
    cardsSubscription?.cancel()
    cardsSubscription = nil
  }

  // MARK: - Links (setLinkHandler)

  /// Links waiting for the JS handler's answer, by id. Bounded: a JS side
  /// that never answers costs at most this many entries, oldest dropped.
  private var pendingLinks: [String: JoryioLink] = [:]
  private var pendingLinkOrder: [String] = []
  private static let maxPendingLinks = 32
  private var nextLinkId = 0

  /// JS set a link handler: every link the native SDK is about to open goes
  /// to JS first (event `JoryioLink`), and waits there for completeLink. The
  /// native handler takes the link at once - a bridge cannot answer
  /// synchronously - and JS hands a declined one back through completeLink.
  @objc func enableLinkHandler() {
    takeOwnership(.link)
    Joryio.shared.setLinkHandler { [weak self] link in
      guard let self, self.hasListeners else { return false }
      self.nextLinkId += 1
      let id = "l\(self.nextLinkId)"
      self.pendingLinks[id] = link
      self.pendingLinkOrder.append(id)
      while self.pendingLinkOrder.count > Self.maxPendingLinks {
        self.pendingLinks[self.pendingLinkOrder.removeFirst()] = nil
      }
      var body: [String: Any] = [
        "linkId": id,
        "url": link.url.absoluteString,
        "source": link.source.rawValue,
        "isAppDeepLink": link.isAppDeepLink,
      ]
      if let v = link.campaignId { body["campaignId"] = v }
      if let v = link.placementKey { body["placementKey"] = v }
      if let v = link.itemId { body["itemId"] = v }
      if let v = link.cardId { body["cardId"] = v }
      self.sendEvent(withName: "JoryioLink", body: body)
      return true
    }
  }

  @objc func disableLinkHandler() {
    if releaseOwnership(.link) { Joryio.shared.clearLinkHandler() }
  }

  /// The JS handler's answer: `handled` false opens the link as the SDK does
  /// without a handler.
  @objc func completeLink(_ linkId: String?, handled: Bool) {
    DispatchQueue.main.async { [weak self] in
      guard let self, let linkId, let link = self.pendingLinks.removeValue(forKey: linkId) else { return }
      self.pendingLinkOrder.removeAll { $0 == linkId }
      if !handled { link.openDefault() }
    }
  }

  private func releasePendingLinks() {
    pendingLinks.removeAll()
    pendingLinkOrder.removeAll()
  }

  /// Forget which campaigns have already been shown on this device.
  ///
  /// The SDK filters out any campaign in `displayedCampaigns`, and that set is
  /// PERSISTED - so a message shows once per install and then never again.
  /// Native apps could already call this; React Native could not, which made a
  /// campaign untestable after its first display without deleting the app.
  @objc func resetDisplayedCampaigns() {
    Joryio.shared.resetDisplayedCampaigns()
  }

  /// What the SDK is ACTUALLY doing, as opposed to what the app configured.
  ///
  /// A host app can only display the config it set, which stays cheerfully
  /// green while every request is rejected. Returns the live endpoint and the
  /// last transport failure so a status view can tell the truth.
  @objc func getDiagnostics(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    var result: [String: Any] = [
      "apiEndpoint": Joryio.shared.currentApiEndpoint ?? NSNull(),
    ]
    if let err = Joryio.shared.lastTransportError {
      result["lastError"] = [
        "message": err.message,
        "isUnauthorized": err.isUnauthorized,
        "isRetryable": err.isRetryable,
        "at": err.at.timeIntervalSince1970 * 1000,
      ]
    }
    resolve(result)
  }

  @objc func getUserId(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    resolve(Joryio.shared.getUserId())
  }

  @objc func getSessionId(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    resolve(Joryio.shared.getSessionId())
  }
}
