import React, { useEffect, useState } from 'react';
import { View, ScrollView } from 'react-native';
import { router } from 'expo-router';
import { C } from '../../theme';
import { T, Header, Row, Tap, Button, Pill, ErrorText, Spinner, s, Screen} from '../../components/ui';
import { Icon } from '../../components/Icon';
import { api, ApiError, errMsg } from '../../lib/api';
import { refreshMe } from '../../lib/engine';
import { storePurchase, verifyBodyFromPurchase, IAP_PAID_APPLE_BLOCKER } from '../../lib/iap';
import { useApp } from '../../store/app';
import type { Plan } from '../../lib/types';


export default function Paywall() {
  const toast = useApp(st => st.showToast);
  const [plans, setPlans] = useState<Plan[] | null>(null); const [trial, setTrial] = useState(14); const [sample, setSample] = useState(false);
  const [sel, setSel] = useState<Plan['id']>('production'); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api('GET', '/subscriptions/plans').then(r => { setPlans(r.plans); setTrial(r.trialDays); setSample(r.samplePrices); }).catch(e => setErr(errMsg(e))); }, []);
  const plan = plans?.find(p => p.id === sel);
  const buy = async () => {
    if (!plan?.productId || (sel !== 'production' && sel !== 'company')) return;
    setBusy(true); setErr(null);
    try {
      const purchase = await storePurchase(plan.productId);
      if (!purchase.signedTransaction) {
        throw new Error(`StoreKit did not return a signed transaction JWS. ${IAP_PAID_APPLE_BLOCKER}`);
      }
      await api('POST', '/subscriptions/verify', verifyBodyFromPurchase(sel, purchase));
      await refreshMe(); toast(`${plan?.name} trial started`); router.back();
    } catch (e) {
      if (e instanceof ApiError && e.status === 501) setErr(`${e.message} Local JWS stubs: server/scripts/mint-local-iap-jws.ts + storekit/Understage.storekit.`);
      else setErr(errMsg(e));
    } finally { setBusy(false); }
  };
  return (
    <Screen style={s.screen} edges={['top', 'bottom']}>
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
        <T mu size={11} style={{ textAlign: 'center' }}>Cancel any time in App Store settings. Renews automatically after the trial.</T>
      </ScrollView>
    </Screen>
  );
}
