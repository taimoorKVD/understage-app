import { describe, it, expect } from 'vitest';
import {
  IAP_PRODUCTS,
  IAP_PRODUCT_IDS,
  PRODUCT_TO_PLAN,
  planFromProductId,
  DEFAULT_IAP_BUNDLE_ID,
} from '../../shared/iap-products';
import { planFromProductId as serverPlanFromProductId, PRODUCT_TO_PLAN as serverMap } from '../src/iap';

describe('shared IAP product catalog (local stub)', () => {
  it('maps both StoreKit product IDs to paid plans', () => {
    expect(IAP_PRODUCT_IDS).toEqual([
      'com.understage.production.monthly',
      'com.understage.company.monthly',
    ]);
    expect(planFromProductId('com.understage.production.monthly')).toBe('production');
    expect(planFromProductId('com.understage.company.monthly')).toBe('company');
    expect(planFromProductId('com.other.sku')).toBeNull();
    expect(DEFAULT_IAP_BUNDLE_ID).toBe('com.kvmac.understage');
    expect(IAP_PRODUCTS.company.seats).toBe(200);
    expect(IAP_PRODUCTS.production.seats).toBe(50);
  });

  it('stays aligned with server PRODUCT_TO_PLAN', () => {
    expect(serverMap).toEqual(PRODUCT_TO_PLAN);
    for (const [sku, plan] of Object.entries(PRODUCT_TO_PLAN)) {
      expect(serverPlanFromProductId(sku)).toBe(plan);
    }
  });
});
