import React, { useCallback, useEffect, useState } from 'react';
import { View, ScrollView, TextInput } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { C } from '../../../theme';
import { T, Header, Row, Button, ErrorText, Spinner, s, Screen} from '../../../components/ui';
import { api, errMsg } from '../../../lib/api';
import { listTime } from '../../../lib/time';
export default function Ticket() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [d, setD] = useState<{ ticket: any; messages: { author: string; body: string; createdAt: number }[] } | null>(null);
  const [text, setText] = useState(''); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const load = useCallback(() => api('GET', `/support/tickets/${id}`).then(setD).catch(e => setErr(errMsg(e))), [id]);
  useEffect(() => { load(); }, [load]);
  return (
    <Screen style={s.screen} edges={['top', 'bottom']}>
      <Header title={d?.ticket.subject ?? 'Support'} subtitle={d ? `Status: ${d.ticket.status}` : undefined} />
      <ScrollView contentContainerStyle={s.body}>
        {!d ? (err ? <ErrorText>{err}</ErrorText> : <Spinner />) : d.messages.map((m, i) => (
          <View key={i} style={{ alignSelf: m.author === 'user' ? 'flex-end' : 'flex-start', maxWidth: '85%', backgroundColor: m.author === 'user' ? C.sent : C.recv, borderRadius: 16, padding: 11 }}>
            <T size={14}>{m.body}</T><T mu size={10.5} style={{ marginTop: 4 }}>{m.author === 'user' ? 'You' : 'Understage support'} · {listTime(m.createdAt)}</T></View>))}
      </ScrollView>
      <Row style={{ padding: 12, borderTopWidth: 1, borderTopColor: C.border }}>
        <TextInput testID="treply" value={text} onChangeText={setText} placeholder="Reply" placeholderTextColor={C.muted} style={{ flex: 1, color: C.text, backgroundColor: C.input, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 10 }} />
        <Button testID="treplysend" title="Send" loading={busy} disabled={!text.trim()} style={{ paddingVertical: 10, paddingHorizontal: 16 }} onPress={async () => {
          setBusy(true); try { await api('POST', `/support/tickets/${id}/messages`, { body: text }); setText(''); await load(); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
        }} />
      </Row>
    </Screen>
  );
}
