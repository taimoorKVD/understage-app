import React, { useEffect, useState } from 'react';
import { View, ScrollView, Platform } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { C } from '../../theme';
import { T, Header, Row, Tap, Button, Pill, ErrorText, Spinner, s } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { api, ApiError, errMsg } from '../../lib/api';
import { refreshMe } from '../../lib/engine';
import { useApp } from '../../store/app';
import type { Plan } from '../../lib/types';

/** Real StoreKit purchase via expo-iap when available (dev build + App Store Connect products).
 *  Server receipt validation returns 501 IAP_NOT_CONFIGURED until App Store Server API keys are set. */
async function storePurchase(productId: string): Promise<string> {
  let iap: any;
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy native module; absent in Expo Go, so a static import would crash
  try { iap = require('expo-iap'); } catch { throw new Error('In-app purchase needs the Understage development build.'); }
  await iap.initConnection();
  const products = await iap.fetchProducts({ skus: [productId], type: 'subs' }).catch(() => []);
  if (!products?.length) throw new Error(`Product ${productId} isn't configured in App Store Connect for this build.`);
  return new Promise((resolve, reject) => {
    const ok = iap.purchaseUpdatedListener((p: any) => { ok.remove(); bad.remove(); iap.finishTransaction({ purchase: p, isConsumable: false }).catch(() => {}); resolve(p.transactionId ?? p.id); });
    const bad = iap.purchaseErrorListener((e: any) => { ok.remove(); bad.remove(); reject(new Error(e?.message ?? 'Purchase cancelled')); });
    iap.requestPurchase({ request: { apple: { sku: productId }, google: { skus: [productId] } }, type: 'subs' }).catch((e: any) => { ok.remove(); bad.remove(); reject(e); });
  });
}

export default function Paywall() {
  const toast = useApp(st => st.showToast);
  const [plans, setPlans] = useState<Plan[] | null>(null); const [trial, setTrial] = useState(14); const [sample, setSample] = useState(false);
  const [sel, setSel] = useState<Plan['id']>('production'); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null); const [devOffer, setDevOffer] = useState(false);
  useEffect(() => { api('GET', '/subscriptions/plans').then(r => { setPlans(r.plans); setTrial(r.trialDays); setSample(r.samplePrices); }).catch(e => setErr(errMsg(e))); }, []);
  const plan = plans?.find(p => p.id === sel);
  const verify = async (transactionId: string, dev = false) => {
    await api('POST', '/subscriptions/verify', { planId: sel, transactionId, platform: Platform.OS === 'android' ? 'android' : 'ios', dev });
    await refreshMe(); toast(`${plan?.name} trial started`); router.back();
  };
  const buy = async () => {
    if (!plan?.productId) return;
    setBusy(true); setErr(null); setDevOffer(false);
    try { await verify(await storePurchase(plan.productId)); }
    catch (e) {
      if (e instanceof ApiError && e.status === 501) { setErr(e.message); setDevOffer(true); }
      else { setErr(errMsg(e)); setDevOffer(true); }
    } finally { setBusy(false); }
  };
  return (
    <SafeAreaView style={s.screen} edges={['top', 'bottom']}>
      <Header title="Run your production on Understage" />
      <ScrollView contentContainerStyle={[s.body, { flexGrow: 1 }]}>
        {['Company workspace with departments', 'Announcements with acknowledgements', 'Quiet-hours delivery across time zones', 'Wrap the production in one tap'].map(t => <Row key={t}><Icon name="check" size={18} color={C.gold} /><T size={14}>{t}</T></Row>)}
        {!plans ? <Spinner /> : plans.filter(p => p.productId).map(p => (
          <Tap key={p.id} testID={`plan-${p.id}`} onPress={() => setSel(p.id)} style={{ borderWidth: 1.5, borderColor: sel === p.id ? C.gold : C.border, backgroundColor: sel === p.id ? C.goldCard : C.card, borderRadius: 16, padding: 14 }}>
            <Row><View style={{ flex: 1 }}><T weight="700" size={16}>{p.name}</T><T mu size={12.5}>{p.description}</T></View><T weight="700" size={17}>£{p.priceGBP}<T mu size={12}>/{p.period}</T></T></Row>
          </Tap>))}
        {sample ? <Pill bg={C.track} color="#aaa">Sample prices · final prices come from the App Store</Pill> : null}
        <ErrorText>{err}</ErrorText>
        <View style={{ flex: 1 }} />
        <Button testID="buy" title={`Start ${trial}-day free trial`} loading={busy} disabled={!plan} onPress={buy} />
        {devOffer ? <Button testID="devtrial" title="Activate developer trial (server SUBSCRIPTIONS_DEV=1 only)" variant="secondary" onPress={async () => { try { await verify(`dev-${Date.now()}`, true); } catch (e) { setErr(errMsg(e)); } }} /> : null}
        <T mu size={11} style={{ textAlign: 'center' }}>Cancel any time in App Store settings. Renews automatically after the trial.</T>
      </ScrollView>
    </SafeAreaView>
  );
}
