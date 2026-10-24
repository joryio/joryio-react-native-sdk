import { loadSdk, makeNative } from './helpers';

/**
 * A missing required e-commerce argument warns and sends nothing (contract
 * item 19). Before the fix `purchase(null)` reached the bridges, which filled
 * the gaps with defaults and tracked an Order Completed with orderId "" and a
 * total of 0 - a plausible zero in the revenue report rather than an error.
 */
beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
});

async function started() {
  const native = makeNative();
  const { default: Joryio } = loadSdk(native);
  await Joryio.initialize('jry_sdk_key', 'host');
  return { native, ecommerce: Joryio.ecommerce };
}

const nothing = null as unknown as never;

describe('e-commerce with a missing required argument', () => {
  it('purchase(null), purchase without orderId or value: nothing sent, a warning each', async () => {
    const { native, ecommerce } = await started();
    ecommerce.purchase(nothing);
    ecommerce.purchase(undefined as unknown as never);
    ecommerce.purchase({ orderId: '', items: [], value: 10 });
    ecommerce.purchase({ orderId: 'o1', items: [] } as unknown as never);
    ecommerce.purchase({ orderId: 'o1', items: [], value: NaN });
    // Contract item 42: the items array is required too.
    ecommerce.purchase({ orderId: 'o1', value: 10 } as unknown as never);
    ecommerce.purchase({ orderId: 'o1', items: null, value: 10 } as unknown as never);
    expect(native.ecommerce).not.toHaveBeenCalled();
    const warnings = (console.warn as jest.Mock).mock.calls.flat().join('\n');
    expect(warnings).toContain('ecommerce.purchase() needs an order with an orderId');
    expect(warnings).toContain('ecommerce.purchase() needs a number order.value');
    expect(warnings).toContain('ecommerce.purchase() needs an order with an items array');
  });

  it('product calls need a product with a productId', async () => {
    const { native, ecommerce } = await started();
    ecommerce.viewProduct(undefined as unknown as never);
    ecommerce.viewProduct({ name: 'x', price: 1 } as unknown as never);
    ecommerce.addToCart(nothing);
    ecommerce.removeFromCart(nothing);
    ecommerce.addToWishlist(nothing);
    ecommerce.removeFromWishlist(nothing);
    ecommerce.shareProduct(nothing, 'sms');
    ecommerce.shareProduct({ productId: 'p1', name: 'x', price: 1 }, nothing);
    expect(native.ecommerce).not.toHaveBeenCalled();
  });

  it('string and number arguments are required where the signature requires them', async () => {
    const { native, ecommerce } = await started();
    ecommerce.viewCategory(nothing, 'Shoes');
    ecommerce.search(nothing);
    ecommerce.addPaymentInfo(nothing);
    ecommerce.orderFulfilled(nothing);
    ecommerce.orderDelivered('');
    ecommerce.orderCancelled(nothing);
    ecommerce.orderRefunded(nothing);
    ecommerce.applyCoupon(nothing);
    ecommerce.removeCoupon(nothing);
    ecommerce.submitReview('p1', nothing);
    ecommerce.submitReview(nothing, 5);
    ecommerce.cartViewed(nothing, 10);
    ecommerce.updateCart([], nothing);
    ecommerce.startCheckout(undefined as unknown as never, 10);
    expect(native.ecommerce).not.toHaveBeenCalled();
  });

  it('complete calls still go through, optional arguments left out', async () => {
    const { native, ecommerce } = await started();
    const product = { productId: 'p1', name: 'Buds', price: 29.99 };
    ecommerce.viewProduct(product);
    ecommerce.purchase({ orderId: 'o1', items: [{ ...product, quantity: 1 }], value: 0 });
    ecommerce.cartViewed([], 0);
    ecommerce.submitReview('p1', 4);
    expect(native.ecommerce.mock.calls.map((c) => c[0])).toEqual([
      'viewProduct',
      'purchase',
      'cartViewed',
      'submitReview',
    ]);
  });
});

describe('one e-commerce guard set (the same table on every SDK)', () => {
  const P = { productId: 'p1', name: 'Buds', price: 10 };
  const L = { ...P, quantity: 1 };
  const refused: Array<[string, (e: any) => void]> = [
    ['viewProduct NaN price', (e) => e.viewProduct({ ...P, price: NaN })],
    ['viewProduct blank id', (e) => e.viewProduct({ ...P, productId: '   ' })],
    ['addToCart Infinity price', (e) => e.addToCart({ ...L, price: Infinity })],
    ['addToCart NaN cartValue', (e) => e.addToCart(L, NaN)],
    ['shareProduct blank method', (e) => e.shareProduct(P, ' ')],
    ['viewCategory blank name', (e) => e.viewCategory('c1', ' ')],
    ['search blank query', (e) => e.search('  ')],
    ['cartViewed id-less line', (e) => e.cartViewed([{ ...L, productId: '' }], 10)],
    ['startCheckout NaN line price', (e) => e.startCheckout([{ ...L, price: NaN }], 10)],
    ['purchase NaN tax', (e) => e.purchase({ orderId: 'o1', items: [L], value: 10, tax: NaN })],
    ['purchase bad line', (e) => e.purchase({ orderId: 'o1', items: [{ ...L, price: NaN }], value: 10 })],
    ['purchase blank order id', (e) => e.purchase({ orderId: ' ', items: [], value: 10 })],
    ['orderRefunded NaN amount', (e) => e.orderRefunded('o1', NaN)],
    ['applyCoupon NaN discount', (e) => e.applyCoupon('SAVE', NaN)],
    ['removeCoupon blank', (e) => e.removeCoupon(' ')],
  ];

  it.each(refused)('%s: nothing sent', async (_name, call) => {
    const { native, ecommerce } = await started();
    call(ecommerce);
    expect(native.ecommerce).not.toHaveBeenCalled();
  });

  it('complete calls are sent, an order with no items included', async () => {
    const { native, ecommerce } = await started();
    ecommerce.viewProduct(P);
    ecommerce.cartViewed([L, null as unknown as never], 10);
    ecommerce.purchase({ orderId: 'o1', items: [], value: 10 });
    ecommerce.orderRefunded('o1');
    expect((native.ecommerce as jest.Mock).mock.calls.map((c) => c[0])).toEqual([
      'viewProduct', 'cartViewed', 'purchase', 'orderRefunded',
    ]);
  });
});
