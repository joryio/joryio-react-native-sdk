package io.joryio.reactnative

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import android.os.Handler
import android.os.Looper
import android.util.Log
import io.joryio.sdk.Joryio
import io.joryio.sdk.TrackingConsent
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.abs
import io.joryio.sdk.ecommerce.EcommerceCartItem
import io.joryio.sdk.ecommerce.EcommerceOrder
import io.joryio.sdk.ecommerce.EcommerceProduct
import io.joryio.sdk.ecommerce.EcommerceTracker
import io.joryio.sdk.models.InAppContent
import io.joryio.sdk.JoryioConfig

/**
 * React Native bridge for the Joryio Android SDK.
 * Each method delegates to the native Joryio singleton.
 */
class JoryioModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "JoryioModule"

    // ─── Initialization ────────────────────────────────────────────────────

    @ReactMethod
    fun initialize(sdkKey: String?, apiHost: String?, config: ReadableMap?, promise: Promise) {
        // Every parameter nullable (contract item 19): a JS null reaching a
        // non-null Kotlin parameter is a NullPointerException on the native
        // modules thread, which is a crash in a release build. The JS layer
        // checks first; this is the second line of defence.
        if (sdkKey.isNullOrEmpty() || apiHost.isNullOrEmpty()) {
            promise.reject("INIT_ERROR", "initialize() needs a non-empty sdkKey and apiHost")
            return
        }
        // A key the native SDK would refuse is refused HERE, before any native
        // instance exists. Handed to Joryio.initialize(), it built an instance
        // in no-send mode and resolved: JS reported success, nothing was ever
        // sent, and a corrected initialize() got the broken instance back, so
        // only an app restart recovered. Rejected here, a retry with the right
        // key works. Same prefix the native SDK checks.
        if (!sdkKey.startsWith(SDK_KEY_PREFIX)) {
            promise.reject(
                "INIT_ERROR",
                "initialize() was refused: Android SDK keys start with '$SDK_KEY_PREFIX'. Copy your SDK key from the Joryio dashboard.",
            )
            return
        }
        try {
            // Only override keys the JS caller explicitly set; leave everything else
            // to the native SDK's own defaults. Injecting JS-side defaults here would
            // silently diverge RN-Android from native + web (e.g. batchSize/flush/
            // sessionTimeout). This mirrors how the iOS bridge behaves.
            //
            // Every read goes through opt*(): a key that is ABSENT, NULL or of
            // the wrong type means "use the native default". `getInt` on a
            // present-but-null key threw, initialize() rejected, and one
            // `batchSize: null` switched the SDK off for the whole session.
            var joryioConfig = JoryioConfig(userId = config.optString("userId"))
            // Off unless the app opts in - see JoryioConfig.
            config.optBoolean("allowHtmlJsInAppMessages")?.let {
                joryioConfig = joryioConfig.copy(allowHtmlJsInAppMessages = it)
            }
            // Sent by the JS layer on EVERY initialize(): native holds in-app
            // messages until JS has had its chance to subscribe, so the first
            // sync can no longer draw natively the message an onInAppMessage
            // app meant to draw itself. JS ends the hold with
            // enableInAppMessages (its listener takes the message) or
            // disableInAppMessages (nobody listens; native draws it).
            config.optBoolean("holdInAppMessagesForHandler")?.let {
                joryioConfig = joryioConfig.copy(holdInAppMessagesForHandler = it)
            }
            config.optBoolean("requestPushPermissionAtLaunch")?.let {
                joryioConfig = joryioConfig.copy(requestPushPermissionAtLaunch = it)
            }
            config.optBoolean("enableDebug")?.let { joryioConfig = joryioConfig.copy(enableDebug = it) }
            // Explicit level, same key the iOS bridge accepts. Left unset, the
            // level follows enableDebug (JoryioConfig.effectiveLogLevel).
            config.optString("logLevel")?.uppercase()?.let { raw ->
                io.joryio.sdk.LogLevel.values().firstOrNull { it.name == raw }
            }?.let { joryioConfig = joryioConfig.copy(logLevel = it) }
            config.optInt("batchSize")?.let { joryioConfig = joryioConfig.copy(batchSize = it) }
            config.optLong("flushInterval")?.let { joryioConfig = joryioConfig.copy(flushInterval = it) }
            config.optLong("sessionTimeout")?.let { joryioConfig = joryioConfig.copy(sessionTimeout = it) }
            config.optBoolean("trackSessionStart")?.let {
                joryioConfig = joryioConfig.copy(trackSessionStart = it)
            }
            // Four options the native SDKs honour that this bridge dropped on
            // the floor (audit 2026-09-26, D26): a JS app setting any of them
            // got the native default and no error. Same names as native;
            // `requestTimeout` is milliseconds on both sides here.
            config.optString("anonymousId")?.let { joryioConfig = joryioConfig.copy(anonymousId = it) }
            config.optBoolean("sendImmediately")?.let {
                joryioConfig = joryioConfig.copy(sendImmediately = it)
            }
            config.optInt("maxQueueSize")?.let { joryioConfig = joryioConfig.copy(maxQueueSize = it) }
            config.optLong("requestTimeout")?.let { joryioConfig = joryioConfig.copy(requestTimeout = it) }
            config.optBoolean("enableSdkAuthentication")?.let {
                joryioConfig = joryioConfig.copy(enableSdkAuthentication = it)
            }
            config.optString("sdkAuthenticationToken")?.let {
                joryioConfig = joryioConfig.copy(sdkAuthenticationToken = it)
            }
            // The channel name people see in system Settings, localized by the
            // app. Missing from this bridge, so an RN app's channel always read
            // the English "Notifications" while native Android and Unity apps
            // could pass their own (scan 6, S4). Blank means the default.
            config.optString("notificationChannelName")?.takeIf { it.isNotBlank() }?.let {
                joryioConfig = joryioConfig.copy(notificationChannelName = it)
            }
            // Consent and opt-out at start-up, the same options every Joryio SDK
            // takes. They were missing here, so an RN app could only opt out
            // AFTER initialize() - by which time the session start had gone.
            config.optBoolean("optOut")?.let { joryioConfig = joryioConfig.copy(optOut = it) }
            // UNSET unless JS set it (consent model A, contract item 24): an
            // unset consent keeps a denial stored by an earlier launch, while an
            // explicit GRANTED lifts it. Filling in GRANTED here would turn
            // every app's default config into an explicit grant.
            joryioConfig = joryioConfig.copy(trackingConsent = null)
            config.optString("trackingConsent")?.let { raw ->
                val parsed = parseConsent(raw)
                if (parsed != null) {
                    joryioConfig = joryioConfig.copy(trackingConsent = parsed)
                } else {
                    Log.e(TAG, "Unknown trackingConsent '$raw' - ignored")
                }
            }

            // The Activity, when there is one, rather than only the application
            // context. The native SDK learns the foreground Activity from
            // lifecycle callbacks it registers inside initialize() - and React
            // Native runs initialize() AFTER the first Activity resumed, so that
            // callback never came for it. Without this the first session had no
            // Activity: in-app messages could not draw and
            // requestPushPermissionAtLaunch could not prompt until the user left
            // the app and came back. The SDK keeps only the application context
            // and a weak reference to the Activity.
            // Every request names this bridge and its version (D427):
            // X-Joryio-SDK-Wrapper: react-native + X-Joryio-SDK-Wrapper-Version.
            // The JS layer sends its package version on every initialize().
            Joryio.setSdkWrapper("react-native", config.optString("sdkWrapperVersion"))
            Joryio.initialize(
                context = reactApplicationContext.currentActivity ?: reactContext.applicationContext,
                sdkKey = sdkKey,
                apiHost = apiHost,
                config = joryioConfig,
            )

            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("INIT_ERROR", e.message, e)
        }
    }

    // ─── Null-safe reads (contract item 19) ────────────────────────────────
    //
    // A key that is absent, JS `null`, or of the wrong type reads as null, so
    // the caller falls back to its default. ReadableMap.getInt/getDouble/
    // getBoolean THROW on a null value, and a throw here either failed
    // initialize() or dropped the call.

    private inline fun <T> ReadableMap?.opt(
        key: String,
        type: ReadableType,
        read: ReadableMap.(String) -> T?,
    ): T? {
        val map = this ?: return null
        if (!map.hasKey(key) || map.isNull(key)) return null
        val actual = map.getType(key)
        if (actual != type) {
            Log.w(TAG, "'$key' should be ${type.name.lowercase()}, not ${actual.name.lowercase()} - ignored")
            return null
        }
        return map.read(key)
    }

    private fun ReadableMap?.optString(key: String): String? =
        opt(key, ReadableType.String) { getString(it) }

    private fun ReadableMap?.optBoolean(key: String): Boolean? =
        opt(key, ReadableType.Boolean) { getBoolean(it) }

    private fun ReadableMap?.optDouble(key: String): Double? =
        opt(key, ReadableType.Number) { getDouble(it) }

    private fun ReadableMap?.optInt(key: String): Int? = optDouble(key)?.toInt()

    private fun ReadableMap?.optLong(key: String): Long? = optDouble(key)?.toLong()

    private fun ReadableMap?.optMap(key: String): ReadableMap? =
        opt(key, ReadableType.Map) { getMap(it) }

    private fun ReadableMap?.optArray(key: String): ReadableArray? =
        opt(key, ReadableType.Array) { getArray(it) }

    /** A required string argument: a warning and false when it is missing. */
    private fun present(caller: String, name: String, value: String?): Boolean {
        if (!value.isNullOrEmpty()) return true
        Log.w(TAG, "$caller() needs a non-empty $name - ignored")
        return false
    }

    /** Event properties; a null map means none. */
    private fun ReadableMap?.toProps(): Map<String, Any?> =
        this?.toHashMap()?.mapValues { it.value as Any? } ?: emptyMap()

    // ─── Event Tracking ────────────────────────────────────────────────────

    @ReactMethod
    fun track(eventName: String?, properties: ReadableMap?) {
        if (!present("track", "eventName", eventName)) return
        Joryio.track(eventName, properties.toProps())
    }

    @ReactMethod
    fun trackScreen(screenName: String?, properties: ReadableMap?) {
        if (!present("trackScreen", "screenName", screenName)) return
        Joryio.trackScreen(screenName, properties.toProps())
    }

    // ─── Identity ──────────────────────────────────────────────────────────

    @ReactMethod
    fun identify(userId: String?) {
        if (!present("identify", "userId", userId)) return
        Joryio.identify(userId)
    }

    /**
     * A labelled alias (`crm_id` -> `C-1042`). Works before identify(): the
     * native SDK sends it with the anonymous id. The unlabelled alias(userId)
     * is gone from every SDK - identify() is how you name the current person.
     */
    @ReactMethod
    fun addAlias(aliasLabel: String?, aliasName: String?) {
        if (!present("addAlias", "aliasLabel", aliasLabel)) return
        if (!present("addAlias", "aliasName", aliasName)) return
        Joryio.whenReady { it.addAlias(aliasLabel, aliasName) }
    }

    @ReactMethod
    fun reset() {
        Joryio.reset()
    }

    /**
     * Joryio.resetTo: reset(), then the caller's anonymous id (validated
     * natively; refused = a plain reset). Resolves true when the id was
     * adopted, false when it was refused.
     */
    @ReactMethod
    fun resetTo(anonymousId: String?, promise: Promise) {
        Joryio.resetTo(anonymousId) { adopted -> promise.resolve(adopted) }
    }

    // ─── Tracking consent ──────────────────────────────────────────────────
    //
    // Tracking consent, NOT marketing subscription. optOut stops the SDK
    // collecting and sending; it does not unsubscribe anyone from email.
    //
    // Bridged because it was missing: web, Android, iOS and Unity all had these
    // and React Native had no consent surface at all, so an RN app could not
    // honour a "do not track" choice through the SDK. The native call already
    // records `tracking_opted_out` on the profile, so bridging is the whole fix
    // here - no wire behaviour is defined in this layer.

    @ReactMethod
    fun optOut() {
        Joryio.optOut()
    }

    @ReactMethod
    fun optIn() {
        Joryio.optIn()
    }

    @ReactMethod
    fun isUserOptedOut(promise: Promise) {
        // Settled on every path, like getTrackingConsent: before initialize()
        // the answer comes from a store read that can throw, and a throw here
        // left the JS promise pending for good.
        try {
            promise.resolve(Joryio.isUserOptedOut())
        } catch (e: Exception) {
            Log.e(TAG, "isUserOptedOut failed: ${e.message}")
            promise.resolve(null)
        }
    }

    /** 'granted' releases what was held while consent was pending; 'denied' discards it. */
    @ReactMethod
    fun updateConsent(consent: String?) {
        val parsed = parseConsent(consent)
        if (parsed == null) {
            Log.e(TAG, "updateConsent: unknown value '$consent' - ignored")
            return
        }
        // The static form records a decision made before initialize() and
        // applies it inside init, so nothing is sent first (whenReady would
        // replay it only after init's own sync).
        Joryio.updateConsent(parsed)
    }

    /**
     * Erase everything this device holds for the current person (identity,
     * queue, pending writes, in-app state, session, device id, push token) and
     * unregister the token on the server. The opt-out is kept.
     */
    @ReactMethod
    fun wipeData() {
        // The static form records a wipe made before initialize() and runs it
        // inside native init, ahead of the Session Start, the in-app sync and
        // the push re-registration (contract item 25), as iOS does.
        Joryio.wipeData()
    }

    /**
     * The current tracking consent ('granted' | 'denied' | 'pending'),
     * separate from the opt-out that isUserOptedOut() reports. Before
     * initialize() it is what native reads from storage - 'granted' when
     * nothing is decided or stored, the same as iOS - passed through as it is.
     */
    @ReactMethod
    fun getTrackingConsent(promise: Promise) {
        try {
            promise.resolve(Joryio.getTrackingConsent()?.name?.lowercase())
        } catch (e: Exception) {
            promise.resolve(null)
        }
    }

    private fun parseConsent(raw: String?): TrackingConsent? =
        TrackingConsent.values().firstOrNull { it.name.equals(raw, ignoreCase = true) }

    // ─── Marketing subscription ────────────────────────────────────────────
    //
    // A DIFFERENT consent from optIn/optOut above: that is whether we may
    // OBSERVE, this is whether we may MESSAGE. Existed on web only, so no
    // mobile app could offer an in-app preference centre.

    @ReactMethod
    fun setSubscription(channel: String?, status: String?) {
        if (!present("setSubscription", "channel", channel)) return
        if (!present("setSubscription", "status", status)) return
        Joryio.setSubscription(channel, status)
    }

    @ReactMethod
    fun addToSubscriptionGroup(groupId: String?, channel: String?) {
        if (!present("addToSubscriptionGroup", "groupId", groupId)) return
        if (!present("addToSubscriptionGroup", "channel", channel)) return
        Joryio.addToSubscriptionGroup(groupId, channel)
    }

    @ReactMethod
    fun removeFromSubscriptionGroup(groupId: String?, channel: String?) {
        if (!present("removeFromSubscriptionGroup", "groupId", groupId)) return
        if (!present("removeFromSubscriptionGroup", "channel", channel)) return
        Joryio.removeFromSubscriptionGroup(groupId, channel)
    }

    // ─── Attributes ────────────────────────────────────────────────────────

    /**
     * A null value UNSETS that attribute, the same as on iOS. The JS layer
     * already splits nulls out; this is the guard for anything that reaches the
     * bridge directly. It used to be `mapValues { it.value as Any }`, which
     * threw a NullPointerException on the first null and took the app down.
     */
    @ReactMethod
    fun setAttributes(attributes: ReadableMap?) {
        if (attributes == null) {
            Log.w(TAG, "setAttributes() needs a map of attributes - ignored")
            return
        }
        val values = HashMap<String, Any>()
        val unset = ArrayList<String>()
        for ((key, value) in attributes.toHashMap()) {
            if (value == null) unset.add(key) else values[key] = value
        }
        Joryio.whenReady { sdk ->
            if (values.isNotEmpty()) sdk.setAttributes(values)
            unset.forEach { sdk.unsetAttribute(it) }
        }
    }

    /**
     * Every ReadableType handled explicitly. `Dynamic.asString()` returns
     * `String?` from React Native 0.81, so the old `else -> value.asString()`
     * arm no longer compiled into an `Any`; and a JS null reached it at all.
     */
    @ReactMethod
    fun setAttribute(key: String?, value: Dynamic?) {
        if (!present("setAttribute", "key", key)) return
        when (value?.type ?: ReadableType.Null) {
            ReadableType.Null -> Joryio.whenReady { it.unsetAttribute(key) }
            ReadableType.Boolean -> {
                val v = value!!.asBoolean()
                Joryio.whenReady { it.setAttribute(key, v) }
            }
            ReadableType.Number -> {
                val v = value!!.asDouble()
                Joryio.whenReady { it.setAttribute(key, v) }
            }
            ReadableType.String -> {
                val v: String? = value!!.asString()
                if (v == null) {
                    Joryio.whenReady { it.unsetAttribute(key) }
                } else {
                    Joryio.whenReady { it.setAttribute(key, v) }
                }
            }
            else -> Log.e(TAG, "setAttribute('$key'): ${value?.type} values are not supported - ignored")
        }
    }

    @ReactMethod
    /**
     * `by` is a Dynamic, not a Double: React Native reads a primitive argument
     * with getDouble(), which throws on a JS null before this method runs. A
     * null step means the default, 1.
     */
    fun incrementAttribute(key: String?, by: Dynamic?) {
        if (!present("incrementAttribute", "key", key)) return
        val step = when (by?.type ?: ReadableType.Null) {
            ReadableType.Null -> 1.0
            ReadableType.Number -> by!!.asDouble()
            else -> {
                Log.w(TAG, "incrementAttribute('$key') needs a number to add - ignored")
                return
            }
        }
        Joryio.whenReady { it.incrementAttribute(key, step) }
    }

    @ReactMethod
    fun unsetAttribute(key: String?) {
        if (!present("unsetAttribute", "key", key)) return
        Joryio.whenReady { it.unsetAttribute(key) }
    }

    // ─── Push ──────────────────────────────────────────────────────────────

    @ReactMethod
    fun reportPushDelivered(trackingId: String?) {
        if (!present("reportPushDelivered", "trackingId", trackingId)) return
        Joryio.whenReady { it.reportPushDelivered(trackingId) }
    }

    /**
     * Resolves with the native PushRegistrationResult. The single-arg form
     * dropped it, so from JS a failed registration was indistinguishable from
     * a successful one (Teamder, 2026-09-29).
     */
    @ReactMethod
    fun registerPushToken(token: String?, promise: Promise) {
        if (token.isNullOrEmpty()) {
            val map = Arguments.createMap()
            map.putBoolean("success", false)
            map.putString("message", "A push token is required")
            map.putBoolean("isUnauthorized", false)
            map.putBoolean("isRetryable", false)
            promise.resolve(map)
            return
        }
        Joryio.whenReady { sdk ->
            sdk.registerPushToken(token) { r ->
                val map = Arguments.createMap()
                map.putBoolean("success", r.success)
                // Local copy: a smart cast on a property from another module is not allowed.
                val message = r.message
                if (message != null) map.putString("message", message) else map.putNull("message")
                map.putBoolean("isUnauthorized", r.isUnauthorized)
                map.putBoolean("isRetryable", r.isRetryable)
                promise.resolve(map)
            }
        }
    }

    @ReactMethod
    fun unregisterPush() {
        // The static form buffers it as a withdrawal before init: kept by the
        // pre-init cap and by a pre-init wipe, and run under the identity it
        // was made for (contract v5 51; scan 5, N4).
        Joryio.unregisterPush()
    }

    /**
     * Show the system notification prompt (Android 13+ POST_NOTIFICATIONS).
     *
     * Resolves the resulting status rather than a bare boolean, so JS can tell
     * "denied" from "we could not ask" - the difference decides whether a primer
     * is worth showing again.
     */
    @ReactMethod
    fun requestPushPermission(promise: Promise) {
        val activity = reactApplicationContext.currentActivity
        if (activity == null) {
            // No Activity = nothing to attach a dialog to. Report it instead of
            // throwing: this is a normal race if JS asks during a background tick.
            promise.resolve("unavailable")
            return
        }
        if (!Joryio.isInitialized()) {
            promise.resolve("unavailable")
            return
        }
        PermissionRequest(promise, activity)
    }

    /**
     * One prompt, settled exactly once - and ALWAYS settled.
     *
     * The prompt's answer is delivered to the Activity that showed it. If
     * Android recreates that Activity while the prompt is up (rotation, a
     * dark-mode switch, any config change) the answer goes nowhere, and the JS
     * promise used to hang forever. So when the app returns to the foreground
     * after the prompt, the real answer gets a moment to arrive, and otherwise
     * the promise resolves with the status as it now stands.
     */
    private inner class PermissionRequest(
        private val promise: Promise,
        activity: android.app.Activity,
    ) : LifecycleEventListener {
        private val settled = AtomicBoolean(false)
        @Volatile private var leftForeground = false

        init {
            start(activity)
        }

        // `private`, like everything here that is not a @ReactMethod: the
        // binding-parity tripwire reads every bare `fun` in this file as one.
        private fun start(activity: android.app.Activity) {
            reactApplicationContext.addLifecycleEventListener(this)
            if (!Joryio.isInitialized()) {
                settle("unavailable")
                return
            }
            Joryio.getInstance().requestPushPermission(activity) { status ->
                settle(status.publicName)
            }
        }

        private fun settle(status: String) {
            if (!settled.compareAndSet(false, true)) return
            reactApplicationContext.removeLifecycleEventListener(this)
            promise.resolve(status)
        }

        override fun onHostPause() {
            leftForeground = true
        }

        override fun onHostResume() {
            if (!leftForeground) return
            Handler(Looper.getMainLooper()).postDelayed(
                { settle(currentPushPermissionStatus()) },
                PERMISSION_ANSWER_GRACE_MS,
            )
        }

        override fun onHostDestroy() {}
    }

    private fun currentPushPermissionStatus(): String =
        if (Joryio.isInitialized()) {
            Joryio.getInstance().getPushPermissionStatus().publicName
        } else {
            "unavailable"
        }

    @ReactMethod
    fun getPushPermissionStatus(promise: Promise) {
        promise.resolve(currentPushPermissionStatus())
    }

    /**
     * Click-link identity: the URL that opened the app, passed through to the
     * native SDK unchanged. Native reads `jr_t` and applies the rules
     * (identified, opted out, consent, once per token). The static call holds
     * it until initialize() and drops it if tracking is refused first.
     */
    @ReactMethod
    fun identifyFromLink(url: String?) {
        if (!present("identifyFromLink", "url", url)) return
        Joryio.identifyFromLink(url)
    }

    @ReactMethod
    fun isPushEnabled(promise: Promise) {
        // Answer NOW, even if the SDK is not ready. getInstance() throws when it
        // is not, and a throw inside a @ReactMethod is a red box in development
        // and an unhandled JS error in production. Deferring instead would be
        // worse: the promise would simply never settle and the caller would hang.
        promise.resolve(if (Joryio.isInitialized()) Joryio.getInstance().isPushEnabled() else false)
    }

    @ReactMethod
    fun trackPushClick(trackingId: String?) {
        if (!present("trackPushClick", "trackingId", trackingId)) return
        Joryio.whenReady { it.trackPushClick(trackingId) }
    }

    // ─── In-App Messaging ──────────────────────────────────────────────────

    /**
     * Forward in-app campaigns to JS.
     *
     * This used to read `message.html` / `message.css` / a String `message.type`
     * off the native model, and did not compile: the native model described a
     * structured message (title/body/imageUrl/buttons) the server has never
     * sent. The model now matches the wire contract, so the bridge reads the
     * resolved content.
     *
     * A campaign with no renderable document is DROPPED rather than emitted
     * with empty strings - JS would otherwise render a blank container the user
     * has to dismiss, and count an impression for it.
     */
    // ── E-commerce ───────────────────────────────────────────────────────────

    /**
     * ONE bridge method, not nineteen.
     *
     * EcommerceTracker exposes 19 calls. Forwarding each as its own
     * @ReactMethod would mean 19 signatures here, 19 more in the iOS module and
     * 19 in JS, all of which have to agree - and this repo's recurring failure
     * is exactly that: a name one side emits and the other never branches on.
     * A single entry point with an explicit `when` puts the whole contract in
     * one readable place per platform, and a spec can compare the three lists.
     *
     * WHY FORWARD AT ALL rather than build the events in JS. The canonical
     * event names ("Product Added", not "Added to Cart") and the purchase
     * property keys live in the native tracker. Rebuilding them in JS would be
     * a FIFTH copy of the vocabulary, and there is deliberately no alias layer
     * server-side: a near-miss is stored verbatim and matches no report. Our own
     * demo app shipped "Placed Order" and recorded zero revenue while looking
     * completely healthy.
     *
     * An unknown method logs loudly rather than failing silently, because the
     * failure it guards against - a typo'd method name - would otherwise be a
     * no-op that looks like the SDK working.
     */
    @ReactMethod
    fun ecommerce(method: String?, payload: ReadableMap?) {
        if (!present("ecommerce", "method", method)) return
        // whenReady, not getInstance(): getInstance() THROWS before initialize()
        // and this is reachable from a module field or a first render, which is
        // earlier than initialize() resolves. The repo's own bridge-safety guard
        // caught this - the first version called getInstance() directly.
        //
        // Queuing is also the better behaviour: an e-commerce event fired during
        // startup is a real event, and dropping it would understate revenue
        // rather than fail visibly.
        // Every required argument is checked HERE, before anything is queued
        // (contract item 19). A missing one used to become a default - an
        // empty orderId, a zero total - so `purchase(null)` tracked an Order
        // Completed worth nothing instead of being refused. The JS layer checks
        // first; this is the second line of defence.
        val call: ((EcommerceTracker) -> Unit)? = when (method) {
            "viewProduct" -> product(method, payload.optMap("product"))?.let { p -> ecommerceCall { t -> t.viewProduct(p) } }
            "viewCategory" -> {
                val id = need(method, "categoryId", payload.optString("categoryId"))
                val name = need(method, "categoryName", payload.optString("categoryName"))
                if (id != null && name != null) ecommerceCall { t -> t.viewCategory(id, name) } else null
            }
            "search" -> need(method, "query", payload.optString("query"))?.let { q ->
                val count = payload.optInt("resultCount")
                ecommerceCall { t -> t.search(q, count) }
            }
            "addToCart" -> cartItem(method, payload.optMap("item"))?.let { item ->
                val cartValue = payload.optDouble("cartValue")
                ecommerceCall { t -> t.addToCart(item, cartValue) }
            }
            "removeFromCart" -> product(method, payload.optMap("product"))?.let { p ->
                val quantity = payload.optInt("quantity") ?: 1
                ecommerceCall { t -> t.removeFromCart(p, quantity) }
            }
            "cartViewed" -> cart(method, payload) { t, items, value -> t.cartViewed(items, value) }
            "updateCart" -> cart(method, payload) { t, items, value -> t.updateCart(items, value) }
            "startCheckout" -> cart(method, payload) { t, items, value -> t.startCheckout(items, value) }
            "addPaymentInfo" -> need(method, "paymentMethod", payload.optString("paymentMethod"))
                ?.let { pm -> ecommerceCall { t -> t.addPaymentInfo(pm) } }
            "purchase" -> order(method, payload.optMap("order"))?.let { o -> ecommerceCall { t -> t.purchase(o) } }
            "orderFulfilled" -> need(method, "orderId", payload.optString("orderId"))?.let { id ->
                val trackingNumber = payload.optString("trackingNumber")
                val carrier = payload.optString("carrier")
                ecommerceCall { t -> t.orderFulfilled(id, trackingNumber, carrier) }
            }
            "orderDelivered" -> need(method, "orderId", payload.optString("orderId"))
                ?.let { id -> ecommerceCall { t -> t.orderDelivered(id) } }
            "orderCancelled" -> need(method, "orderId", payload.optString("orderId"))?.let { id ->
                val reason = payload.optString("reason")
                ecommerceCall { t -> t.orderCancelled(id, reason) }
            }
            "orderRefunded" -> need(method, "orderId", payload.optString("orderId"))?.let { id ->
                val refundAmount = payload.optDouble("refundAmount")
                val reason = payload.optString("reason")
                ecommerceCall { t -> t.orderRefunded(id, refundAmount, reason) }
            }
            "addToWishlist" -> product(method, payload.optMap("product"))?.let { p -> ecommerceCall { t -> t.addToWishlist(p) } }
            "removeFromWishlist" -> product(method, payload.optMap("product"))
                ?.let { p -> ecommerceCall { t -> t.removeFromWishlist(p) } }
            "shareProduct" -> {
                val p = product(method, payload.optMap("product"))
                val shareMethod = need(method, "shareMethod", payload.optString("shareMethod"))
                if (p != null && shareMethod != null) ecommerceCall { t -> t.shareProduct(p, shareMethod) } else null
            }
            "applyCoupon" -> need(method, "couponCode", payload.optString("couponCode"))?.let { code ->
                val discountAmount = payload.optDouble("discountAmount")
                val discountType = payload.optString("discountType")
                ecommerceCall { t -> t.applyCoupon(code, discountAmount, discountType) }
            }
            "removeCoupon" -> need(method, "couponCode", payload.optString("couponCode"))
                ?.let { code -> ecommerceCall { t -> t.removeCoupon(code) } }
            // Read as a Double on BOTH bridges, then converted the same way:
            // iOS read 4.5 as 0 (`as? Int` fails on a fraction) while this
            // side gave 4. The native trackers take an Int rating, so a
            // fraction is truncated identically on both until they take a
            // Double like the web SDK.
            "submitReview" -> {
                val productId = need(method, "productId", payload.optString("productId"))
                val rating = amount(method, "rating", payload.optDouble("rating"))?.let { r ->
                    // An Int must be able to hold it: toInt() saturated here,
                    // while Swift's Int(Double) traps. Refused on both.
                    if (abs(r) <= Int.MAX_VALUE.toDouble()) {
                        r
                    } else {
                        Log.w(TAG, "ecommerce.$method() needs a rating an Int can hold - event NOT sent")
                        null
                    }
                }
                val reviewText = payload.optString("reviewText")
                if (productId != null && rating != null) {
                    ecommerceCall { t -> t.submitReview(productId, rating.toInt(), reviewText) }
                } else {
                    null
                }
            }
            else -> {
                Log.e(TAG, "Unknown ecommerce method '$method' - event NOT sent")
                null
            }
        }
        // whenReady, not getInstance(): getInstance() THROWS before initialize()
        // and this is reachable from a module field or a first render, which is
        // earlier than initialize() resolves. The repo's own bridge-safety guard
        // caught this - the first version called getInstance() directly.
        //
        // Queuing is also the better behaviour: an e-commerce event fired during
        // startup is a real event, and dropping it would understate revenue
        // rather than fail visibly.
        if (call != null) Joryio.whenReady { sdk -> call(sdk.ecommerce()) }
    }

    /**
     * One e-commerce call, validated and ready to run against the tracker.
     * Gives each lambda in the `when` its type.
     */
    private fun ecommerceCall(block: (EcommerceTracker) -> Unit): (EcommerceTracker) -> Unit = block

    /** The three cart calls: an items array and a cartValue, both required. */
    private fun cart(
        method: String,
        payload: ReadableMap?,
        send: (EcommerceTracker, List<EcommerceCartItem>, Double) -> Unit,
    ): ((EcommerceTracker) -> Unit)? {
        val items = cartItems(method, payload.optArray("items"))
        val cartValue = amount(method, "cartValue", payload.optDouble("cartValue"))
        if (items == null || cartValue == null) return null
        return ecommerceCall { t -> send(t, items, cartValue) }
    }

    /** A required string, or a warning naming the call and null. */
    private fun need(method: String, name: String, value: String?): String? {
        if (!value.isNullOrEmpty()) return value
        Log.w(TAG, "ecommerce.$method() needs a non-empty $name - event NOT sent")
        return null
    }

    /** A required finite number, or a warning and null. */
    private fun amount(method: String, name: String, value: Double?): Double? {
        if (value != null && value.isFinite()) return value
        Log.w(TAG, "ecommerce.$method() needs a number $name - event NOT sent")
        return null
    }

    private fun product(method: String, m: ReadableMap?): EcommerceProduct? {
        if (m.optString("productId").isNullOrEmpty()) {
            Log.w(TAG, "ecommerce.$method() needs a product with a productId - event NOT sent")
            return null
        }
        return product(m)
    }

    private fun cartItem(method: String, m: ReadableMap?): EcommerceCartItem? {
        if (m.optString("productId").isNullOrEmpty()) {
            Log.w(TAG, "ecommerce.$method() needs an item with a productId - event NOT sent")
            return null
        }
        return cartItem(m)
    }

    private fun cartItems(method: String, arr: ReadableArray?): List<EcommerceCartItem>? {
        if (arr == null) {
            Log.w(TAG, "ecommerce.$method() needs an array of items - event NOT sent")
            return null
        }
        return cartItems(arr)
    }

    private fun order(method: String, m: ReadableMap?): EcommerceOrder? {
        if (m.optString("orderId").isNullOrEmpty()) {
            Log.w(TAG, "ecommerce.$method() needs an order with an orderId - event NOT sent")
            return null
        }
        // Contract item 42: an order without an items array is not sent
        // either, rather than recorded as an empty order.
        if (m.optArray("items") == null) {
            Log.w(TAG, "ecommerce.$method() needs an order with an items array - event NOT sent")
            return null
        }
        if (amount(method, "order.value", m.optDouble("value")) == null) return null
        return order(m)
    }

    // `m` may be null (a JS null product): every opt*() then reads null and
    // the defaults below apply, instead of a NullPointerException.
    private fun product(m: ReadableMap?): EcommerceProduct {
        return EcommerceProduct(
            productId = m.optString("productId") ?: "",
            name = m.optString("name") ?: "",
            price = m.optDouble("price") ?: 0.0,
            quantity = m.optInt("quantity"),
            category = m.optString("category"),
            brand = m.optString("brand"),
            variant = m.optString("variant"),
            variantId = m.optString("variantId"),
            sku = m.optString("sku"),
            imageUrl = m.optString("imageUrl"),
            url = m.optString("url"),
        )
    }

    private fun cartItem(m: ReadableMap?): EcommerceCartItem {
        return EcommerceCartItem(
            productId = m.optString("productId") ?: "",
            name = m.optString("name") ?: "",
            price = m.optDouble("price") ?: 0.0,
            // Quantity defaults to 1, not 0: a cart line with zero quantity has
            // an item total of zero, which is a silently wrong revenue number
            // rather than an obviously wrong one.
            quantity = m.optInt("quantity") ?: 1,
            category = m.optString("category"),
            brand = m.optString("brand"),
            variant = m.optString("variant"),
            variantId = m.optString("variantId"),
            sku = m.optString("sku"),
            imageUrl = m.optString("imageUrl"),
            url = m.optString("url"),
        )
    }

    private fun cartItems(arr: ReadableArray?): List<EcommerceCartItem> {
        val a = arr ?: return emptyList()
        // A null (or any non-object) entry is SKIPPED, as the JS layer skips
        // it. Mapped to cartItem(null) it became a line with no productId, and
        // the native tracker refused the whole order because of it.
        return (0 until a.size())
            .filter { i -> a.getType(i) == ReadableType.Map }
            .map { i -> cartItem(a.getMap(i)) }
    }

    private fun order(m: ReadableMap?): EcommerceOrder {
        return EcommerceOrder(
            orderId = m.optString("orderId") ?: "",
            items = cartItems(m.optArray("items")),
            value = m.optDouble("value") ?: 0.0,
            currency = m.optString("currency"),
            shipping = m.optDouble("shipping"),
            tax = m.optDouble("tax"),
            discount = m.optDouble("discount"),
            coupon = m.optString("coupon"),
        )
    }

    /**
     * Ask the SDK to fetch in-app campaigns now.
     *
     * Bound here because it was iOS-only, so `Joryio.syncInAppCampaigns()` from
     * JS was `undefined` on Android and _dispatch's catch swallowed it - a
     * cross-platform API that silently did nothing on half its platforms. The
     * native method has existed all along (Joryio.kt:1053); only the binding
     * was missing.
     */
    @ReactMethod
    fun syncInAppCampaigns() {
        Joryio.syncInAppCampaigns()
    }

    // ── Placements (docs/PLACEMENTS_PLAN.md, D444) ──────────────────────
    // The native SDK does the work - fetching, caching, viewability rules,
    // reporting, the identity guard. The bridge hands the data to JS as JSON
    // and routes JS's mark* calls back to the native objects it last handed
    // out, so a report always goes through the native generation check.

    private val lastPlacements = java.util.concurrent.ConcurrentHashMap<String, io.joryio.sdk.placements.Placement>()
    private var placementsSubscription: io.joryio.sdk.JoryioSubscription? = null

    private fun placementKeys(keys: ReadableArray?): List<String>? =
        keys?.toArrayList()?.mapNotNull { it as? String }

    private fun placementsJson(map: Map<String, io.joryio.sdk.placements.Placement>): String {
        map.forEach { (k, p) -> lastPlacements[k] = p }
        return map.entries.joinToString(",", "{", "}") { org.json.JSONObject.quote(it.key) + ":" + it.value.toJson() }
    }

    @ReactMethod
    fun getPlacements(keys: ReadableArray?, promise: Promise) {
        if (!Joryio.isInitialized()) {
            promise.resolve("{}")
            return
        }
        Joryio.getInstance().getPlacements(placementKeys(keys) ?: emptyList()) { map ->
            promise.resolve(placementsJson(map))
        }
    }

    @ReactMethod
    fun refreshPlacements(keys: ReadableArray?) {
        Joryio.refreshPlacements(placementKeys(keys))
    }

    @ReactMethod
    fun enablePlacementsUpdates() {
        if (placementsSubscription != null || !Joryio.isInitialized()) return
        placementsSubscription = Joryio.getInstance().onPlacementsUpdated { map ->
            val params = Arguments.createMap().apply { putString("json", placementsJson(map)) }
            reactApplicationContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit("JoryioPlacementsUpdated", params)
        }
    }

    @ReactMethod
    fun disablePlacementsUpdates() {
        placementsSubscription?.cancel()
        placementsSubscription = null
    }

    /** `action`: displayed | clicked | dismissed for an item, `control` for the holdout spot. */
    @ReactMethod
    fun markPlacement(placementKey: String?, itemId: String?, action: String?, elementId: String?) {
        val placement = lastPlacements[placementKey ?: return] ?: return
        if (action == "control") {
            placement.markDisplayed()
            return
        }
        val item = placement.items.firstOrNull { it.id == itemId } ?: return
        when (action) {
            "displayed" -> item.markDisplayed()
            "clicked" -> item.markClicked(elementId?.takeIf { it.isNotEmpty() })
            "dismissed" -> item.markDismissed()
        }
    }

    // ── Content cards (docs/PLACEMENTS_PLAN.md section 11, D444 Phase 3) ──
    // The native SDK does the work - fetching, caching, the rate limit, the
    // anonymous visitor's device state, reporting, the identity guard. The
    // bridge hands the feed to JS as JSON (CardFeed.toJson, no delivery
    // tokens) and routes JS's reports back to the native Card objects it last
    // handed out, so a report carries the card's own token and a card of a
    // person who is no longer here is dropped by the native check. An id the
    // bridge never handed out goes to the id overload (the native SDK looks
    // it up in its cache).

    private val lastCards = java.util.concurrent.ConcurrentHashMap<String, io.joryio.sdk.cards.Card>()
    private var cardsSubscription: io.joryio.sdk.JoryioSubscription? = null

    /** [page]: a cursor page (added to what was handed out) rather than the whole feed (which replaces it). */
    private fun cardsJson(feed: io.joryio.sdk.cards.CardFeed, page: Boolean): String {
        if (!page) lastCards.clear()
        feed.cards.forEach { lastCards[it.id] = it }
        return feed.toJson()
    }

    /** `cursor`: a feed's `nextCursor` for the next page, null for the feed. */
    @ReactMethod
    fun getCards(cursor: String?, promise: Promise) {
        if (!Joryio.isInitialized()) {
            promise.resolve(io.joryio.sdk.cards.CardFeed.EMPTY.toJson())
            return
        }
        val c = cursor?.takeIf { it.isNotEmpty() }
        Joryio.getInstance().getCards(c) { feed ->
            promise.resolve(cardsJson(feed, page = c != null))
        }
    }

    /** From the native cache, never a network call. */
    @ReactMethod
    fun getUnreadCardCount(promise: Promise) {
        promise.resolve(if (Joryio.isInitialized()) Joryio.getInstance().getUnreadCardCount() else 0)
    }

    @ReactMethod
    fun markCardViewed(cardId: String?) {
        val id = cardId?.takeIf { it.isNotEmpty() } ?: return
        if (!Joryio.isInitialized()) return
        val sdk = Joryio.getInstance()
        lastCards[id]?.let { sdk.markCardViewed(it) } ?: sdk.markCardViewed(id)
    }

    @ReactMethod
    fun markCardRead(cardId: String?) {
        val id = cardId?.takeIf { it.isNotEmpty() } ?: return
        if (!Joryio.isInitialized()) return
        val sdk = Joryio.getInstance()
        lastCards[id]?.let { sdk.markCardRead(it) } ?: sdk.markCardRead(id)
    }

    @ReactMethod
    fun markCardClicked(cardId: String?) {
        val id = cardId?.takeIf { it.isNotEmpty() } ?: return
        if (!Joryio.isInitialized()) return
        val sdk = Joryio.getInstance()
        lastCards[id]?.let { sdk.markCardClicked(it) } ?: sdk.markCardClicked(id)
    }

    @ReactMethod
    fun dismissCard(cardId: String?) {
        val id = cardId?.takeIf { it.isNotEmpty() } ?: return
        if (!Joryio.isInitialized()) return
        val sdk = Joryio.getInstance()
        lastCards[id]?.let { sdk.dismissCard(it) } ?: sdk.dismissCard(id)
    }

    /** Queued until initialize() by the native companion, like refreshPlacements. */
    @ReactMethod
    fun refreshCards() {
        Joryio.refreshCards()
    }

    @ReactMethod
    fun enableCardsUpdates() {
        if (cardsSubscription != null || !Joryio.isInitialized()) return
        cardsSubscription = Joryio.getInstance().onCardsUpdated { feed ->
            val params = Arguments.createMap().apply { putString("json", cardsJson(feed, page = false)) }
            reactApplicationContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit("JoryioCardsUpdated", params)
        }
    }

    @ReactMethod
    fun disableCardsUpdates() {
        cardsSubscription?.cancel()
        cardsSubscription = null
    }

    // ── Links (setLinkHandler) ─────────────────────────────────────────

    /** Links waiting for the JS handler's answer, oldest first; bounded so a JS side that never answers costs little. */
    private val pendingLinks = java.util.LinkedHashMap<String, io.joryio.sdk.core.JoryioLink>()
    private var nextLinkId = 0

    /**
     * JS set a link handler: every link the native SDK is about to open goes
     * to JS first (event `JoryioLink`) and waits there for [completeLink]. The
     * native handler takes the link at once - a bridge cannot answer
     * synchronously - and JS hands a declined one back through completeLink.
     * The handler is app-wide in the native SDK, so this works before
     * initialize().
     */
    @ReactMethod
    fun enableLinkHandler() {
        linkOwner.set(ownerToken)
        Joryio.setLinkHandler { link ->
            if (!reactApplicationContext.hasActiveReactInstance()) return@setLinkHandler false
            val id = synchronized(pendingLinks) {
                nextLinkId += 1
                val next = "l$nextLinkId"
                pendingLinks[next] = link
                while (pendingLinks.size > MAX_PENDING_LINKS) pendingLinks.remove(pendingLinks.keys.first())
                next
            }
            val params = Arguments.createMap().apply {
                putString("linkId", id)
                putString("url", link.url)
                putString("source", link.source.wire)
                putBoolean("isAppDeepLink", link.isAppDeepLink)
                link.campaignId?.let { putString("campaignId", it) }
                link.placementKey?.let { putString("placementKey", it) }
                link.itemId?.let { putString("itemId", it) }
                link.cardId?.let { putString("cardId", it) }
            }
            reactApplicationContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit("JoryioLink", params)
            true
        }
    }

    @ReactMethod
    fun disableLinkHandler() {
        if (linkOwner.compareAndSet(ownerToken, null)) Joryio.clearLinkHandler()
    }

    /** The JS handler's answer: `handled` false opens the link as the SDK does without a handler. */
    @ReactMethod
    fun completeLink(linkId: String?, handled: Boolean?) {
        if (linkId == null) return
        val link = synchronized(pendingLinks) { pendingLinks.remove(linkId) } ?: return
        if (handled != true) link.openDefault()
    }

    /**
     * Forget local frequency state so a campaign can be re-tested.
     *
     * Also previously iOS-only, and the JS doc said Android had "no
     * already-displayed filter at all - nothing to reset". That is out of date:
     * Joryio.kt:1102 clears the per-campaign impression history and the
     * cross-campaign gap, which is exactly the state that suppresses a repeat
     * on Android. It is debug-gated natively, so a release build is unaffected.
     */
    @ReactMethod
    fun resetDisplayedCampaigns() {
        Joryio.resetDisplayedCampaigns()
    }

    @ReactMethod
    fun enableInAppMessages(capabilities: ReadableArray?) {
        // This module now owns the native callback; see invalidate().
        inAppOwner.set(ownerToken)
        // What THIS app can render, declared from JS.
        //
        // The SDK's own capability list describes the SDK's own views, and those
        // views stop running the moment this callback is set - here they never
        // run at all, because React Native always renders. Worse, `content.html`
        // was derived from a NATIVE config flag describing a native renderer:
        // an RN app with react-native-webview can draw HTML and may have been
        // reporting that it cannot, while one without it may have been
        // reporting that it can. Both directions are wrong, and the server reads
        // an absent capability as "cannot" rather than "unknown".
        //
        // Null keeps the previous behaviour, so an app that does not declare is
        // unchanged.
        // Empty means NOT DECLARED (null), never "can draw nothing" - the same
        // reading as the iOS bridge and the JS layer.
        val declared = capabilities?.let { arr ->
            (0 until arr.size()).mapNotNull { i ->
                if (arr.getType(i) == ReadableType.String) arr.getString(i) else null
            }
                .filter { it.isNotEmpty() }
                .takeIf { it.isNotEmpty() }
        }
        Joryio.whenReady { sdk -> sdk.setInAppMessageCallback({ campaign ->
            val content = campaign.content
            if (content == null) {
                Log.w(TAG, "Campaign ${campaign.id} has no content; not emitting")
                return@setInAppMessageCallback
            }

            val params = Arguments.createMap().apply {
                putString("id", campaign.id)
                putString("name", campaign.name)
                // Wire value, not the enum name: JS types this as
                // 'modal' | 'banner' | 'slideup' | 'fullscreen' | 'custom'.
                putString("type", campaign.type.name.lowercase())
                putInt("priority", campaign.priority)

                // Both content kinds reach JS. A React Native app renders its
                // own UI, so dropping native here would mean native campaigns
                // never display in RN apps at all - while showing up as
                // delivered server-side.
                when (content) {
                    is InAppContent.Html -> {
                        putString("kind", "html")
                        putString("html", content.html)
                        putString("css", content.css)
                        // The resolved width cap (modal / slideup only); the
                        // host draws the message, so it needs the number.
                        campaign.maxWidth?.let { putInt("maxWidth", it) }
                    }
                    is InAppContent.Native -> {
                        putString("kind", "native")
                        content.title?.let { putString("title", it) }
                        putString("body", content.body)
                        content.imageUrl?.let { putString("imageUrl", it) }
                        putBoolean("closeButton", content.closeButton)
                        putBoolean("backdropDismissible", content.backdropDismissible)
                        // Author style overrides. Forwarded rather than applied:
                        // in RN the HOST draws the message, so keeping these on
                        // the native side would resolve them and then throw them
                        // away - the campaign's colours would simply not happen.
                        content.style?.let { st ->
                            putMap(
                                "style",
                                Arguments.createMap().apply {
                                    st.backgroundColor?.let { putString("backgroundColor", it) }
                                    st.textColor?.let { putString("textColor", it) }
                                    st.primaryButtonColor?.let { putString("primaryButtonColor", it) }
                                    st.primaryButtonTextColor?.let {
                                        putString("primaryButtonTextColor", it)
                                    }
                                    st.cornerRadius?.let { putDouble("cornerRadius", it.toDouble()) }
                                    st.fontSize?.let { putDouble("fontSize", it.toDouble()) }
                                    st.titleWeight?.let { putString("titleWeight", it) }
                                    st.textAlign?.let { putString("textAlign", it) }
                                    st.fontFamily?.let { putString("fontFamily", it) }
                                },
                            )
                        }
                        putArray(
                            "buttons",
                            Arguments.createArray().apply {
                                content.buttons.forEach { b ->
                                    pushMap(
                                        Arguments.createMap().apply {
                                            putString("id", b.id)
                                            putString("text", b.text)
                                            putString("action", b.action.name.lowercase())
                                            b.url?.let { putString("url", it) }
                                        },
                                    )
                                }
                            },
                        )
                    }
                }
            }

            reactContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit("JoryioInAppMessage", params)
        }, declared) }
    }

    /**
     * Hand in-app rendering back to the native SDK. The JS layer calls this
     * when its last onInAppMessage listener unsubscribes; before it existed,
     * messages kept being handed to JS after that and nobody drew them, for the
     * rest of the session.
     */
    @ReactMethod
    fun disableInAppMessages() {
        inAppOwner.compareAndSet(ownerToken, null)
        Joryio.whenReady { it.clearInAppMessageCallback() }
    }

    @ReactMethod
    fun trackInAppImpression(campaignId: String?, action: String?, elementId: String?) {
        if (!present("trackInAppImpression", "campaignId", campaignId)) return
        if (!present("trackInAppImpression", "action", action)) return
        val element = elementId?.takeIf { it.isNotEmpty() }
        Joryio.whenReady { it.trackInAppImpression(campaignId, action, element) }
    }

    /**
     * A form inside an HTML message the app rendered itself. Resolves with the
     * server's verdict as a JSON string ({ ok, message?, redirect?, errors? });
     * never rejects. Mirrors sdk-android `Joryio.submitInAppForm`.
     */
    @ReactMethod
    fun submitInAppForm(campaignId: String?, values: ReadableMap?, promise: Promise) {
        if (!present("submitInAppForm", "campaignId", campaignId)) {
            promise.resolve("{\"ok\":false,\"message\":\"Something went wrong. Please try again.\"}")
            return
        }
        Joryio.whenReady { sdk ->
            sdk.submitInAppForm(campaignId, values.toProps()) { json -> promise.resolve(json) }
        }
    }

    // ─── SDK Authentication ────────────────────────────────────────────────

    /**
     * Through the companion setter, not whenReady (contract v8 84). Before
     * initialize() it records the token for the constructor, which applies it
     * ahead of its first requests (Session Start, in-app sync, outbox drain),
     * and keeps it through a pre-init wipeData(), which retires it to the
     * erased person's own withdrawals. Via whenReady it was an ordinary
     * buffered action: applied only after those first requests, and deleted
     * by a pre-init wipe, so the erased person's unsubscribe went out with no
     * token and was lost under SDK auth.
     */
    @ReactMethod
    fun setSdkAuthenticationToken(token: String?) {
        if (!present("setSdkAuthenticationToken", "token", token)) return
        Joryio.setSdkAuthenticationToken(token)
    }

    /**
     * Through the companion setter for the same reasons as the token: set
     * before initialize(), the handler is installed by the constructor and
     * hears a 401 on the first requests, and a pre-init wipe keeps it.
     */
    @ReactMethod
    fun enableSdkAuthenticationErrors() {
        authOwner.set(ownerToken)
        Joryio.setSdkAuthenticationErrorHandler { error ->
            val params = Arguments.createMap().apply {
                // enum name (e.g. SUB_MISMATCH) → wire reason ("sub_mismatch"),
                // matching the JS SdkAuthError.reason union.
                putString("reason", error.reason.name.lowercase())
                error.rawReason?.let { putString("rawReason", it) }
                // All four fields, on both platforms - see the iOS emitter. A JS
                // handler that signs the user out on refreshExhausted used to be
                // dead code on Android, because the field only existed on iOS.
                error.endpoint?.let { putString("endpoint", it) }
                putBoolean("refreshExhausted", error.refreshExhausted)
            }

            reactContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit("JoryioSdkAuthError", params)
        }
    }

    // ─── Feature flags (BACKLOG D446) ─────────────────────────────────────
    //
    // Every getter carries the app's key AND default to the native getter
    // (the companion: the default before initialize()), which answers
    // value-or-default and logs the exposure as for a Kotlin caller. getFlag
    // and getJsonFlag resolve `{ value }`, so a JSON null stays null in JS.

    /** The one native subscription this module holds; closed in invalidate(). */
    private var flagsSubscription: io.joryio.sdk.JoryioSubscription? = null

    @ReactMethod
    fun getFlag(key: String?, defaultValue: Dynamic?, promise: Promise) {
        val fallback = fromDynamic(defaultValue)
        promise.resolve(wrapFlagValue(if (key.isNullOrEmpty()) fallback else Joryio.getFlag(key, fallback)))
    }

    @ReactMethod
    fun getBoolFlag(key: String?, defaultValue: Dynamic?, promise: Promise) {
        // Dynamic, not Boolean: a JS null would throw before the method ran.
        val fallback = fromDynamic(defaultValue) as? Boolean ?: false
        promise.resolve(if (key.isNullOrEmpty()) fallback else Joryio.getBoolFlag(key, fallback))
    }

    @ReactMethod
    fun getStringFlag(key: String?, defaultValue: String?, promise: Promise) {
        val fallback = defaultValue ?: ""
        promise.resolve(if (key.isNullOrEmpty()) fallback else Joryio.getStringFlag(key, fallback))
    }

    @ReactMethod
    fun getNumberFlag(key: String?, defaultValue: Dynamic?, promise: Promise) {
        // Dynamic, not Double: a JS null would throw before the method ran.
        val fallback = fromDynamic(defaultValue) as? Double ?: 0.0
        promise.resolve(if (key.isNullOrEmpty()) fallback else Joryio.getNumberFlag(key, fallback))
    }

    @ReactMethod
    fun getJsonFlag(key: String?, defaultValue: Dynamic?, promise: Promise) {
        val fallback = fromDynamic(defaultValue)
        promise.resolve(wrapFlagValue(if (key.isNullOrEmpty()) fallback else Joryio.getJsonFlag(key, fallback)))
    }

    /** Every flag held, key -> value. Logs no exposure. */
    @ReactMethod
    fun getAllFlags(promise: Promise) {
        promise.resolve(Arguments.makeNativeMap(Joryio.getAllFlags()))
    }

    /** Resolves once the answer is in (or the request failed: the held flags stay). */
    @ReactMethod
    fun refreshFlags(promise: Promise) {
        Joryio.refreshFlags { promise.resolve(null) }
    }

    /** Start JoryioFlagsUpdated events (one native subscription; JS fans out). */
    @ReactMethod
    fun enableFlagsUpdates() {
        synchronized(this) {
            if (flagsSubscription != null) return
            flagsSubscription = Joryio.onFlagsUpdated { keys ->
                val params = Arguments.createMap()
                params.putArray("keys", Arguments.fromList(keys))
                reactContext
                    .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                    .emit("JoryioFlagsUpdated", params)
            }
        }
    }

    private fun fromDynamic(value: Dynamic?): Any? = if (value == null) null else when (value.type) {
        ReadableType.Null -> null
        ReadableType.Boolean -> value.asBoolean()
        ReadableType.Number -> value.asDouble()
        ReadableType.String -> value.asString()
        ReadableType.Map -> value.asMap()?.toHashMap()
        ReadableType.Array -> value.asArray()?.toArrayList()
    }

    private fun wrapFlagValue(value: Any?): WritableMap {
        val map = Arguments.createMap()
        @Suppress("UNCHECKED_CAST")
        when (value) {
            null -> map.putNull("value")
            is Boolean -> map.putBoolean("value", value)
            is Number -> map.putDouble("value", value.toDouble())
            is String -> map.putString("value", value)
            is Map<*, *> -> map.putMap("value", Arguments.makeNativeMap(value as Map<String, Any?>))
            is List<*> -> map.putArray("value", Arguments.makeNativeArray(value))
            else -> map.putString("value", value.toString())
        }
        return map
    }

    // ─── Utilities ─────────────────────────────────────────────────────────

    @ReactMethod
    fun flush() {
        Joryio.flush()
    }

    @ReactMethod
    fun getAnonymousId(promise: Promise) {
        promise.resolve(if (Joryio.isInitialized()) Joryio.getInstance().getAnonymousId() else null)
    }

    /**
     * Diagnostics: which server the SDK is talking to, and what went wrong last.
     *
     * Ported from iOS so the method exists on BOTH platforms. It was iOS-only,
     * which meant the one call you reach for when an integration is misbehaving
     * was missing on the platform more likely to be misbehaving.
     *
     * Returns `{ apiEndpoint, lastError? }`, matching the iOS payload exactly so
     * the JS type covers both.
     */
    @ReactMethod
    fun getDiagnostics(promise: Promise) {
        if (!Joryio.isInitialized()) {
            // Diagnostics is what an integrator calls when things look wrong,
            // which is exactly when the SDK may not be initialized. Report that
            // fact instead of throwing at them.
            val notReady = Arguments.createMap()
            notReady.putNull("apiEndpoint")
            promise.resolve(notReady)
            return
        }
        val sdk = Joryio.getInstance()
        val result = Arguments.createMap()
        result.putString("apiEndpoint", sdk.currentApiEndpoint)
        sdk.lastTransportError?.let { err ->
            val lastError = Arguments.createMap()
            lastError.putString("message", err.message)
            lastError.putBoolean("isUnauthorized", err.isUnauthorized)
            lastError.putBoolean("isRetryable", err.isRetryable)
            // Double, not Int: an epoch-ms timestamp overflows a 32-bit Int.
            lastError.putDouble("at", err.at.toDouble())
            result.putMap("lastError", lastError)
        }
        promise.resolve(result)
    }

    @ReactMethod
    fun getUserId(promise: Promise) {
        promise.resolve(if (Joryio.isInitialized()) Joryio.getInstance().getUserId() else null)
    }

    @ReactMethod
    fun getSessionId(promise: Promise) {
        promise.resolve(if (Joryio.isInitialized()) Joryio.getInstance().getSessionId() else null)
    }

    // ─── Teardown (contract item 18) ───────────────────────────────────────

    /**
     * The JS context is going away - a reload, a dev-menu refresh, the app
     * tearing React Native down. Hand the native callbacks back so they do not
     * outlive it.
     *
     * Without this, a reload left the native SDK holding the in-app callback of
     * a dead module: every message was "handed to JS", emitted into a context
     * nobody listens to, and lost - no native rendering and no JS rendering
     * until the next process start. The auth-error handler likewise kept a dead
     * context alive.
     *
     * Only the module that installed a callback releases it. On a reload the
     * new module can install its own before the old one is invalidated, and a
     * blind clear would then take the NEW one away.
     */
    override fun invalidate() {
        if (inAppOwner.compareAndSet(ownerToken, null)) {
            Joryio.clearInAppMessageCallback()
        }
        if (authOwner.compareAndSet(ownerToken, null)) {
            Joryio.setSdkAuthenticationErrorHandler(null)
        }
        // The link handler forwards to THIS module's JS; without it links open natively again.
        if (linkOwner.compareAndSet(ownerToken, null)) {
            Joryio.clearLinkHandler()
        }
        synchronized(pendingLinks) { pendingLinks.clear() }
        placementsSubscription?.cancel()
        placementsSubscription = null
        cardsSubscription?.cancel()
        cardsSubscription = null
        synchronized(this) {
            flagsSubscription?.cancel()
            flagsSubscription = null
        }
        super.invalidate()
    }

    /** Identity of this module instance for the owner checks above. Holds nothing. */
    private val ownerToken = Any()


    // Required for NativeEventEmitter
    @ReactMethod
    fun addListener(eventName: String?) {}

    @ReactMethod
    fun removeListeners(count: Int) {}

    private companion object {
        const val TAG = "JoryioModule"

        /**
         * Android keys only (contract v5 60). The backend issues one key per
         * app as `jry_sdk_<platform>_<random>`, so an iOS or web key here
         * would file this device's data under the other app and send its push
         * with that app's credentials. `jry_sdk_` alone let them through.
         */
        const val SDK_KEY_PREFIX = "jry_sdk_android_"

        /** The module whose callback the native SDK currently holds; see invalidate(). */
        val inAppOwner = AtomicReference<Any?>(null)
        val authOwner = AtomicReference<Any?>(null)
        val linkOwner = AtomicReference<Any?>(null)

        /** Links held at once for the JS link handler's answer (enableLinkHandler). */
        const val MAX_PENDING_LINKS = 32

        /**
         * How long after returning to the foreground a permission answer may
         * take to arrive before the current status is reported instead.
         */
        const val PERMISSION_ANSWER_GRACE_MS = 1000L
    }
}
