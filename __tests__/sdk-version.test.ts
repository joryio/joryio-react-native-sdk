import { loadSdk, makeNative } from './helpers';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkg = require('../package.json');

/**
 * D427: the bridge hands its own version to the native SDK at initialize(),
 * which sends it as X-Joryio-SDK-Wrapper-Version (with X-Joryio-SDK-Wrapper:
 * react-native) next to its own X-Joryio-SDK / X-Joryio-SDK-Version.
 */
describe('SDK version reporting', () => {
  beforeEach(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it('SDK_VERSION is this package version', () => {
    const { SDK_VERSION } = loadSdk(makeNative());
    expect(SDK_VERSION).toBe(pkg.version);
  });

  it('initialize() hands it to native as sdkWrapperVersion, whatever the app passed', async () => {
    const native = makeNative();
    const { default: Joryio, SDK_VERSION } = loadSdk(native);
    await Joryio.initialize('jry_sdk_ios_x', 'host', { sdkWrapperVersion: '0.0.1' } as any);
    const config = native.initialize.mock.calls[0][2];
    expect(config.sdkWrapperVersion).toBe(SDK_VERSION);
  });
});
