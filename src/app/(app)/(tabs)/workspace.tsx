import React, { useCallback, useState } from 'react';
import { View, ScrollView, RefreshControl } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { C } from '../../../theme';
import { T, Card, Row, Avatar, Button, Input, Label, Empty, ErrorText, Pill, s } from '../../../components/ui';
import { Icon } from '../../../components/Icon';
import { Sheet } from '../../../components/Sheet';
import { api, errMsg } from '../../../lib/api';
import { useApp } from '../../../store/app';

export const SEATS: Record<string, number> = { free: 0, production: 50, company: 200 };
const DEFAULT_DEPTS = 'Stage Management, Cast, Lighting, Sound, Wardrobe & Wigs, Set & Crew, Front of House, Production Office';

export default function WorkspaceTab() {
  const me = useApp(st => st.me)!; const wss = useApp(st => st.workspaces);
  const [refreshing, setRefreshing] = useState(false); const [open, setOpen] = useState(false);
  const [name, setName] = useState(''); const [venue, setVenue] = useState(''); const [run, setRun] = useState(''); const [depts, setDepts] = useState(DEFAULT_DEPTS);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => api('GET', '/workspaces').then(r => useApp.getState().set({ workspaces: r.workspaces })).catch(() => {}), []);
  useFocusEffect(useCallback(() => { load(); }, [load]));
  const create = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api('POST', '/workspaces', { name: name.trim(), venue: venue.trim(), runLabel: run.trim(), departments: depts.split(',').map(d => d.trim()).filter(Boolean), seatLimit: SEATS[me.plan] || 50 });
      await load(); setOpen(false); setName(''); router.push(`/workspace/${r.workspace.id}`);
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <SafeAreaView style={s.screen} edges={['top']}>
      <Row style={{ paddingHorizontal: 18, paddingTop: 4, paddingBottom: 8 }}><T serif size={30} style={{ flex: 1 }}>Workspace</T>
        <Button testID="newws" title="New" icon="plus" variant="secondary" style={{ paddingVertical: 8, paddingHorizontal: 14 }} onPress={() => (me.plan === 'free' ? router.push('/paywall') : setOpen(true))} /></Row>
      <ScrollView contentContainerStyle={[s.body, { flexGrow: 1 }]} refreshControl={<RefreshControl tintColor={C.gold} refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}>
        {!wss.length ? <Empty icon="users" title="No production workspace yet" body="A workspace gives your company announcements with acknowledgements, departments and a member directory in everyone's local time." action={<Button testID="empty-newws" title={me.plan === 'free' ? 'Start a free trial' : 'Create a workspace'} onPress={() => (me.plan === 'free' ? router.push('/paywall') : setOpen(true))} />} /> : null}
        {wss.map(w => (
          <Card key={w.id} testID={`ws-${w.id}`} onPress={() => router.push(`/workspace/${w.id}`)}>
            <Row>
              <Avatar name={w.initial} size={50} bg={C.gold} />
              <View style={{ flex: 1 }}><T serif size={19}>{w.name}</T><T mu size={12.5}>{w.memberCount} members{w.venue ? ` · ${w.venue}` : ''}</T></View>
              {w.wrappedAt ? <Pill bg={C.dangerCard} color="#ff8a9a">WRAPPED</Pill> : <Pill>{w.myRole.toUpperCase()}</Pill>}
            </Row>
          </Card>))}
        {me.plan === 'free' && wss.length ? (
          <Card onPress={() => router.push('/paywall')} testID="upsell"><Row><Icon name="star" size={20} color={C.gold} /><T style={{ flex: 1 }} size={14}>Run your own production: workspaces for up to 200 people.</T><T mu>›</T></Row></Card>) : null}
      </ScrollView>
      <Sheet visible={open} onClose={() => setOpen(false)} title="New production workspace">
        <Label>Production name</Label><Input testID="wsname" value={name} onChangeText={setName} placeholder="Hamlet UK Tour 2027" />
        <Label>Venue</Label><Input testID="wsvenue" value={venue} onChangeText={setVenue} placeholder="Lyceum, Edinburgh" />
        <Label>Run</Label><Input testID="wsrun" value={run} onChangeText={setRun} placeholder="12 Jan – 28 Jun 2027 · 9 venues" />
        <Label>Departments (comma separated)</Label><Input testID="wsdepts" value={depts} onChangeText={setDepts} multiline />
        <T mu size={12}>Seats: {SEATS[me.plan] || 50} on your {me.plan} plan.</T>
        <ErrorText>{err}</ErrorText>
        <Button testID="wscreate" title="Create workspace" loading={busy} disabled={name.trim().length < 2} onPress={create} />
      </Sheet>
    </SafeAreaView>
  );
}
