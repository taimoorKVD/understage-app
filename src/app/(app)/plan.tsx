import React, { useEffect, useState } from 'react';
import { ScrollView, Linking } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { T, Header, Card, Row, Bar, Button, Spinner, ErrorText, s } from '../../components/ui';
import { api, errMsg } from '../../lib/api';
import { fmtDate } from '../../lib/time';
export default function PlanScreen() {
  const [d, setD] = useState<any>(null); const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api('GET', '/subscriptions/me').then(setD).catch(e => setErr(errMsg(e))); }, []);
  return (
    <SafeAreaView style={s.screen} edges={['top', 'bottom']}>
      <Header title="Subscription" />
      <ScrollView contentContainerStyle={s.body}>
        <ErrorText>{err}</ErrorText>
        {!d ? (err ? null : <Spinner />) : <>
          <Card><T serif size={24} testID="planname">{d.plan.name}</T><T mu>{d.plan.priceGBP ? `£${d.plan.priceGBP}/${d.plan.period}` : 'Free'}{d.status ? ` · ${d.status}` : ''}</T>{d.renewsAt ? <T mu size={12.5}>{d.status === 'trial' ? 'Trial ends' : 'Renews'} {fmtDate(d.renewsAt)}</T> : null}</Card>
          {d.seatLimit ? <Card><Row><T style={{ flex: 1 }}>Seats used</T><T weight="700">{d.seatsUsed} / {d.seatLimit}</T></Row><Bar pct={(d.seatsUsed / d.seatLimit) * 100} style={{ marginTop: 10 }} /></Card> : null}
          <Button testID="changeplan" title="Change plan" variant="secondary" onPress={() => router.push('/paywall')} />
          <Button testID="manage" title="Manage in App Store" variant="secondary" onPress={() => Linking.openURL('https://apps.apple.com/account/subscriptions')} />
        </>}
      </ScrollView>
    </SafeAreaView>
  );
}
