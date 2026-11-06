import React, { useCallback, useEffect, useState } from 'react';
import { View, FlatList, Share } from 'react-native';
import { router, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { C, G } from '../../../theme';
import { T, Card, Row, Avatar, Button, Tap, Pill, Bar, Input, Empty, Spinner, s, Screen} from '../../../components/ui';
import { Icon } from '../../../components/Icon';
import { api, errMsg } from '../../../lib/api';
import { bus } from '../../../lib/events';
import { openDirect } from '../../../lib/engine';
import { useApp } from '../../../store/app';
import { listTime, clock, tzCity } from '../../../lib/time';
import type { Workspace, Announcement, WsMember } from '../../../lib/types';

type Seg = 'a' | 'd' | 'm';
export default function WorkspaceScreen() {
  const { id, seg: segParam } = useLocalSearchParams<{ id: string; seg?: string }>();
  const toast = useApp(st => st.showToast);
  const [ws, setWs] = useState<Workspace | null>(null); const [anns, setAnns] = useState<Announcement[] | null>(null);
  const segRaw = Array.isArray(segParam) ? segParam[0] : segParam;
  const urlSeg: Seg | null = segRaw === 'd' || segRaw === 'm' || segRaw === 'a' ? segRaw : null;
  const [segUser, setSeg] = useState<Seg | null>(null); const [members, setMembers] = useState<WsMember[] | null>(null); const [total, setTotal] = useState(0);
  const seg: Seg = segUser ?? urlSeg ?? 'a';
  const [q, setQ] = useState(''); const [dept, setDept] = useState<string | null>(null); const [acking, setAcking] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const [w, a] = await Promise.all([api('GET', `/workspaces/${id}`), api('GET', `/workspaces/${id}/announcements`)]);
      setWs(w.workspace); setAnns(a.announcements);
      for (const x of a.announcements as Announcement[]) if (!x.mine && !x.myAckAt) api('POST', `/announcements/${x.id}/seen`).catch(() => {});
    } catch (e) { toast(errMsg(e)); }
  }, [id, toast]);
  const loadMembers = useCallback(async () => {
    const p = new URLSearchParams({ limit: '200' }); if (q) p.set('q', q); if (dept) p.set('departmentId', dept);
    try { const r = await api('GET', `/workspaces/${id}/members?${p}`); setMembers(r.members); setTotal(r.total); } catch (e) { toast(errMsg(e)); }
  }, [id, q, dept, toast]);
  useFocusEffect(useCallback(() => { load(); }, [load]));
  useEffect(() => { if (seg === 'm') { const t = setTimeout(loadMembers, 250); return () => clearTimeout(t); } }, [seg, loadMembers]);
  useEffect(() => {
    const offs = [
      bus.on('announcement:new', (d: any) => d.workspaceId === id && load()),
      bus.on('announcement:ack', (d: any) => setAnns(xs => xs?.map(a => (a.id === d.announcementId ? { ...a, acked: d.acked, seenNotAcked: d.seenNotAcked, total: d.total } : a)) ?? xs)),
      bus.on('workspace:wrapped', (d: any) => d.workspaceId === id && load()),
    ];
    return () => offs.forEach(o => o());
  }, [id, load]);
  if (!ws) return <Screen style={[s.screen, { alignItems: 'center', justifyContent: 'center' }]}><Spinner /></Screen>;
  const admin = ws.myRole === 'owner' || ws.myRole === 'admin';
  const ack = async (a: Announcement) => {
    setAcking(a.id);
    try { const r = await api('POST', `/announcements/${a.id}/ack`); setAnns(xs => xs?.map(x => (x.id === a.id ? { ...x, myAckAt: r.ackedAt, acked: r.acked, seenNotAcked: r.seenNotAcked } : x)) ?? xs); }
    catch (e) { toast(errMsg(e)); } finally { setAcking(null); }
  };
  const invite = async () => { try { const r = await api('POST', '/invites', { kind: 'workspace', workspaceId: ws.id }); Share.share({ message: `Join ${ws.name} on Understage: ${r.url}` }); } catch (e) { toast(errMsg(e)); } };

  const header = (
    <View>
      <LinearGradient colors={[...G.hero]} start={{ x: 0, y: 0 }} end={{ x: 0.25, y: 1 }} style={{ paddingHorizontal: 18, paddingTop: 12, paddingBottom: 28 }}>
        <Row>
          <Tap testID="back" onPress={() => (router.canGoBack() ? router.back() : router.replace('/workspace'))} style={{ padding: 2 }}><Icon name="back" size={22} color={C.text} /></Tap>
          <Avatar name={ws.initial} size={50} bg={C.gold} />
          <View style={{ flex: 1, minWidth: 0 }}><T serif size={24} numberOfLines={2}>{ws.name}</T><T mu size={12.5} testID="wsmeta">{ws.memberCount} members{ws.venue ? ` · ${ws.venue}` : ''}{ws.runLabel ? ` · ${ws.runLabel}` : ''}</T></View>
          {ws.conversationId ? <Tap testID="wschat" accessibilityLabel="Company chat" onPress={() => router.push(`/chat/${ws.conversationId}`)} style={{ padding: 6 }}><Icon name="chat" size={22} color={C.text} /></Tap> : null}
          <Tap testID="wsset" accessibilityLabel="Workspace settings" onPress={() => router.push(`/wsset/${ws.id}`)} style={{ padding: 6 }}><Icon name="gear" size={22} color={C.text} /></Tap>
        </Row>
      </LinearGradient>
      <Row gap={4} style={{ margin: 14, backgroundColor: C.input, borderRadius: 12, padding: 4 }}>
        {([['a', 'Announcements'], ['d', 'Departments'], ['m', 'Members']] as const).map(([k, t]) => (
          <Tap key={k} testID={`sg-${k}`} onPress={() => setSeg(k)} style={{ flex: 1, paddingVertical: 8, borderRadius: 9, alignItems: 'center', backgroundColor: seg === k ? C.segOn : 'transparent' }}>
            <T size={13} weight={seg === k ? '700' : '500'} style={{ color: seg === k ? C.gold : C.muted }}>{t}</T></Tap>))}
      </Row>
      {ws.wrappedAt && seg === 'a' ? <Card style={{ marginHorizontal: 18, borderColor: C.red, backgroundColor: C.dangerCard, alignItems: 'center' }}><T weight="700">🎭 This production has wrapped</T><T mu size={12.5}>Read-only archive{ws.deleteAfter ? ` · closes ${new Date(ws.deleteAfter).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}</T></Card> : null}
      {seg === 'm' ? <View style={{ paddingHorizontal: 18, gap: 8 }}>
        <Input testID="msearch" value={q} onChangeText={setQ} placeholder="Search members" left={<Icon name="search" size={16} color={C.muted} />} />
        <T mu size={12}>{dept ? `${ws.departments.find(d => d.id === dept)?.name} · ` : ''}{total} people · everyone in their own local time{dept ? '  ' : ''}{dept ? <T gold size={12} onPress={() => setDept(null)}>Clear</T> : null}</T>
      </View> : null}
      {seg === 'd' ? <T mu size={12} style={{ paddingHorizontal: 18, textTransform: 'uppercase', letterSpacing: 1.5 }}>{ws.departments.length} departments · {ws.memberCount} people</T> : null}
    </View>
  );

  const items: any[] = seg === 'a' ? anns ?? [] : seg === 'd' ? ws.departments : members ?? [];
  return (
    <Screen style={s.screen} edges={['top']}>
      <FlatList data={items} key={seg} keyExtractor={(x: any) => x.id} numColumns={seg === 'd' ? 2 : 1} ListHeaderComponent={header} contentContainerStyle={{ paddingBottom: 120, gap: 10 }} columnWrapperStyle={seg === 'd' ? { paddingHorizontal: 18, gap: 10 } : undefined}
        ListEmptyComponent={seg === 'a' ? (anns ? <Empty icon="mega" title="No announcements yet" body={admin ? 'Post a call time, a rota change or a safety note to everyone.' : 'Company announcements will appear here.'} /> : <Spinner />) : seg === 'm' && !members ? <Spinner /> : <Empty icon="users" title="Nothing here yet" action={admin && seg === 'm' ? <Button title="Invite people" onPress={invite} /> : undefined} />}
        renderItem={({ item }) => <View style={{ paddingHorizontal: seg === 'd' ? 0 : 18, flex: seg === 'd' ? 1 : undefined }}>{
          seg === 'a' ? <AnnCard a={item} wrapped={!!ws.wrappedAt} acking={acking === item.id} onAck={() => ack(item)} onTrack={() => (item.mine || admin ? router.push(`/ack/${item.id}`) : null)} />
          : seg === 'd' ? <Card testID={`dept-${item.id}`} onPress={() => { setDept(item.id); setSeg('m'); }} style={{ minHeight: 108, justifyContent: 'space-between' }}><Icon name="users" size={18} color={C.gold} /><T size={14} weight="600" numberOfLines={2} style={{ marginTop: 8 }}>{item.name}</T><T gold serif size={28}>{item.count}</T></Card>
          : <MemberRow m={item} ws={ws} admin={admin} reload={loadMembers} />
        }</View>} />
      {admin && !ws.wrappedAt ? <>
        <Tap testID="newann" accessibilityLabel="New announcement" onPress={() => router.push(`/compose/${ws.id}`)} style={{ position: 'absolute', right: 20, bottom: 40, width: 56, height: 56, borderRadius: 28, backgroundColor: C.gold, alignItems: 'center', justifyContent: 'center', shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 10, shadowOffset: { width: 0, height: 8 } }}><Icon name="mega" size={24} color="#000" /></Tap>
        <Tap testID="wsinvite" accessibilityLabel="Invite" onPress={invite} style={{ position: 'absolute', right: 86, bottom: 46, width: 44, height: 44, borderRadius: 22, backgroundColor: C.input, alignItems: 'center', justifyContent: 'center' }}><Icon name="plus" size={20} color={C.gold} /></Tap>
      </> : null}
    </Screen>
  );
}

function AnnCard({ a, wrapped, acking, onAck, onTrack }: { a: Announcement; wrapped: boolean; acking: boolean; onAck: () => void; onTrack: () => void }) {
  const pct = a.total ? (a.acked / a.total) * 100 : 0;
  return (
    <Card testID={`ann-${a.id}`} style={a.requireAck && !a.mine && !a.myAckAt ? { borderColor: C.gold } : undefined}>
      <Row gap={8}><Icon name="mega" size={18} color={C.gold} /><T size={11} weight="600" gold style={{ textTransform: 'uppercase', letterSpacing: 1.2, flex: 1 }}>{a.mine ? 'Your announcement' : 'Announcement'}{a.requireAck ? ' · acknowledgement required' : ''}</T></Row>
      <T weight="700" size={17} style={{ marginTop: 9, marginBottom: 5 }}>{a.title}</T>
      <T size={13.5} style={{ lineHeight: 20, color: '#ddd' }}>{a.body}</T>
      <Row gap={6} style={{ marginVertical: 10 }}><Avatar name={a.authorName} size={22} /><T mu size={12}>{a.authorName} · {listTime(a.createdAt)}</T></Row>
      {a.requireAck ? <Tap testID={`${a.id}-track`} onPress={onTrack} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Bar pct={pct} style={{ flex: 1 }} /><T gold weight="700" size={13} testID={`${a.id}-n`}>{a.acked}/{a.total}</T><T mu>›</T></Tap> : null}
      {a.requireAck && !a.mine ? (a.myAckAt
        ? <View style={{ marginTop: 12, borderWidth: 1, borderColor: C.green, borderRadius: 14, padding: 12, alignItems: 'center' }}><T style={{ color: C.green }} weight="600">✓ Acknowledged · {clock(a.myAckAt)}</T></View>
        : !wrapped ? <Button testID="ackbtn" title="Acknowledge" loading={acking} style={{ marginTop: 12 }} onPress={onAck} /> : null) : null}
    </Card>
  );
}

function MemberRow({ m, ws, admin, reload }: { m: WsMember; ws: Workspace; admin: boolean; reload: () => void }) {
  const me = useApp(st => st.me)!; const toast = useApp(st => st.showToast); const [open, setOpen] = useState(false);
  const act = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); toast(ok); setOpen(false); reload(); } catch (e) { toast(errMsg(e)); } };
  return (
    <Card testID={`mem-${m.username}`} onPress={() => setOpen(o => !o)} style={{ paddingVertical: 10 }}>
      <Row>
        <Avatar name={m.displayName ?? ''} uri={m.avatar} size={38} />
        <View style={{ flex: 1 }}><T weight="700" size={14}>{m.displayName}{m.wsRole !== 'member' ? <T gold size={11}>  {m.wsRole.toUpperCase()}</T> : null}</T><T mu size={12}>{[m.role || m.departmentName, `${m.localTime} ${m.city || tzCity(m.timezone)}`].filter(Boolean).join(' · ')}</T></View>
        <Pill icon={m.onShift ? undefined : 'moon'} bg={m.onShift ? C.pill : C.track} color={m.onShift ? C.gold : '#999'}>{m.onShift ? '● On shift' : 'Off shift'}</Pill>
      </Row>
      {open && m.id !== me.id ? <Row gap={8} style={{ marginTop: 10, flexWrap: 'wrap' }}>
        <Button testID={`mdm-${m.username}`} title="Message" variant="secondary" style={{ paddingVertical: 8, paddingHorizontal: 14 }} onPress={async () => { try { router.push(`/chat/${await openDirect(m.id)}`); } catch (e) { toast(errMsg(e)); } }} />
        {admin && m.wsRole !== 'owner' && !ws.wrappedAt ? <>
          <Button testID={`mrole-${m.username}`} title={m.wsRole === 'admin' ? 'Remove admin' : 'Make admin'} variant="secondary" style={{ paddingVertical: 8, paddingHorizontal: 14 }} onPress={() => act(() => api('PATCH', `/workspaces/${ws.id}/members/${m.id}`, { role: m.wsRole === 'admin' ? 'member' : 'admin' }), 'Role updated')} />
          <Button testID={`mrm-${m.username}`} title="Remove" variant="danger" style={{ paddingVertical: 8, paddingHorizontal: 14 }} onPress={() => act(() => api('DELETE', `/workspaces/${ws.id}/members/${m.id}`), `${m.displayName} removed`)} />
        </> : null}
      </Row> : null}
      {open && admin && m.wsRole !== 'owner' && !ws.wrappedAt && ws.departments.length ? <Row gap={6} style={{ marginTop: 8, flexWrap: 'wrap' }}>
        {ws.departments.map(d => <Tap key={d.id} onPress={() => act(() => api('PATCH', `/workspaces/${ws.id}/members/${m.id}`, { departmentId: d.id }), `Moved to ${d.name}`)}><Pill bg={m.departmentId === d.id ? C.pill : C.track} color={m.departmentId === d.id ? C.gold : '#aaa'}>{d.name}</Pill></Tap>)}
      </Row> : null}
    </Card>
  );
}
