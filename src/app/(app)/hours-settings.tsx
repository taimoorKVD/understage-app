import React, { useEffect, useState } from 'react';
import { ScrollView } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { T, Header, Card, Button, ErrorText, s } from '../../components/ui';
import { HoursEditor, HoursValue } from '../../components/Hours';
import { hoursFromMe, hoursToPatch } from '../(onb)/hours';
import { api, errMsg } from '../../lib/api';
import { setMe } from '../../lib/engine';
import { useApp } from '../../store/app';
import { localParts, isOnShift, tzAbbr } from '../../lib/time';

export default function HoursSettings() {
  const me = useApp(st => st.me)!; const toast = useApp(st => st.showToast);
  const [v, setV] = useState<HoursValue>(() => hoursFromMe(me)); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now()); useEffect(() => { const t = setInterval(() => setNow(Date.now()), 15000); return () => clearInterval(t); }, []);
  const tz = hoursToPatch(v).timezone;
  return (
    <SafeAreaView style={s.screen} edges={['top', 'bottom']}>
      <Header title="Working hours" />
      <ScrollView contentContainerStyle={s.body}>
        <Card style={{ alignItems: 'center' }}><T serif size={48} testID="bigclock">{localParts(tz, now).hhmm}</T><T mu size={12.5}>{tz} ({tzAbbr(tz, now)}) · {isOnShift({ days: v.workDays, start: v.shiftStart, end: v.shiftEnd }, tz, v.quietHours, now) ? 'on shift' : 'off shift'}</T></Card>
        <HoursEditor value={v} onChange={setV} />
        <ErrorText>{err}</ErrorText>
        <Button testID="hsave" title="Save" loading={busy} onPress={async () => {
          setBusy(true); setErr(null);
          try { setMe(await api('PATCH', '/me', hoursToPatch(v))); toast('Working hours saved'); router.back(); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
        }} />
      </ScrollView>
    </SafeAreaView>
  );
}
