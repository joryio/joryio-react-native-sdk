package io.joryio.reactnative

import android.content.Context
import android.view.View
import android.widget.FrameLayout
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactContext
import com.facebook.react.bridge.WritableMap
import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.annotations.ReactProp
import com.facebook.react.uimanager.events.RCTEventEmitter
import io.joryio.sdk.ui.CardFeedView

/**
 * The native view behind `<JoryioCardFeed />` (D444 Phase 3): the Android SDK's
 * own CardFeedView, so the feed, paging, viewability (viewed then read), the
 * clicked / dismissed reports and the link rule are exactly the native ones -
 * one implementation per platform.
 *
 * React Native lays out only the views it created, so this wrapper measures
 * and lays out the CardFeedView itself to the size React Native gave it.
 * App deep links (`myapp://...`) go to JS (`onCardDeepLink`); http(s) opens in
 * the browser natively; any other scheme is never opened.
 */
class JoryioCardFeedViewManager : SimpleViewManager<JoryioCardFeedHost>() {
    override fun getName() = "JoryioCardFeedView"

    override fun createViewInstance(context: ThemedReactContext) = JoryioCardFeedHost(context)

    @ReactProp(name = "emptyText")
    fun setEmptyText(view: JoryioCardFeedHost, text: String?) {
        view.feed.emptyText = text ?: "No messages yet"
    }

    @ReactProp(name = "pinnedLabel")
    fun setPinnedLabel(view: JoryioCardFeedHost, text: String?) {
        view.feed.pinnedLabel = text ?: "Pinned"
    }

    @ReactProp(name = "dismissLabel")
    fun setDismissLabel(view: JoryioCardFeedHost, text: String?) {
        view.feed.dismissLabel = text ?: "Dismiss"
    }

    @ReactProp(name = "unreadLabel")
    fun setUnreadLabel(view: JoryioCardFeedHost, text: String?) {
        view.feed.unreadLabel = text ?: "Unread"
    }

    override fun getExportedCustomDirectEventTypeConstants(): Map<String, Any> = mapOf(
        "onCardFeedRender" to mapOf("registrationName" to "onCardFeedRender"),
        "onCardDeepLink" to mapOf("registrationName" to "onCardDeepLink"),
    )
}

class JoryioCardFeedHost(context: Context) : FrameLayout(context) {
    val feed = CardFeedView(context)

    // Nullable: FrameLayout's constructor calls requestLayout before this is set.
    private val relayout: Runnable? = Runnable { measureAndLayout() }

    init {
        addView(feed, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
        feed.onRender = { f ->
            relayout?.let { post(it) }
            emit("onCardFeedRender", Arguments.createMap().apply {
                putInt("cardCount", f.cards.size)
                putInt("unreadCount", f.unreadCount)
            })
        }
        // App deep links go to JS, which routes them (the view opens only http(s)).
        feed.onDeepLink = { url, card ->
            emit("onCardDeepLink", Arguments.createMap().apply {
                putString("url", url)
                putString("cardId", card.id)
            })
        }
    }

    private fun emit(name: String, body: WritableMap) {
        (context as? ReactContext)?.getJSModule(RCTEventEmitter::class.java)?.receiveEvent(id, name, body)
    }

    private fun measureAndLayout() {
        if (width <= 0 || height <= 0) return
        feed.measure(
            View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY),
        )
        feed.layout(0, 0, width, height)
    }

    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
        measureAndLayout()
    }

    override fun requestLayout() {
        super.requestLayout()
        // Cards change size (an image arrives, a card is dismissed); React
        // Native would not lay the native children out again.
        relayout?.let { post(it) }
    }
}
