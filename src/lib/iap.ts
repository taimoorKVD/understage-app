/**
 * Client IAP helpers. Real StoreKit still needs App Store Connect products + a sandbox
 * Apple ID (paid team). This module extracts the purchase → verify payload shape so a
 * local StoreKit Configuration / future sandbox build can present a signed JWS.
 */
import { Platform } from 'react-native';
import { IAP_PAID_APPLE_BLOCKER, IAP_PRODUCT_IDS, planFromProductId } from '../../shared/iap-products';

export { IAP_PAID_APPLE_BLOCKER, IAP_PRODUCT_IDS, planFromProductId };
export { IAP_PRODUCTS, PRODUCT_TO_PLAN, DEFAULT_IAP_BUNDLE_ID } from '../../shared/iap-products';

export type StorePurchaseResult = {
  productId: string;
  transactionId: string;
  /** iOS StoreKit 2 JWS (`purchaseToken`). Null when the native module did not provide one. */
  signedTransaction: string | null;
};

function loadExpoIap(): any {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy native module; absent in Expo Go
  try { return require('expo-iap'); }
  catch { throw new Error('In-app purchase needs the Understage development build.'); }
}

/** Real StoreKit purchase via expo-iap when products exist for this build. */
export async function storePurchase(productId: string): Promise<StorePurchaseResult> {
  if (!planFromProductId(productId)) {
    throw new Error(`Unknown Understage productId: ${productId}`);
  }
  const iap = loadExpoIap();
  await iap.initConnection();
  const products = await iap.fetchProducts({ skus: [productId], type: 'subs' }).catch(() => []);
  if (!products?.length) {
    throw new Error(
      `Product ${productId} isn't available in this build. ${IAP_PAID_APPLE_BLOCKER} For Simulator, attach storekit/Understage.storekit in the Xcode scheme (StoreKit Configuration).`,
    );
  }
  return new Promise((resolve, reject) => {
    const ok = iap.purchaseUpdatedListener((p: any) => {
      ok.remove(); bad.remove();
      iap.finishTransaction({ purchase: p, isConsumable: false }).catch(() => {});
      const transactionId = String(p?.transactionId ?? p?.id ?? '');
      const signedTransaction = typeof p?.purchaseToken === 'string' && p.purchaseToken.includes('.')
        ? p.purchaseToken
        : (typeof p?.jwsRepresentationIOS === 'string' ? p.jwsRepresentationIOS : null);
      if (!transactionId) {
        reject(new Error('StoreKit returned a purchase without a transactionId'));
        return;
      }
      resolve({ productId, transactionId, signedTransaction });
    });
    const bad = iap.purchaseErrorListener((e: any) => {
      ok.remove(); bad.remove();
      reject(new Error(e?.message ?? 'Purchase cancelled'));
    });
    iap.requestPurchase({
      request: { apple: { sku: productId }, google: { skus: [productId] } },
      type: 'subs',
    }).catch((e: any) => { ok.remove(); bad.remove(); reject(e); });
  });
}

/** Body for POST /subscriptions/verify from a StoreKit purchase result. */
export function verifyBodyFromPurchase(
  planId: 'production' | 'company',
  purchase: StorePurchaseResult,
): {
  planId: 'production' | 'company';
  transactionId: string;
  signedTransaction?: string;
  platform: 'ios' | 'android';
} {
  return {
    planId,
    transactionId: purchase.transactionId,
    ...(purchase.signedTransaction ? { signedTransaction: purchase.signedTransaction } : {}),
    platform: Platform.OS === 'android' ? 'android' : 'ios',
  };
}
