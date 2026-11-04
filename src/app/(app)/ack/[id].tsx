import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { C } from '../../../theme';
import { T, Header, Card, Row, Bar, Avatar, Label, Button, Spinner, ErrorText, s } from '../../../components/ui';
import { api, errMsg } from '../../../lib/api';
import { bus } from '../../../lib/events';
import { useApp } from '../../../store/app';
import { clock } from '../../../lib/time';
import type { Announcement, PublicUser } from '../../../lib/types';

type P = PublicUser & { seenAt: number | null; ackedAt: number | null; remindedAt: number | null };
export default function Acks() {
  const { id } = useLocalSearchParams<{ id: string }>(); const toast = useApp(st => st.showToast);
  const [d, setD] = useState<{ announcement: Announcement; pending: P[]; acknowledged: P[]; offShift: number } | null>(null);
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const load = useCallback(() => api('GET', `/announcements/${id}/acks`).then(setD).catch(e => setErr(errMsg(e))), [id]);
  useEffect(() => { load(); const off = bus.on('announcement:ack', (x: any) => x.announcementId === id && load()); return off; }, [id, load]);
  if (!d) return <SafeAreaView style={s.screen}><Header title="Acknowledgements" />{err ? <ErrorText>{err}</ErrorText> : <Spinner />}</SafeAreaView>;
  const a = d.announcement; const left = d.pending.length; const seen = d.pending.filter(p => p.seenAt).length; const off = left - seen;
  return (
    <SafeAreaView style={s.screen} edges={['top', 'bottom']}>
      <Header title={a.title} subtitle="Acknowledgements · live" />
      <ScrollView contentContainerStyle={s.body}>
        <Card style={{ alignItems: 'center' }}>
          <T gold size={50} weight="800" testID="bign">{a.acked}<T size={24} mu> / {a.total}</T></T>
          <T mu>acknowledged</T>
          <Bar pct={a.total ? (a.acked / a.total) * 100 : 0} style={{ marginTop: 12, alignSelf: 'stretch' }} />
        </Card>
        <Row gap={8}>
          {([[a.acked, 'Acknowledged', C.green], [seen, 'Seen, not yet', C.gold], [off, 'Not seen yet', C.violet]] as const).map(([n, t, c]) => (
            <Card key={t} style={{ flex: 1, alignItems: 'center' }}><T weight="700" style={{ color: c }}>{n}</T><T mu size={11.5}>{t}</T></Card>))}
        </Row>
        <Label>Not yet acknowledged ({left})</Label>
        {d.pending.map(p => (
          <Row key={p.id} style={{ paddingVertical: 3 }}>
            <Avatar name={p.displayName ?? ''} uri={p.avatar} size={32} /><T size={14} style={{ flex: 1 }}>{p.displayName}</T>
            <T mu size={12}>{p.seenAt ? `Seen ${clock(p.seenAt)}` : !p.onShift ? `Off shift · gets it at ${p.shift.start}` : 'Not opened'}</T>
          </Row>))}
        {left ? <Button testID="remind" title={`Remind ${left} people`} variant="secondary" loading={busy} onPress={async () => {
          setBusy(true);
          try { const r = await api('POST', `/announcements/${id}/remind`); toast(`Reminder sent to ${r.deliveredNow}${r.held ? ` · ${r.held} off shift get it when their shift starts` : ''}`); load(); }
          catch (e) { toast(errMsg(e)); } finally { setBusy(false); }
        }} /> : <T style={{ color: C.green, textAlign: 'center' }}>Everyone has acknowledged 🎉</T>}
        {d.acknowledged.length ? <Label>Acknowledged ({d.acknowledged.length})</Label> : null}
        {d.acknowledged.map(p => <Row key={p.id} style={{ paddingVertical: 3 }}><Avatar name={p.displayName ?? ''} uri={p.avatar} size={32} /><T size={14} style={{ flex: 1 }}>{p.displayName}</T><T size={12} style={{ color: C.green }}>✓ {clock(p.ackedAt!)}</T></Row>)}
      </ScrollView>
    </SafeAreaView>
  );
}
