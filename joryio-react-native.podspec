require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name         = "joryio-react-native"
  s.version      = package['version']
  s.summary      = package['description']
  s.homepage     = "https://github.com/joryio/joryio-react-native-sdk"
  s.license      = { :type => 'Commercial', :file => 'LICENSE' }
  s.author       = "Joryio"
  s.platforms    = { :ios => "14.0" }
  # The bridge is Swift (`if let x` shorthand needs 5.7; the native SDK declares
  # 5.9). Without this, CocoaPods lints the pod under its own default Swift
  # version and `pod lib lint` warns that none is specified.
  s.swift_version = "5.9"
  s.source       = { :git => "https://github.com/joryio/joryio-react-native-sdk.git", :tag => s.version }
  s.source_files = "ios/**/*.{h,m,mm,swift}"

  s.dependency "React-Core"

  # Joryio/UI, not Joryio: the UI subspec pulls Core and adds native in-app
  # rendering, so a plain install displays messages without any JavaScript.
  # Calling Joryio.onInAppMessage() from JS still takes rendering over.
  #
  # PINNED EXACTLY to this package's version, like the Android bridge's Maven
  # coordinate: the SDKs release in lockstep, and this bridge calls native API
  # of that exact release. Unpinned, `pod install` resolved whatever Joryio was
  # newest, so a bridge could meet a native SDK it was never built against.
  #
  # To build the native SDK from a checkout instead, point CocoaPods at it from
  # your app's Podfile; a :path pod of the same version satisfies this pin:
  #
  #   pod 'Joryio', :path => '../path/to/joryio-ios-sdk'
  s.dependency "Joryio/UI", package['version']
end
