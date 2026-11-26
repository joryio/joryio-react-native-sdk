import * as fs from 'fs';
import * as path from 'path';
import { flush, loadSdk, makeNative } from './helpers';

/**
 * resetTo(anonymousId) (BACKLOG D366): reset(), then the caller's anonymous
 * id. The rule is checked by the native SDK (the same on every platform);
 * the bridge passes the id through on BOTH platforms.
 */
describe('resetTo', () => {
  it('reaches the native module with the id, after initialize', async () => {
    const native = makeNative();
    const { default: Joryio } = loadSdk(native, 'android');
    await Joryio.initialize('jry_sdk_android_x', 'h');
    Joryio.resetTo('jry_tracker-visitor-0001');
    await flush();
    expect(native.resetTo).toHaveBeenCalledWith('jry_tracker-visitor-0001');
  });

  it('is held before initialize and keeps a later token behind it, like reset()', async () => {
    const native = makeNative();
    const { default: Joryio } = loadSdk(native, 'ios');
    Joryio.resetTo('hp_abcdef0123456789');
    Joryio.setSdkAuthenticationToken('jwt-next');
    expect(native.resetTo).not.toHaveBeenCalled();
    expect(native.setSdkAuthenticationToken).not.toHaveBeenCalled();
    await Joryio.initialize('jry_sdk_ios_x', 'h');
    await flush();
    expect(native.resetTo).toHaveBeenCalledWith('hp_abcdef0123456789');
    expect(native.resetTo.mock.invocationCallOrder[0]).toBeLessThan(
      native.setSdkAuthenticationToken.mock.invocationCallOrder[0],
    );
  });

  it('both bridges bind it and call the native resetTo', () => {
    const root = path.join(__dirname, '..');
    const kt = fs.readFileSync(path.join(root, 'android/src/main/java/io/joryio/reactnative/JoryioModule.kt'), 'utf8');
    const swift = fs.readFileSync(path.join(root, 'ios/JoryioModule.swift'), 'utf8');
    const objc = fs.readFileSync(path.join(root, 'ios/JoryioModule.m'), 'utf8');
    expect(kt).toMatch(/fun resetTo\(anonymousId: String\?, promise: Promise\)\s*\{\s*Joryio\.resetTo\(anonymousId\) \{ adopted -> promise\.resolve\(adopted\) \}/);
    expect(swift).toMatch(/@objc func resetTo\(_ anonymousId: String\?, resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock\)\s*\{\s*Joryio\.shared\.resetTo\(anonymousId \?\? ""\) \{ adopted in resolve\(adopted\) \}/);
    expect(objc).toMatch(/RCT_EXTERN_METHOD\(resetTo:\(NSString \*\)anonymousId\s+resolve:\(RCTPromiseResolveBlock\)resolve\s+reject:\(RCTPromiseRejectBlock\)reject\)/);
  });

  it('resolves the native answer: true when adopted, false when refused', async () => {
    const native = makeNative();
    native.resetTo.mockImplementation((id: string) => Promise.resolve(id === 'jry_tracker-visitor-0001'));
    const { default: Joryio } = loadSdk(native, 'android');
    await Joryio.initialize('jry_sdk_android_x', 'h');
    await expect(Joryio.resetTo('jry_tracker-visitor-0001')).resolves.toBe(true);
    await expect(Joryio.resetTo('jry_signed-in-user-anon')).resolves.toBe(false);
  });

  it('a call held before initialize resolves once it runs', async () => {
    const native = makeNative();
    native.resetTo.mockImplementation(() => Promise.resolve(true));
    const { default: Joryio } = loadSdk(native, 'ios');
    const answer = Joryio.resetTo('hp_abcdef0123456789');
    await Joryio.initialize('jry_sdk_ios_x', 'h');
    await expect(answer).resolves.toBe(true);
  });

  it('a held call pushed out of a full hold resolves false, once - an awaiting logout never hangs', async () => {
    const native = makeNative();
    native.resetTo.mockImplementation(() => Promise.resolve(true));
    const { default: Joryio } = loadSdk(native, 'android');
    const answer = Joryio.resetTo('hp_abcdef0123456789');
    for (let i = 0; i < 1000; i++) Joryio.reset();
    await expect(answer).resolves.toBe(false);
    await Joryio.initialize('jry_sdk_android_x', 'h');
    await flush();
    expect(native.resetTo).not.toHaveBeenCalled();
  });
});
