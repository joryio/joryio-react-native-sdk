/**
 * SDK 1.3.2: an app that subscribes with onInAppMessage must never get a
 * message drawn natively. Found testing 1.3.1-beta.2: on Android the first
 * sync after initialize() drew a message ("Displaying campaign" in logcat)
 * before the JS subscription - held until initialize() completed - reached
 * native. Native now starts holding on every initialize(), and JS ends the
 * hold once the held calls have run.
 */
import { flush, loadSdk, makeNative } from './helpers';

beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe('the start-up in-app hold', () => {
  it('native is always told to hold in-app messages at initialize()', async () => {
    const native = makeNative();
    const { default: Joryio } = loadSdk(native);
    await Joryio.initialize('jry_sdk_ios_x', 'h', {});
    expect(native.initialize.mock.calls[0][2]).toMatchObject({ holdInAppMessagesForHandler: true });
  });

  it('a listener subscribed before initialize() completed takes the hold - nothing is handed back to native', async () => {
    const native = makeNative();
    const { default: Joryio } = loadSdk(native);
    const init = Joryio.initialize('jry_sdk_android_x', 'h');
    // The race in the bug: subscribed AFTER initialize() was called, before it completed.
    Joryio.onInAppMessage(() => {});
    await init;
    await flush();
    expect(native.enableInAppMessages).toHaveBeenCalledTimes(1);
    expect(native.disableInAppMessages).not.toHaveBeenCalled();
    expect(native.initialize.mock.invocationCallOrder[0]).toBeLessThan(
      native.enableInAppMessages.mock.invocationCallOrder[0],
    );
  });

  it('a listener subscribed before initialize() was called takes the hold too', async () => {
    const native = makeNative();
    const { default: Joryio } = loadSdk(native);
    Joryio.onInAppMessage(() => {});
    await Joryio.initialize('jry_sdk_ios_x', 'h');
    await flush();
    expect(native.enableInAppMessages).toHaveBeenCalledTimes(1);
    expect(native.disableInAppMessages).not.toHaveBeenCalled();
  });

  it('with nobody listening, the hold ends with native drawing once initialize() completes', async () => {
    const native = makeNative();
    const { default: Joryio } = loadSdk(native);
    await Joryio.initialize('jry_sdk_ios_x', 'h');
    await flush();
    expect(native.enableInAppMessages).not.toHaveBeenCalled();
    expect(native.disableInAppMessages).toHaveBeenCalledTimes(1);
  });

  it('a direct enableInAppMessages() before initialize() completed keeps the hand-off too', async () => {
    const native = makeNative();
    const { default: Joryio } = loadSdk(native);
    Joryio.enableInAppMessages(['content.native']);
    await Joryio.initialize('jry_sdk_ios_x', 'h');
    await flush();
    expect(native.enableInAppMessages).toHaveBeenCalledWith(['content.native']);
    expect(native.disableInAppMessages).not.toHaveBeenCalled();
  });

  it('subscribe-then-unsubscribe before init still ends the hold with native drawing', async () => {
    const native = makeNative();
    const { default: Joryio } = loadSdk(native);
    const off = Joryio.onInAppMessage(() => {});
    off();
    await Joryio.initialize('jry_sdk_ios_x', 'h');
    await flush();
    const disables = native.disableInAppMessages.mock.invocationCallOrder;
    expect(disables.length).toBeGreaterThanOrEqual(1);
    // Native ends with no JS renderer: the last call is a disable.
    expect(disables[disables.length - 1]).toBeGreaterThan(native.enableInAppMessages.mock.invocationCallOrder[0]);
  });

  it('holdInAppMessagesForHandler: true keeps the hold for a listener that subscribes later', async () => {
    const native = makeNative();
    const { default: Joryio } = loadSdk(native);
    await Joryio.initialize('jry_sdk_android_x', 'h', { holdInAppMessagesForHandler: true });
    await flush();
    expect(native.disableInAppMessages).not.toHaveBeenCalled();
    // A screen that mounts later.
    Joryio.onInAppMessage(() => {});
    expect(native.enableInAppMessages).toHaveBeenCalledTimes(1);
  });

  it('a failed initialize() does not end the hold; the retry that succeeds does', async () => {
    let attempt = 0;
    const native = makeNative({
      initialize: jest.fn(async () => {
        attempt += 1;
        if (attempt === 1) throw new Error('bad key');
        return null;
      }),
    });
    const { default: Joryio } = loadSdk(native);
    await Joryio.initialize('jry_sdk_android_WRONG', 'h');
    expect(native.disableInAppMessages).not.toHaveBeenCalled();
    await Joryio.initialize('jry_sdk_android_ok', 'h');
    await flush();
    expect(native.disableInAppMessages).toHaveBeenCalledTimes(1);
    expect(native.initialize.mock.calls[1][2]).toMatchObject({ holdInAppMessagesForHandler: true });
  });
});

describe('the native bridges read holdInAppMessagesForHandler', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('fs');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const path = require('path');
  const read = (f: string) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

  it('Android copies it into JoryioConfig', () => {
    expect(read('android/src/main/java/io/joryio/reactnative/JoryioModule.kt')).toMatch(
      /config\.optBoolean\("holdInAppMessagesForHandler"\)\?\.let \{\s*joryioConfig = joryioConfig\.copy\(holdInAppMessagesForHandler = it\)/,
    );
  });

  it('iOS passes it into InAppConfig on both config paths', () => {
    const src = read('ios/JoryioModule.swift');
    expect(src).toMatch(/config\["holdInAppMessagesForHandler"\] as\? Bool \?\? false/);
    expect(src.match(/holdInAppMessagesForHandler: holdInAppMessagesForHandler/g)).toHaveLength(2);
  });
});
