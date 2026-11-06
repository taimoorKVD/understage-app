/** App Store product IDs ↔ Understage plans. Shared by client stubs, server verify, and StoreKit config. */

export const DEFAULT_IAP_BUNDLE_ID = 'com.kvmac.understage';

export type PaidPlanId = 'production' | 'company';

export type IapProductDef = {
  productId: string;
  planId: PaidPlanId;
  name: string;
  description: string;
  samplePriceGBP: number;
  seats: number;
  /** ISO-8601 recurring period used by StoreKit Configuration files. */
  recurringPeriod: 'P1M';
};

export const IAP_PRODUCTS: Record<PaidPlanId, IapProductDef> = {
  production: {
    productId: 'com.understage.production.monthly',
    planId: 'production',
    name: 'Production',
    description: 'Workspace up to 50 people',
    samplePriceGBP: 49,
    seats: 50,
    recurringPeriod: 'P1M',
  },
  company: {
    productId: 'com.understage.company.monthly',
    planId: 'company',
    name: 'Company',
    description: 'Up to 200 people + admin tools',
    samplePriceGBP: 149,
    seats: 200,
    recurringPeriod: 'P1M',
  },
};

export const PRODUCT_TO_PLAN: Record<string, PaidPlanId> = {
  [IAP_PRODUCTS.production.productId]: 'production',
  [IAP_PRODUCTS.company.productId]: 'company',
};

export function planFromProductId(productId: string): PaidPlanId | null {
  return PRODUCT_TO_PLAN[productId] || null;
}

export const IAP_PRODUCT_IDS = Object.values(IAP_PRODUCTS).map(p => p.productId);

/**
 * Real device StoreKit purchases still need a paid Apple Developer Program membership,
 * App Store Connect products, and a sandbox Apple ID. Local stubs (StoreKit.storekit,
 * mint-local-iap-jws, vitest JWS fixtures) cover the unpaid development path.
 */
export const IAP_PAID_APPLE_BLOCKER =
  'Real App Store purchases need a paid Apple Developer Program membership, App Store Connect subscription products, and a sandbox Apple ID.';
