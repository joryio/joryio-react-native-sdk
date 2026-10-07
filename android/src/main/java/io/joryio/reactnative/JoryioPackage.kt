package io.joryio.reactnative

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/**
 * React Native package that registers the Joryio native module.
 *
 * AUTOLINKED - do not add it to MainApplication yourself. react-native.config.js
 * tells the CLI to instantiate this class, so `PackageList(this).packages`
 * already contains it; adding it again registers "JoryioModule" twice, which
 * React Native rejects at start-up.
 *
 * Runs on the New Architecture through React Native's interop layer (a legacy
 * bridge module, no codegen spec), and on the old architecture as before.
 */
class JoryioPackage : ReactPackage {
    override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> {
        return listOf(JoryioModule(reactContext))
    }

    override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> {
        return emptyList()
    }
}
