import React, { useMemo, useState } from 'react';
import { View, FlatList, RefreshControl, ScrollView, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C } from '../../../theme';
import { T, Tap, SearchField, Avatar, Pill, Row, Empty, Button, Badge, s, Screen} from '../../../components/ui';
import { Icon } from '../../../components/Icon';
import { useApp } from '../../../store/app';
import { refreshAll } from '../../../lib/engine';
import { convTitle, lastPreview, otherMember } from '../../../lib/format';
import { isOnShift, listTime } from '../../../lib/time';

export function ShiftPill() {
  const me = useApp(s => s.me);
  if (!me) return null;
  const on = isOnShift(me.shift, me.timezone, true);
  return <Pill testID="shiftpill" bg={on ? C.greenPill : C.track} color={on ? C.green : C.violet}>{on ? '● On shift' : '☾ Off shift'}</Pill>;
}
export function ConnBar() {
  const online = useApp(s => s.online), sock = useApp(s => s.socketConnected);
  const pending = useApp(s => Object.values(s.messages).reduce((n, l) => n + l.filter(m => !m.id && (m.status === 'pending' || m.status === 'sending')).length, 0));
  if (online && sock && !pending) return null;
  const text = !online ? `Offline${pending ? ` · ${pending} waiting to send` : ''}` : !sock ? 'Connecting…' : `Sending ${pending}…`;
  return <View testID="connbar" style={{ backgroundColor: C.dangerCard, paddingVertical: 6, alignItems: 'center' }}><T size={12} style={{ color: C.red }}>{text}</T></View>;
}

export default function Chats() {
  const me = useApp(s => s.me)!;
  const order = useApp(s => s.convOrder), convs = useApp(s => s.conversations), msgs = useApp(s => s.messages);
  const workspaces = useApp(s => s.workspaces);
  const insets = useSafeAreaInsets();
  const [q, setQ] = useState(''); const [refreshing, setRefreshing] = useState(false);
  const pins = useMemo(() => workspaces.map(w => ({ w, c: Object.values(convs).find(x => x.kind === 'workspace' && x.workspaceId === w.id) })), [workspaces, convs]);
  const pinIds = useMemo(() => new Set(pins.map(p => p.c?.id).filter(Boolean) as string[]), [pins]);
  const crew = useMemo(() => {
    const seen = new Set<string>();
    const list: { key: string; name: string; uri?: string | null; convId: string }[] = [];
    for (const id of order) {
      const c = convs[id];
      if (!c || c.kind !== 'direct') continue;
      const o = otherMember(c, me.id);
      if (!o || !o.onShift || seen.has(o.id)) continue;
      seen.add(o.id);
      list.push({ key: o.id, name: o.displayName || o.username || '?', uri: o.avatar, convId: c.id });
    }
    return list;
  }, [order, convs, me.id]);
  const rows = useMemo(() => order.map(id => convs[id]).filter(Boolean)
    .filter(c => q || !pinIds.has(c.id))
    .map(c => ({ c, title: convTitle(c, me.id), p: lastPreview(c, msgs[c.id], me.id) }))
    .filter(r => !q || r.title.toLowerCase().includes(q.toLowerCase())).sort((a, b) => b.p.at - a.p.at), [order, convs, msgs, q, me.id, pinIds]);
  // Stage dock sits in an absolute tab bar: pill (~68) + container padding + home-indicator inset + a gap so the last row clears the orb.
  const listBottom = 80 + Math.max(insets.bottom, 8) + 16;
  return (
    <Screen style={s.screen} edges={['top']}>
      <ConnBar />
      <Row style={st.header}>
        <T serif size={28}>Chats</T>
        <ShiftPill />
        <View style={{ flex: 1 }} />
        <Tap testID="newgroup" accessibilityLabel="New group" onPress={() => router.push('/new-group')} style={st.iconBtn}><Icon name="users" size={17} color={C.gold} /></Tap>
        <Tap testID="addbtn" accessibilityLabel="Add contact" onPress={() => router.push('/add')} style={st.addBtn}><Icon name="plus" size={18} color="#000" /></Tap>
      </Row>
      <View style={st.searchWrap}>
        <SearchField testID="chatsearch" value={q} onChangeText={setQ} placeholder="Search chats" containerStyle={st.search} />
      </View>
      {crew.length && !q ? (
        <View style={st.crewWrap}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={st.crewScroll} contentContainerStyle={st.crewContent}>
            {crew.map(p => (
              <Tap key={p.key} onPress={() => router.push(`/chat/${p.convId}`)} style={st.crewItem}>
                <Avatar name={p.name} uri={p.uri} size={44} ring />
                <T size={11} numberOfLines={1} style={st.crewName}>{p.name.split(' ')[0]}</T>
              </Tap>
            ))}
          </ScrollView>
        </View>
      ) : null}
      <FlatList data={rows} keyExtractor={r => r.c.id} contentContainerStyle={{ paddingBottom: listBottom, flexGrow: 1 }}
        refreshControl={<RefreshControl tintColor={C.gold} refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await refreshAll(); setRefreshing(false); }} />}
        ItemSeparatorComponent={() => <View style={st.sep} />}
        ListHeaderComponent={!q && pins.length ? (
          <View style={st.pinWrap}>
            {pins.map(({ w, c }) => {
              const others = (c?.members ?? []).filter(m => m.id !== me.id);
              const members = others.slice(0, 3);
              const extra = Math.max(0, others.length - members.length);
              const unread = c?.unread ?? 0;
              const meta = ['Pinned', unread ? `${unread} unread` : null, w.venue || null].filter(Boolean).join(' · ');
              return (
                <Tap key={w.id} testID={c ? `conv-${c.id}` : `pin-ws-${w.id}`} onPress={() => c ? router.push(`/chat/${c.id}`) : router.push(`/workspace/${w.id}`)} style={st.pinRow}>
                  <Avatar name={w.initial} size={36} bg={C.gold} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Row gap={6}>
                      <T weight="700" size={14} numberOfLines={1} style={{ flexShrink: 1, minWidth: 0 }}>{w.name}</T>
                      {!c?.e2eeError ? <Icon name="lock" size={11} color={C.gold} /> : null}
                    </Row>
                    <T mu size={11} numberOfLines={1}>{meta}</T>
                  </View>
                  <View style={st.stack}>
                    {members.map((m, i) => (
                      <View key={m.id} style={[st.stackAvatar, { marginLeft: i ? -8 : 0, zIndex: 10 - i }]}>
                        <Avatar name={m.displayName || '?'} uri={m.avatar} size={18} />
                      </View>
                    ))}
                    {(extra > 0 || w.memberCount) ? (
                      <View style={st.countPill}>
                        <T size={10} weight="700" gold>{extra > 0 ? `+${extra}` : w.memberCount}</T>
                      </View>
                    ) : null}
                  </View>
                  <Badge count={unread} />
                </Tap>
              );
            })}
          </View>
        ) : undefined}
        ListEmptyComponent={q ? <Empty icon="search" title="No chats match" /> : <Empty icon="chat" title="No chats yet" body="Add a colleague by @username or QR code to start an encrypted chat." action={<Button testID="empty-add" title="Add contact" onPress={() => router.push('/add')} />} />}
        renderItem={({ item: { c, title, p } }) => {
          const other = c.kind === 'direct' ? otherMember(c, me.id) : undefined;
          const locked = c.kind !== 'workspace' || !c.e2eeError;
          return (
            <Tap testID={`conv-${c.id}`} onPress={() => router.push(`/chat/${c.id}`)} style={st.convRow}>
              <Avatar name={c.kind === 'workspace' ? (c.workspace?.initial ?? title) : title} uri={other?.avatar} size={42} bg={c.kind === 'workspace' ? C.gold : undefined} ring={!!other?.onShift} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Row gap={6}>
                  <T weight="600" size={15} numberOfLines={1} style={{ flexShrink: 1, minWidth: 0 }}>{title}</T>
                  {locked ? <Icon name="lock" size={11} color={C.gold} /> : null}
                  <T mu size={11} style={{ marginLeft: 'auto' }}>{listTime(p.at)}</T>
                </Row>
                <Row gap={8} style={{ marginTop: 2 }}>
                  <T mu size={13} numberOfLines={1} style={{ flex: 1 }}>{p.status === 'failed' ? '⚠️ ' : ''}{p.text}</T>
                  <Badge count={c.unread} />
                </Row>
              </View>
            </Tap>
          );
        }} />
    </Screen>
  );
}

const st = StyleSheet.create({
  header: { paddingHorizontal: 18, paddingTop: 2, paddingBottom: 8, gap: 8 },
  iconBtn: { width: 34, height: 34, borderRadius: 17, backgroundColor: C.input, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: C.border },
  addBtn: { width: 34, height: 34, borderRadius: 17, backgroundColor: C.gold, alignItems: 'center', justifyContent: 'center' },
  searchWrap: { paddingHorizontal: 18, paddingBottom: 8 },
  search: { borderRadius: 18, paddingVertical: 8 },
  crewWrap: { height: 84, marginBottom: 4, overflow: 'hidden' },
  crewScroll: { flex: 1 },
  crewContent: { paddingHorizontal: 18, paddingTop: 2, paddingBottom: 8, gap: 12, alignItems: 'flex-start' },
  crewItem: { alignItems: 'center', width: 56 },
  crewName: { marginTop: 6, width: 56, textAlign: 'center', lineHeight: 14 },
  pinWrap: { paddingHorizontal: 18, paddingTop: 4, paddingBottom: 8, gap: 8 },
  pinRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 8, paddingHorizontal: 10,
    backgroundColor: C.glass, borderWidth: 1, borderColor: C.border2, borderRadius: 16,
  },
  stack: { flexDirection: 'row', alignItems: 'center', flexShrink: 0 },
  stackAvatar: { borderRadius: 10, borderWidth: 1.5, borderColor: C.bg },
  countPill: {
    marginLeft: 6, minWidth: 22, height: 18, paddingHorizontal: 5, borderRadius: 9,
    backgroundColor: C.goldSoft, alignItems: 'center', justifyContent: 'center',
  },
  convRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingVertical: 11, paddingHorizontal: 18, minHeight: 64,
  },
  sep: { height: StyleSheet.hairlineWidth, backgroundColor: C.border, marginLeft: 72 },
});
