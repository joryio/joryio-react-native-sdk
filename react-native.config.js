/**
 * React Native autolinking manifest.
 *
 * WITHOUT THIS FILE the package is silently skipped: the app compiles, the JS
 * module resolves, `Joryio.track()` returns without complaint, and the APK
 * contains zero SDK classes. Nothing fails - you simply get no data, and the
 * only way to find out is to decompile the APK or notice an empty dashboard.
 *
 * Reported from a production integration (2026-08-23), which had to add this
 * file by hand after every re-vendor.
 */
module.exports = {
  dependency: {
    platforms: {
      android: {
        sourceDir: 'android',
        packageImportPath: 'import io.joryio.reactnative.JoryioPackage;',
        packageInstance: 'new JoryioPackage()',
      },
      ios: {
        podspecPath: __dirname + '/joryio-react-native.podspec',
      },
    },
  },
};
