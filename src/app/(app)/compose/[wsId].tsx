import React, { useEffect, useState } from 'react';
import { View, ScrollView, TextInput } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { C } from '../../../theme';
import { T, Header, Label, Input, Pill, Card, Row, Toggle, Tap, Button, ErrorText, s, Screen} from '../../../components/ui';
import { api, errMsg } from '../../../lib/api';
import { useApp } from '../../../store/app';
import type { Workspace } from '../../../lib/types';

export default function Compose() {
  const { wsId } = useLocalSearchParams<{ wsId: string }>(); const toast = useApp(st => st.showToast);
  const [ws, setWs] = useState<Workspace | null>(null);
  const [title, setTitle] = useState(''); const [body, setBody] = useState(''); const [ack, setAck] = useState(false); const [quiet, setQuiet] = useState(true);
  const [depts, setDepts] = useState<string[] | null>(null); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api('GET', `/workspaces/${wsId}`).then(r => setWs(r.workspace)).catch(e => setErr(errMsg(e))); }, [wsId]);
  const count = !ws ? 0 : depts ? ws.departments.filter(d => depts.includes(d.id)).reduce((n, d) => n + d.count, 0) : ws.memberCount - 1;
  const post = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api('POST', `/workspaces/${wsId}/announcements`, { title: title.trim(), body: body.trim(), requireAck: ack, respectQuietHours: quiet, departmentIds: depts?.length ? depts : null });
      toast(`Posted to ${r.recipients} people${r.held ? ` · ${r.held} off shift get it when their shift starts` : ''}`); router.back();
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  const tog = (id: string) => setDepts(d => { const cur = d ?? []; const n = cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id]; return n.length ? n : null; });
  return (
    <Screen style={s.screen} edges={['top', 'bottom']}>
      <Header title="New announcement" subtitle={ws?.name} />
      <ScrollView contentContainerStyle={[s.body, { flexGrow: 1 }]} keyboardShouldPersistTaps="handled">
        <Label>Title</Label><Input testID="atitle" value={title} onChangeText={setTitle} maxLength={120} placeholder="Tech rehearsal moved to 14:00" />
        <Label>Message</Label>
        <View style={{ backgroundColor: C.input, borderRadius: 14, borderWidth: 1, borderColor: C.border, padding: 12, height: 110 }}>
          <TextInput testID="abody" value={body} onChangeText={setBody} multiline maxLength={4000} style={{ color: C.text, fontSize: 15, lineHeight: 21, flex: 1, textAlignVertical: 'top' }} placeholder="Details…" placeholderTextColor={C.muted} />
        </View>
        <Label>Send to</Label>
        <Row gap={6} style={{ flexWrap: 'wrap' }}>
          <Tap testID="to-all" onPress={() => setDepts(null)}><Pill bg={!depts ? C.pill : C.track} color={!depts ? C.gold : '#aaa'}>All company · {ws ? ws.memberCount - 1 : '…'}</Pill></Tap>
          {ws?.departments.map(d => <Tap key={d.id} testID={`to-${d.id}`} onPress={() => tog(d.id)}><Pill bg={depts?.includes(d.id) ? C.pill : C.track} color={depts?.includes(d.id) ? C.gold : '#aaa'}>{d.name} · {d.count}</Pill></Tap>)}
        </Row>
        <Card><Row><View style={{ flex: 1 }}><T weight="700" size={14}>Require acknowledgement</T><T mu size={12}>Track who has confirmed</T></View><Toggle testID="rq" value={ack} onChange={setAck} /></Row></Card>
        <Card><Row><View style={{ flex: 1 }}><T weight="700" size={14}>Respect quiet hours</T><T mu size={12}>Off-shift people get it at start of shift</T></View><Toggle testID="rqh" value={quiet} onChange={setQuiet} /></Row></Card>
        <ErrorText>{err}</ErrorText>
        <View style={{ flex: 1 }} />
        <Button testID="post" title={`Post to ${count} people`} loading={busy} disabled={!title.trim() || !body.trim() || !count} onPress={post} />
        <T mu size={11} style={{ textAlign: 'center' }}>Announcements are not end-to-end encrypted: they’re encrypted in transit and stored on the Understage server.</T>
      </ScrollView>
    </Screen>
  );
}
