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
import io.joryio.sdk.placements.PLACEMENT_PRODUCT_CARD_WIDTH
import io.joryio.sdk.ui.PlacementView

/**
 * The native view behind `<JoryioPlacement placementKey="..." />` (D444): the
 * Android SDK's own PlacementView, so fetching, viewability, the holdout and
 * the reports are exactly the native ones.
 *
 * React Native lays out only the views it created, so this wrapper measures
 * and lays out the PlacementView itself on every layout request, and tells JS
 * the content height (`onPlacementRender`) so the JS component can size the
 * spot - `collapse` gives 0.
 */
class JoryioPlacementViewManager : SimpleViewManager<JoryioPlacementHost>() {
    override fun getName() = "JoryioPlacementView"

    override fun createViewInstance(context: ThemedReactContext) = JoryioPlacementHost(context)

    @ReactProp(name = "placementKey")
    fun setPlacementKey(view: JoryioPlacementHost, key: String?) {
        view.placement.setPlacementKey(key ?: "")
    }

    // The built-in product cards row: the native PlacementView's properties.
    @ReactProp(name = "showProducts", defaultBoolean = true)
    fun setShowProducts(view: JoryioPlacementHost, show: Boolean) {
        view.placement.showProducts = show
    }

    @ReactProp(name = "productButtonText")
    fun setProductButtonText(view: JoryioPlacementHost, text: String?) {
        view.placement.productButtonText = text
    }

    @ReactProp(name = "productCardWidth", defaultInt = PLACEMENT_PRODUCT_CARD_WIDTH)
    fun setProductCardWidth(view: JoryioPlacementHost, width: Int) {
        view.placement.productCardWidth = width
    }

    override fun getExportedCustomDirectEventTypeConstants(): Map<String, Any> = mapOf(
        "onPlacementRender" to mapOf("registrationName" to "onPlacementRender"),
        "onPlacementDeepLink" to mapOf("registrationName" to "onPlacementDeepLink"),
    )
}

class JoryioPlacementHost(context: Context) : FrameLayout(context) {
    val placement = PlacementView(context)

    init {
        addView(placement, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
        placement.onRender = { p ->
            post {
                measureAndLayout()
                emit("onPlacementRender", Arguments.createMap().apply {
                    putString("placementKey", p.placementKey)
                    putInt("itemCount", p.items.size)
                    putBoolean("isControl", p.isControl)
                    putString("emptyBehavior", p.emptyBehavior)
                    putDouble("height", placement.measuredHeight / resources.displayMetrics.density.toDouble())
                })
            }
        }
        // deep_link buttons go to JS, which routes them (the SDK opens only http(s)).
        placement.onDeepLink = { url, item ->
            emit("onPlacementDeepLink", Arguments.createMap().apply {
                putString("url", url)
                putString("itemId", item.id)
            })
        }
    }

    private fun emit(name: String, body: WritableMap) {
        (context as? ReactContext)?.getJSModule(RCTEventEmitter::class.java)?.receiveEvent(id, name, body)
    }

    private fun measureAndLayout() {
        val w = if (width > 0) width else resources.displayMetrics.widthPixels
        placement.measure(
            View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED),
        )
        placement.layout(0, 0, placement.measuredWidth, placement.measuredHeight)
    }

    private val relayout = Runnable { measureAndLayout() }

    override fun requestLayout() {
        super.requestLayout()
        // Native children change size (an image arrives, the card is drawn);
        // React Native would not lay them out.
        post(relayout)
    }
}
