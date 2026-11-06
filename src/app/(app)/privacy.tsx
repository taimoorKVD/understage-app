import React, { useState } from 'react';
import { View, ScrollView } from 'react-native';
import { router } from 'expo-router';
import { C } from '../../theme';
import { T, Header, Card, Row, Label, Toggle, Button, s, Screen} from '../../components/ui';
import { Icon } from '../../components/Icon';
import { api, errMsg } from '../../lib/api';
import { setMe } from '../../lib/engine';
import { useApp } from '../../store/app';
import { fmtDate } from '../../lib/time';

export default function Privacy() {
  const me = useApp(st => st.me)!; const toast = useApp(st => st.showToast); const [busy, setBusy] = useState(false);
  const patch = async (b: object) => { setBusy(true); try { setMe(await api('PATCH', '/me', b)); } catch (e) { toast(errMsg(e)); } finally { setBusy(false); } };
  return (
    <Screen style={s.screen} edges={['top', 'bottom']}>
      <Header title="Privacy & encryption" />
      <ScrollView contentContainerStyle={s.body}>
        <Card><Row><Icon name="lock" size={22} color={C.green} /><View style={{ flex: 1 }}><T weight="700">End-to-end encrypted</T><T mu size={12.5} style={{ lineHeight: 18 }}>1:1 and group messages, attachments, voice notes and call signalling are encrypted on this phone with keys only you hold (X25519 + XSalsa20-Poly1305, via TweetNaCl). Announcements are encrypted in transit but stored readable on the server so admins can track acknowledgements.</T></View></Row></Card>
        <Card><Row><Icon name="key" size={20} color={C.gold} /><View style={{ flex: 1 }}><T weight="700">Your identity key</T><T mu size={12.5}>{me.keyUpdatedAt ? `Created ${fmtDate(me.keyUpdatedAt)}` : 'Not set'} · stored in the iOS Keychain</T></View></Row></Card>
        <Label>Visibility</Label>
        <Card><Row><View style={{ flex: 1 }}><T weight="700" size={14}>Show working-hours status</T><T mu size={12}>Colleagues see “On shift” / “Off shift”</T></View><Toggle testID="pv-work" value={me.workMode} onChange={v => !busy && patch({ workMode: v })} /></Row></Card>
        <Card><Row><View style={{ flex: 1 }}><T weight="700" size={14}>Quiet hours</T><T mu size={12}>Hold notifications while you’re off shift</T></View><Toggle testID="pv-quiet" value={me.quietHours} onChange={v => !busy && patch({ quietHours: v })} /></Row></Card>
        {[['Phone number / email', 'Never shown'], ['Personal contacts', 'Never uploaded'], ['Location', 'Never collected']].map(([a, b]) => <Row key={a} style={{ justifyContent: 'space-between' }}><T size={14}>{a}</T><T size={14} weight="600" style={{ color: C.red }}>{b}</T></Row>)}
        <Button testID="pv-blocked" title="Blocked people" variant="secondary" onPress={() => router.push('/blocked')} />
      </ScrollView>
    </Screen>
  );
}
