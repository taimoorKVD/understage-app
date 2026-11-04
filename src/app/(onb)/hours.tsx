import React, { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button, Header, ErrorText, s } from '../../components/ui';
import { HoursEditor, type HoursValue } from '../../components/Hours';
import { api, errMsg } from '../../lib/api';
import { setMe } from '../../lib/engine';
import { phoneTimezone } from '../../lib/time';
import { useApp } from '../../store/app';

export const hoursFromMe = (me: NonNullable<ReturnType<typeof useApp.getState>['me']>): HoursValue => ({
  workDays: me.shift.days, shiftStart: me.shift.start, shiftEnd: me.shift.end, followPhoneTz: me.followPhoneTz, touringMode: me.touringMode, quietHours: me.quietHours, timezone: me.timezone,
});
export const hoursToPatch = (v: HoursValue) => ({ workDays: v.workDays, shiftStart: v.shiftStart, shiftEnd: v.shiftEnd, followPhoneTz: v.followPhoneTz, touringMode: v.touringMode, quietHours: v.quietHours, timezone: v.followPhoneTz ? phoneTimezone() : v.timezone });

export default function Hours() {
  const me = useApp(st => st.me)!;
  const [v, setV] = useState<HoursValue>({ ...hoursFromMe(me), timezone: phoneTimezone(), followPhoneTz: true });
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  return (
    <SafeAreaView style={s.screen} edges={['top', 'bottom']}>
      <Header title="Working hours" subtitle="Step 4 of 5" />
      <ScrollView contentContainerStyle={[s.body, { flexGrow: 1 }]}>
        <HoursEditor value={v} onChange={setV} />
        <ErrorText>{err}</ErrorText>
        <View style={{ flex: 1 }} />
        <Button testID="hcont" title="Continue" loading={busy} disabled={!v.workDays.length} onPress={async () => {
          setBusy(true); setErr(null);
          try { setMe(await api('PATCH', '/me', hoursToPatch(v))); router.push('/keys'); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
        }} />
      </ScrollView>
    </SafeAreaView>
  );
}
