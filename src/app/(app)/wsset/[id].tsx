import React, { useEffect, useState } from 'react';
import { View, ScrollView } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { C } from '../../../theme';
import { T, Header, Card, Row, Label, Button, Spinner, ErrorText, s } from '../../../components/ui';
import { Sheet } from '../../../components/Sheet';
import { api, errMsg } from '../../../lib/api';
import { refreshAll } from '../../../lib/engine';
import { useApp } from '../../../store/app';
import type { Workspace } from '../../../lib/types';

export default function WsSettings() {
  const { id } = useLocalSearchParams<{ id: string }>(); const me = useApp(st => st.me)!; const toast = useApp(st => st.showToast);
  const [ws, setWs] = useState<Workspace | null>(null); const [ask, setAsk] = useState(false); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api('GET', `/workspaces/${id}`).then(r => setWs(r.workspace)).catch(e => setErr(errMsg(e))); }, [id]);
  if (!ws) return <SafeAreaView style={s.screen}><Header title="Workspace settings" />{err ? <ErrorText>{err}</ErrorText> : <Spinner />}</SafeAreaView>;
  const admin = ws.myRole === 'owner' || ws.myRole === 'admin';
  const wrap = async () => { setBusy(true); try { const r = await api('POST', `/workspaces/${id}/wrap`); setWs(r.workspace); setAsk(false); await refreshAll(); toast('Production wrapped · chats are now read-only'); } catch (e) { toast(errMsg(e)); } finally { setBusy(false); } };
  const leave = async () => { try { await api('DELETE', `/workspaces/${id}/members/${me.id}`); await refreshAll(); router.dismissTo('/workspace'); } catch (e) { toast(errMsg(e)); } };
  return (
    <SafeAreaView style={s.screen} edges={['top', 'bottom']}>
      <Header title="Workspace settings" subtitle={ws.name} />
      <ScrollView contentContainerStyle={[s.body, { flexGrow: 1 }]}>
        <Card><Label>Production run</Label><T weight="600" style={{ marginTop: 6 }}>{ws.runLabel || '—'}</T>{ws.venue ? <T mu size={13}>{ws.venue}</T> : null}</Card>
        <Card><Row><T style={{ flex: 1 }}>Members</T><T weight="700" testID="seats">{ws.memberCount} / {ws.seatLimit}</T></Row></Card>
        <Card><Row><T style={{ flex: 1 }}>Admins</T><T weight="700" style={{ flexShrink: 1, textAlign: 'right' }}>{ws.admins.join(', ')}</T></Row></Card>
        <Card><Row><T style={{ flex: 1 }}>Plan</T><T weight="700">{ws.plan}</T></Row></Card>
        <View style={{ flex: 1 }} />
        {ws.myRole !== 'owner' ? <Button testID="wsleave" title="Leave workspace" variant="secondary" onPress={leave} /> : null}
        {admin ? (ws.wrappedAt ? (
          <Card style={{ borderColor: C.red, backgroundColor: C.dangerCard }}><T serif size={20}>Wrapped</T><T mu size={13}>Read-only archive{ws.deleteAfter ? ` · deleted after ${new Date(ws.deleteAfter).toLocaleDateString('en-GB')}` : ''}.</T></Card>
        ) : (
          <Card style={{ borderColor: C.red, backgroundColor: C.dangerCard }}>
            <T serif size={22}>End of the run?</T>
            <T mu size={13} style={{ lineHeight: 20, marginTop: 6, marginBottom: 12 }}>Wrap closes this production for all {ws.memberCount} people.</T>
            <Button testID="wrapbtn" title="Wrap production" variant="danger" onPress={() => setAsk(true)} />
          </Card>)) : null}
      </ScrollView>
      <Sheet visible={ask} onClose={() => setAsk(false)} title={`Wrap ${ws.name}?`}>
        {['All chats and announcements become read-only', 'Invite links stop working', 'Everything is deleted after 30 days', 'Personal 1:1 contacts are kept'].map(t => <Row key={t}><T gold>•</T><T size={14} style={{ flex: 1 }}>{t}</T></Row>)}
        <Button testID="wrapconfirm" title="Wrap production" variant="danger" loading={busy} onPress={wrap} />
        <Button testID="wrapcancel" title="Cancel" variant="secondary" onPress={() => setAsk(false)} />
      </Sheet>
    </SafeAreaView>
  );
}
