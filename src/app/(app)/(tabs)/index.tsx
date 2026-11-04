import React, { useMemo, useState } from 'react';
import { View, FlatList, RefreshControl } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { C } from '../../../theme';
import { T, Tap, Input, Avatar, Pill, Row, Empty, Button, s } from '../../../components/ui';
import { Icon } from '../../../components/Icon';
import { useApp } from '../../../store/app';
import { refreshAll } from '../../../lib/engine';
import { convTitle, lastPreview, otherMember } from '../../../lib/format';
import { isOnShift, listTime } from '../../../lib/time';

export function ShiftPill() {
  const me = useApp(s => s.me);
  if (!me) return null;
  const on = isOnShift(me.shift, me.timezone, true);
  return <Pill testID="shiftpill" bg={on ? C.greenPill : '#1d1726'} color={on ? C.green : C.violet}>{on ? '● On shift' : '☾ Off shift'}</Pill>;
}
export function ConnBar() {
  const online = useApp(s => s.online), sock = useApp(s => s.socketConnected);
  const pending = useApp(s => Object.values(s.messages).reduce((n, l) => n + l.filter(m => !m.id && (m.status === 'pending' || m.status === 'sending')).length, 0));
  if (online && sock && !pending) return null;
  const text = !online ? `Offline${pending ? ` · ${pending} waiting to send` : ''}` : !sock ? 'Connecting…' : `Sending ${pending}…`;
  return <View testID="connbar" style={{ backgroundColor: '#24121a', paddingVertical: 6, alignItems: 'center' }}><T size={12} style={{ color: '#ffb3c0' }}>{text}</T></View>;
}

export default function Chats() {
  const me = useApp(s => s.me)!;
  const order = useApp(s => s.convOrder), convs = useApp(s => s.conversations), msgs = useApp(s => s.messages);
  const [q, setQ] = useState(''); const [refreshing, setRefreshing] = useState(false);
  const rows = useMemo(() => order.map(id => convs[id]).filter(Boolean).map(c => ({ c, title: convTitle(c, me.id), p: lastPreview(c, msgs[c.id], me.id) }))
    .filter(r => !q || r.title.toLowerCase().includes(q.toLowerCase())).sort((a, b) => b.p.at - a.p.at), [order, convs, msgs, q, me.id]);
  return (
    <SafeAreaView style={s.screen} edges={['top']}>
      <ConnBar />
      <Row style={{ paddingHorizontal: 18, paddingTop: 4, paddingBottom: 8 }}>
        <T serif size={30} style={{ flex: 1 }}>Chats</T>
        <ShiftPill />
        <Tap testID="newgroup" accessibilityLabel="New group" onPress={() => router.push('/new-group')} style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: C.input, alignItems: 'center', justifyContent: 'center' }}><Icon name="users" size={18} color={C.gold} /></Tap>
        <Tap testID="addbtn" accessibilityLabel="Add contact" onPress={() => router.push('/add')} style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: C.gold, alignItems: 'center', justifyContent: 'center' }}><Icon name="plus" size={20} color="#000" /></Tap>
      </Row>
      <View style={{ paddingHorizontal: 18, paddingBottom: 6 }}>
        <Input testID="chatsearch" value={q} onChangeText={setQ} placeholder="Search" containerStyle={{ paddingVertical: 10 }} left={<Icon name="search" size={16} color={C.muted} />} />
      </View>
      <FlatList data={rows} keyExtractor={r => r.c.id} contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: 30, flexGrow: 1 }}
        refreshControl={<RefreshControl tintColor={C.gold} refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await refreshAll(); setRefreshing(false); }} />}
        ListEmptyComponent={q ? <Empty icon="search" title="No chats match" /> : <Empty icon="chat" title="No chats yet" body="Add a colleague by @username or QR code to start an encrypted chat." action={<Button testID="empty-add" title="Add contact" onPress={() => router.push('/add')} />} />}
        renderItem={({ item: { c, title, p } }) => {
          const other = c.kind === 'direct' ? otherMember(c, me.id) : undefined;
          return (
            <Tap testID={`conv-${c.id}`} onPress={() => router.push(`/chat/${c.id}`)} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 }}>
              <View>
                <Avatar name={c.kind === 'workspace' ? (c.workspace?.initial ?? title) : title} uri={other?.avatar} size={46} bg={c.kind === 'workspace' ? C.gold : undefined} />
                {other?.onShift ? <View style={{ position: 'absolute', right: 0, bottom: 0, width: 12, height: 12, borderRadius: 6, backgroundColor: C.green, borderWidth: 2, borderColor: C.bg }} /> : null}
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Row gap={6}><T weight="700" size={15} numberOfLines={1} style={{ flex: 1 }}>{title}</T><T mu size={12}>{listTime(p.at)}</T></Row>
                <Row gap={6}>
                  <T mu size={13} numberOfLines={1} style={{ flex: 1 }}>{p.status === 'failed' ? '⚠️ ' : ''}{p.text}</T>
                  {c.unread ? <View style={{ minWidth: 20, height: 20, borderRadius: 10, backgroundColor: C.gold, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5 }}><T size={11} weight="800" style={{ color: '#000' }}>{c.unread}</T></View> : null}
                </Row>
              </View>
            </Tap>
          );
        }} />
    </SafeAreaView>
  );
}
