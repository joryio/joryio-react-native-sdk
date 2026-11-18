/**
 * Click-link identity: identifyFromLink(url) hands the URL that opened the app
 * to the native SDK unchanged (native reads `jr_t` and applies the rules). The
 * JS layer only skips a URL that cannot carry the token, and holds the call
 * before initialize() like every other data call.
 */
import { flush, loadSdk, makeNative } from './helpers';

beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const TOKEN = 'AbCdEfGhIjKlMnOp_qrstuv-0123456789'; // gitleaks:allow - a fake jr_t test token
const LINK = `https://shop.example.com/sale?utm_source=joryio&jr_cid=c1&jr_t=${TOKEN}#top`;

describe('identifyFromLink', () => {
  it('passes the url through to native unchanged', async () => {
    const native = makeNative();
    const { default: Joryio, CLICK_IDENTITY_PARAM } = loadSdk(native);
    expect(CLICK_IDENTITY_PARAM).toBe('jr_t');
    await Joryio.initialize('jry_sdk_ios_ok', 'host');
    Joryio.identifyFromLink(LINK);
    await flush();
    expect(native.identifyFromLink).toHaveBeenCalledTimes(1);
    expect(native.identifyFromLink).toHaveBeenCalledWith(LINK);
  });

  it('does not call native for a url without jr_t, or for a non-string', async () => {
    const native = makeNative();
    const { default: Joryio } = loadSdk(native);
    await Joryio.initialize('jry_sdk_ios_ok', 'host');
    Joryio.identifyFromLink('https://shop.example.com/sale?jr_cid=c1');
    Joryio.identifyFromLink('https://shop.example.com/sale#jr_t=' + TOKEN);
    Joryio.identifyFromLink('https://shop.example.com/sale?xjr_t=' + TOKEN);
    Joryio.identifyFromLink(undefined as unknown as string);
    Joryio.identifyFromLink('');
    await flush();
    expect(native.identifyFromLink).not.toHaveBeenCalled();
  });

  it('is held before initialize() and passed through after it', async () => {
    const native = makeNative();
    const { default: Joryio } = loadSdk(native);
    Joryio.identifyFromLink(LINK);
    await flush();
    expect(native.identifyFromLink).not.toHaveBeenCalled();
    await Joryio.initialize('jry_sdk_ios_ok', 'host');
    await flush();
    expect(native.identifyFromLink).toHaveBeenCalledWith(LINK);
  });

  it('made before initialize() while opted out, it is dropped like other data calls', async () => {
    const native = makeNative();
    const { default: Joryio } = loadSdk(native);
    Joryio.optOut();
    Joryio.identifyFromLink(LINK);
    Joryio.optIn();
    await Joryio.initialize('jry_sdk_ios_ok', 'host');
    await flush();
    expect(native.identifyFromLink).not.toHaveBeenCalled();
  });

  it('never throws without the native module', () => {
    const { default: Joryio } = loadSdk(null);
    expect(() => Joryio.identifyFromLink(LINK)).not.toThrow();
  });
});
