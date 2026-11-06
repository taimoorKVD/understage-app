import React, { useCallback, useState } from 'react';
import { View, ScrollView, TextInput } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { C } from '../../../theme';
import { T, Header, Card, Row, Label, Input, Button, ErrorText, Pill, Spinner, s, Screen} from '../../../components/ui';
import { api, errMsg } from '../../../lib/api';
import { listTime } from '../../../lib/time';
export default function Support() {
  const [tickets, setTickets] = useState<any[] | null>(null); const [subject, setSubject] = useState(''); const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => api('GET', '/support/tickets').then(r => setTickets(r.tickets)).catch(e => { setErr(errMsg(e)); setTickets([]); }), []);
  useFocusEffect(useCallback(() => { load(); }, [load]));
  return (
    <Screen style={s.screen} edges={['top', 'bottom']}>
      <Header title="Help & support" />
      <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
        <Label>New request</Label>
        <Input testID="tsubj" value={subject} onChangeText={setSubject} placeholder="Subject" maxLength={120} />
        <TextInput testID="tbody" value={body} onChangeText={setBody} placeholder="How can we help?" placeholderTextColor={C.muted} multiline style={{ color: C.text, backgroundColor: C.input, borderRadius: 14, padding: 12, minHeight: 90, borderWidth: 1, borderColor: C.border }} />
        <ErrorText>{err}</ErrorText>
        <Button testID="tsend" title="Send to support" loading={busy} disabled={subject.trim().length < 3 || !body.trim()} onPress={async () => {
          setBusy(true); setErr(null);
          try { const r = await api('POST', '/support/tickets', { subject, body }); setSubject(''); setBody(''); await load(); router.push(`/support/${r.id}`); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
        }} />
        <Label>Your requests</Label>
        {!tickets ? <Spinner /> : !tickets.length ? <T mu>No requests yet.</T> : tickets.map(t => (
          <Card key={t.id} testID={`tk-${t.id}`} onPress={() => router.push(`/support/${t.id}`)}><Row><View style={{ flex: 1 }}><T weight="600">{t.subject}</T><T mu size={12}>{listTime(t.created_at)}</T></View><Pill>{String(t.status).toUpperCase()}</Pill></Row></Card>))}
      </ScrollView>
    </Screen>
  );
}
