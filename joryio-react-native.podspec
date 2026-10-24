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

  # The native iOS SDK comes from its SWIFT PACKAGE, not from CocoaPods trunk.
  # Trunk goes read-only on 2026-12-02 (test week 2026-11-01..07): no new pod
  # version can be pushed after that, so depending on the Joryio/UI pod would
  # freeze this bridge at the last version trunk accepted. React Native's
  # `spm_dependency` (0.75+, defined by the react_native_pods.rb every React
  # Native Podfile requires) adds the package to the Pods project and links the
  # products into this pod's target; `pod install` still runs as before.
  #
  # Joryio AND JoryioUI: JoryioUI adds native in-app rendering, so a plain
  # install displays messages without any JavaScript. Calling
  # Joryio.onInAppMessage() from JS still takes rendering over.
  #
  # PINNED EXACTLY to this package's version, like the Android bridge's Maven
  # coordinate: the SDKs release in lockstep, and this bridge calls native API
  # of that exact release. The mirror repository tags every release (betas
  # too), so `exactVersion` resolves a beta as well as a final.
  #
  # To build the native SDK from a checkout instead (monorepo development),
  # set JORYIO_IOS_SDK_SPM_URL before `pod install`: another git URL, or - on
  # React Native 0.84+, whose spm_dependency accepts local paths - the absolute path
  # to a joryio-ios-sdk checkout (packages/sdk-ios in the monorepo).
  unless respond_to?(:spm_dependency, true)
    raise "joryio-react-native #{s.version} needs React Native 0.75 or newer: it links the Joryio iOS SDK " \
          "as a Swift package through React Native's spm_dependency, which this React Native does not define. " \
          "Upgrade React Native, or check that ios/Podfile requires react_native_pods.rb"
  end
  # React Native before 0.87 creates the package objects with Xcodeproj's
  # project.new, and in a CocoaPods project that can hand out a UUID another
  # object already has. On React Native 0.75 it does so on every fresh install:
  # the product dependency takes the ROOT object's UUID, and Xcode refuses the
  # result ("The project 'Pods' is damaged and cannot be opened"). React Native
  # 0.87 fixed it (spm.rb `new_object`: skip UUIDs already in use); for older
  # versions the same fix is applied here, only to the Pods project spm.rb
  # writes to. Detected by the method the fix added, not by version number.
  if defined?(SPMManager) && !SPMManager.private_method_defined?(:new_object) &&
     !Object.const_defined?(:JoryioSpmUniqueUuids)
    unique_new = Module.new do
      def new(klass)
        uuid = generate_uuid
        uuid = generate_uuid while objects_by_uuid.key?(uuid)
        object = klass.new(self, uuid)
        object.initialize_defaults
        object
      end
    end
    fix = Module.new do
      define_method(:add_spm_to_target) do |project, *args|
        project.singleton_class.prepend(unique_new) unless project.singleton_class.include?(unique_new)
        super(project, *args)
      end
      private :add_spm_to_target
    end
    Object.const_set(:JoryioSpmUniqueUuids, fix)
    SPMManager.prepend(fix)
  end
  # React Native 0.87+ builds a static pod that takes a Swift package straight
  # into the products root, so its generated module map moves from
  # "<pod>/<module>.modulemap" to "<module>.modulemap", and it rewrites the app's
  # aggregate xcconfigs to match - but it builds the old path from the POD name
  # twice ("<pod>/<pod>.modulemap"). This pod's module name is
  # joryio_react_native, not joryio-react-native, so the reference is never
  # rewritten and the app fails with "module map file
  # '.../joryio-react-native/joryio_react_native.modulemap' not found" (found
  # building a React Native 0.88.0 app for the simulator, Xcode 26.6). Rewrite
  # this pod's reference with its module name as well, in the same in-memory
  # Config objects React Native edits (later post_install steps re-save them).
  # Detected by the method that does the flattening, not by version number.
  if defined?(SPMManager) && SPMManager.private_method_defined?(:rewrite_aggregate_modulemap_references) &&
     !Object.const_defined?(:JoryioSpmModuleMapPath)
    pod_name = s.name
    module_name = pod_name.gsub(/[^A-Za-z0-9_]/, '_')
    module_map_fix = Module.new do
      define_method(:rewrite_aggregate_modulemap_references) do |installer, pod_names|
        super(installer, pod_names)
        next unless pod_names.include?(pod_name) && module_name != pod_name
        nested = "${PODS_CONFIGURATION_BUILD_DIR}/#{pod_name}/#{module_name}.modulemap"
        flat = "${PODS_CONFIGURATION_BUILD_DIR}/#{module_name}.modulemap"
        installer.aggregate_targets.each do |aggregate_target|
          aggregate_target.xcconfigs.each do |config_name, config_file|
            changed = false
            %w[OTHER_CFLAGS OTHER_SWIFT_FLAGS].each do |key|
              value = config_file.attributes[key]
              next unless value && value.include?(nested)
              config_file.attributes[key] = value.gsub(nested, flat)
              changed = true
            end
            config_file.save_as(aggregate_target.xcconfig_path(config_name)) if changed
          end
        end
      end
      private :rewrite_aggregate_modulemap_references
    end
    Object.const_set(:JoryioSpmModuleMapPath, module_map_fix)
    SPMManager.prepend(module_map_fix)
  end

  spm_dependency(
    s,
    url: ENV["JORYIO_IOS_SDK_SPM_URL"] || "https://github.com/joryio/joryio-ios-sdk.git",
    requirement: { kind: "exactVersion", version: package['version'] },
    products: ["Joryio", "JoryioUI"]
  )
end
