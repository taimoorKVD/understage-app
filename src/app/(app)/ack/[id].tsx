import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { C } from '../../../theme';
import { T, Header, Card, Row, Bar, Avatar, Label, Button, Spinner, ErrorText, ProgressRing, s, Screen} from '../../../components/ui';
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
  const depts = useMemo(() => {
    if (!d) return [];
    const map = new Map<string, { total: number; acked: number }>();
    let named = 0;
    const add = (p: P, acked: boolean) => {
      const key = (p.department || '').trim();
      if (key) named += 1;
      const k = key || 'Unassigned';
      const cur = map.get(k) || { total: 0, acked: 0 };
      cur.total += 1; if (acked) cur.acked += 1; map.set(k, cur);
    };
    d.acknowledged.forEach(p => add(p, true));
    d.pending.forEach(p => add(p, false));
    if (!named) return [];
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [d]);
  if (!d) return <Screen style={s.screen}><Header title="Acknowledgements" />{err ? <ErrorText>{err}</ErrorText> : <Spinner />}</Screen>;
  const a = d.announcement; const left = d.pending.length; const seen = d.pending.filter(p => p.seenAt).length; const off = left - seen;
  const pct = a.total ? (a.acked / a.total) * 100 : 0;
  return (
    <Screen style={s.screen} edges={['top', 'bottom']}>
      <Header title={a.title} subtitle="Acknowledgements · live" />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={s.body}>
        <Card style={{ alignItems: 'center', paddingVertical: 22 }}>
          <ProgressRing pct={pct} size={168} stroke={11}>
            <T gold size={36} weight="800" testID="bign" serif>{a.acked}<T size={18} mu> / {a.total}</T></T>
            <T mu size={12} style={{ marginTop: 2 }}>{Math.round(pct)}% acknowledged</T>
          </ProgressRing>
        </Card>
        {depts.length ? (
          <Card>
            <Label>By department</Label>
            {depts.map(([name, v]) => (
              <View key={name} style={{ marginTop: 10 }}>
                <Row><T size={13} style={{ flex: 1 }}>{name}</T><T gold size={12} weight="700">{v.acked}/{v.total}</T></Row>
                <Bar pct={v.total ? (v.acked / v.total) * 100 : 0} style={{ marginTop: 6 }} />
              </View>
            ))}
          </Card>
        ) : null}
        <Row gap={8}>
          {([[a.acked, 'Acknowledged', C.green], [seen, 'Seen, not yet', C.gold], [off, 'Not seen yet', C.violet]] as const).map(([n, t, c]) => (
            <Card key={t} style={{ flex: 1, alignItems: 'center' }}><T weight="700" style={{ color: c }}>{n}</T><T mu size={11.5}>{t}</T></Card>))}
        </Row>
        <Label>Not yet acknowledged ({left})</Label>
        {d.pending.map(p => (
          <Row key={p.id} style={{ paddingVertical: 6 }}>
            <Avatar name={p.displayName ?? ''} uri={p.avatar} size={32} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <T size={14} numberOfLines={1}>{p.displayName}{p.role ? <T mu size={12}>  {p.role}</T> : null}</T>
              <T mu size={12}>{p.seenAt ? `Seen ${clock(p.seenAt)}` : !p.onShift ? `Off shift · gets it at ${p.shift.start}` : 'Not opened'}</T>
            </View>
          </Row>))}
        {d.acknowledged.length ? <Label>Acknowledged ({d.acknowledged.length})</Label> : null}
        {d.acknowledged.map(p => <Row key={p.id} style={{ paddingVertical: 6 }}><Avatar name={p.displayName ?? ''} uri={p.avatar} size={32} /><T size={14} style={{ flex: 1 }} numberOfLines={1}>{p.displayName}</T><T size={12} style={{ color: C.green }}>✓ {clock(p.ackedAt!)}</T></Row>)}
      </ScrollView>
      <View style={{ paddingHorizontal: 18, paddingTop: 8, paddingBottom: 8, borderTopWidth: 1, borderTopColor: C.border, backgroundColor: C.bg }}>
        {left ? <Button testID="remind" title={`Remind ${left} ${left === 1 ? 'person' : 'people'}`} loading={busy} onPress={async () => {
          setBusy(true);
          try { const r = await api('POST', `/announcements/${id}/remind`); toast(`Reminder sent to ${r.deliveredNow}${r.held ? ` · ${r.held} off shift ${r.held === 1 ? 'gets' : 'get'} it when their shift starts` : ''}`); load(); }
          catch (e) { toast(errMsg(e)); } finally { setBusy(false); }
        }} /> : <T style={{ color: C.green, textAlign: 'center' }}>Everyone has acknowledged</T>}
      </View>
    </Screen>
  );
}
