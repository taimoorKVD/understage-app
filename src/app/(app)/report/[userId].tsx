import React, { useEffect, useState } from 'react';
import { View, ScrollView, TextInput } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { C } from '../../../theme';
import { T, Header, Card, Row, Tap, Label, Toggle, Button, ErrorText, Avatar, s } from '../../../components/ui';
import { Icon } from '../../../components/Icon';
import { api, errMsg } from '../../../lib/api';
import { useApp } from '../../../store/app';
import type { PublicUser } from '../../../lib/types';

const REASONS = [['harassment', 'Harassment or abuse'], ['spam', 'Spam or scam'], ['impersonation', 'Pretending to be someone'], ['other', 'Something else']] as const;
export default function Report() {
  const { userId, conv } = useLocalSearchParams<{ userId: string; conv?: string }>();
  const msgs = useApp(st => (conv ? st.messages[conv] : undefined));
  const [u, setU] = useState<PublicUser | null>(null); const [reason, setReason] = useState<(typeof REASONS)[number][0] | null>(null);
  const [evidence, setEvidence] = useState(true); const [block, setBlock] = useState(true); const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null); const [done, setDone] = useState<string | null>(null);
  useEffect(() => { api('GET', `/users/${userId}`).then(setU).catch(e => setErr(errMsg(e))); }, [userId]);
  // Evidence is only what the reporter chooses to share: the last 10 decrypted messages from this person, sent in plaintext with the report.
  const ev = (msgs ?? []).filter(m => m.senderId === userId && m.body?.type === 'text').slice(-10).map(m => ({ text: (m.body as any).text as string, at: m.createdAt }));
  const submit = async () => {
    setBusy(true); setErr(null);
    try { const r = await api('POST', '/reports', { reportedId: userId, reason, evidence: evidence ? ev : [], alsoBlock: block, note: note.trim() || undefined }); setDone(r.number); }
    catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  if (done) return (
    <SafeAreaView style={s.screen} edges={['top', 'bottom']}>
      <View style={[s.body, { flex: 1, alignItems: 'center', justifyContent: 'center' }]}>
        <View style={{ width: 72, height: 72, borderRadius: 36, backgroundColor: C.greenPill, alignItems: 'center', justifyContent: 'center' }}><Icon name="check" size={34} color={C.green} /></View>
        <T serif size={26}>Report sent</T><T mu style={{ textAlign: 'center' }} testID="repnum">Reference {done}. Our safety team reviews reports within 24 hours.{block ? ` ${u?.displayName ?? 'They'} can no longer contact you.` : ''}</T>
        <Button testID="repdone" title="Done" style={{ alignSelf: 'stretch', marginTop: 20 }} onPress={() => router.dismissTo('/')} />
      </View>
    </SafeAreaView>);
  return (
    <SafeAreaView style={s.screen} edges={['top', 'bottom']}>
      <Header title="Report" subtitle={u?.displayName ?? undefined} />
      <ScrollView contentContainerStyle={s.body}>
        {u ? <Row><Avatar name={u.displayName ?? '?'} uri={u.avatar} size={40} /><T weight="700">{u.displayName}</T><T mu>@{u.username}</T></Row> : null}
        <Label>What’s happening?</Label>
        {REASONS.map(([k, t]) => <Tap key={k} testID={`rr-${k}`} onPress={() => setReason(k)} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 13, borderRadius: 14, borderWidth: 1, borderColor: reason === k ? C.gold : C.border, backgroundColor: reason === k ? C.goldCard : C.card }}>
          <View style={{ width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: reason === k ? C.gold : C.muted, alignItems: 'center', justifyContent: 'center' }}>{reason === k ? <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: C.gold }} /> : null}</View><T>{t}</T></Tap>)}
        <Card><Row><View style={{ flex: 1 }}><T weight="700" size={14}>Include recent messages</T><T mu size={12}>{ev.length} messages from this chat are decrypted on your phone and shared with the safety team</T></View><Toggle testID="rev" value={evidence} onChange={setEvidence} /></Row></Card>
        <Card><Row><View style={{ flex: 1 }}><T weight="700" size={14}>Also block</T></View><Toggle testID="rblock" value={block} onChange={setBlock} /></Row></Card>
        <TextInput testID="rnote" value={note} onChangeText={setNote} placeholder="Anything else (optional)" placeholderTextColor={C.muted} multiline style={{ color: C.text, backgroundColor: C.input, borderRadius: 14, padding: 12, minHeight: 70, borderWidth: 1, borderColor: C.border }} />
        <ErrorText>{err}</ErrorText>
        <Button testID="rsend" title="Send report" variant="danger" loading={busy} disabled={!reason} onPress={submit} />
      </ScrollView>
    </SafeAreaView>
  );
}
