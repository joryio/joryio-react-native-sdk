import * as fs from 'fs';
import * as path from 'path';
import { flush, loadSdk, makeNative } from './helpers';

/**
 * Feature flags (BACKLOG D446): the bridge routes every call to the native
 * SDK, which holds the answer and logs exposures. Every argument - key AND
 * default - reaches native on both platforms.
 */
describe('feature flags', () => {
  const root = path.join(__dirname, '..');
  const kt = fs.readFileSync(path.join(root, 'android/src/main/java/io/joryio/reactnative/JoryioModule.kt'), 'utf8');
  const swift = fs.readFileSync(path.join(root, 'ios/JoryioModule.swift'), 'utf8');
  const objc = fs.readFileSync(path.join(root, 'ios/JoryioModule.m'), 'utf8');

  it.each(['ios', 'android'] as const)('%s: the typed getters pass the key and the default to native and resolve its answer', async (os) => {
    const native = makeNative({
      getBoolFlag: jest.fn().mockResolvedValue(true),
      getStringFlag: jest.fn().mockResolvedValue('Hello'),
      getNumberFlag: jest.fn().mockResolvedValue(5),
    });
    const { default: Joryio } = loadSdk(native, os);
    await Joryio.initialize(`jry_sdk_${os}_x`, 'h');
    await expect(Joryio.getBoolFlag('new_checkout', false)).resolves.toBe(true);
    await expect(Joryio.getStringFlag('headline', 'Welcome')).resolves.toBe('Hello');
    await expect(Joryio.getNumberFlag('limit', 20)).resolves.toBe(5);
    expect(native.getBoolFlag).toHaveBeenCalledWith('new_checkout', false);
    expect(native.getStringFlag).toHaveBeenCalledWith('headline', 'Welcome');
    expect(native.getNumberFlag).toHaveBeenCalledWith('limit', 20);
  });

  it('getFlag and getJsonFlag pass the default and unwrap { value }, keeping a JSON null', async () => {
    const native = makeNative({
      getFlag: jest.fn().mockResolvedValue({ value: null }),
      getJsonFlag: jest.fn().mockResolvedValue({ value: { plan: 'pro' } }),
    });
    const { default: Joryio } = loadSdk(native, 'ios');
    await Joryio.initialize('jry_sdk_ios_x', 'h');
    await expect(Joryio.getFlag('banner', 'teal')).resolves.toBeNull();
    await expect(Joryio.getJsonFlag('pricing', { plan: 'basic' })).resolves.toEqual({ plan: 'pro' });
    expect(native.getFlag).toHaveBeenCalledWith('banner', 'teal');
    expect(native.getJsonFlag).toHaveBeenCalledWith('pricing', { plan: 'basic' });
  });

  it('a native failure or a missing key answers the default, never throws', async () => {
    const native = makeNative({ getBoolFlag: jest.fn().mockRejectedValue(new Error('boom')) });
    const { default: Joryio } = loadSdk(native, 'android');
    await Joryio.initialize('jry_sdk_android_x', 'h');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(Joryio.getBoolFlag('x', true)).resolves.toBe(true);
    await expect(Joryio.getStringFlag('', 'd')).resolves.toBe('d');
    expect(native.getStringFlag).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('without the native module every getter answers the default', async () => {
    const { default: Joryio } = loadSdk(null, 'ios');
    await expect(Joryio.getNumberFlag('limit', 3)).resolves.toBe(3);
    await expect(Joryio.getAllFlags()).resolves.toEqual({});
    await expect(Joryio.refreshFlags()).resolves.toBeUndefined();
  });

  it('getAllFlags and refreshFlags reach native', async () => {
    const native = makeNative({
      getAllFlags: jest.fn().mockResolvedValue({ a: true }),
      refreshFlags: jest.fn().mockResolvedValue(null),
    });
    const { default: Joryio } = loadSdk(native, 'android');
    await Joryio.initialize('jry_sdk_android_x', 'h');
    await expect(Joryio.getAllFlags()).resolves.toEqual({ a: true });
    await expect(Joryio.refreshFlags()).resolves.toBeUndefined();
    expect(native.refreshFlags).toHaveBeenCalled();
  });

  it('onFlagsUpdated: enabled on native after initialize, delivers keys, unsubscribes', async () => {
    const native = makeNative();
    const { default: Joryio } = loadSdk(native, 'ios');
    const seen: string[][] = [];
    const off = Joryio.onFlagsUpdated((keys) => seen.push(keys));
    expect(native.enableFlagsUpdates).not.toHaveBeenCalled();
    await Joryio.initialize('jry_sdk_ios_x', 'h');
    await flush();
    expect(native.enableFlagsUpdates).toHaveBeenCalled();
    const listeners = native.__listeners.get('JoryioFlagsUpdated')!;
    listeners.forEach((cb) => cb({ keys: ['headline', 7] }));
    expect(seen).toEqual([['headline']]);
    off();
    expect(native.__listeners.get('JoryioFlagsUpdated')!.size).toBe(0);
  });

  it('both bridges bind the eight names with every argument, and call the native SDK', () => {
    for (const m of ['getFlag', 'getJsonFlag']) {
      expect(kt).toMatch(new RegExp(`fun ${m}\\(key: String\\?, defaultValue: Dynamic\\?, promise: Promise\\)`));
      expect(kt).toContain(`Joryio.${m}(key, fallback)`);
      expect(swift).toMatch(new RegExp(`@objc func ${m}\\(_ key: String\\?, defaultValue: Any\\?, resolve:`));
      expect(swift).toContain(`Joryio.shared.${m}(key, default: fallback)`);
      expect(objc).toMatch(new RegExp(`RCT_EXTERN_METHOD\\(${m}:\\(NSString \\*\\)key\\s+defaultValue:\\(id\\)defaultValue`));
    }
    for (const [m, kType, sType, oType] of [
      ['getBoolFlag', 'Dynamic\\?', 'Bool', 'BOOL'],
      ['getStringFlag', 'String\\?', 'String\\?', 'NSString \\*'],
      ['getNumberFlag', 'Dynamic\\?', 'Double', 'double'],
    ]) {
      expect(kt).toMatch(new RegExp(`fun ${m}\\(key: String\\?, defaultValue: ${kType}, promise: Promise\\)`));
      expect(kt).toMatch(new RegExp(`Joryio\\.${m}\\(key, fallback\\)`));
      expect(swift).toMatch(new RegExp(`@objc func ${m}\\(_ key: String\\?, defaultValue: ${sType}, resolve:`));
      expect(swift).toMatch(new RegExp(`Joryio\\.shared\\.${m}\\(key, default: (defaultValue|fallback)\\)`));
      expect(objc).toMatch(new RegExp(`RCT_EXTERN_METHOD\\(${m}:\\(NSString \\*\\)key\\s+defaultValue:\\(${oType}\\)defaultValue`));
    }
    expect(kt).toContain('Joryio.getAllFlags()');
    expect(kt).toContain('Joryio.refreshFlags {');
    expect(kt).toContain('Joryio.onFlagsUpdated {');
    expect(swift).toContain('Joryio.shared.getAllFlags()');
    expect(swift).toContain('Joryio.shared.refreshFlags {');
    expect(swift).toContain('Joryio.shared.onFlagsUpdated {');
    expect(swift).toContain('"JoryioFlagsUpdated"');
    expect(objc).toContain('RCT_EXTERN_METHOD(enableFlagsUpdates)');
  });
});
