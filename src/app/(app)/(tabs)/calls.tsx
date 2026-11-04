import React, { useCallback, useState } from 'react';
import { View, FlatList, RefreshControl } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { C } from '../../../theme';
import { T, Row, Avatar, Tap, Empty, Spinner, s } from '../../../components/ui';
import { Icon } from '../../../components/Icon';
import { api, errMsg } from '../../../lib/api';
import { startCall, callsAvailable } from '../../../lib/calls';
import { useApp } from '../../../store/app';
import { listTime } from '../../../lib/time';
import type { CallRecord } from '../../../lib/types';

const dur = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
export default function Calls() {
  const toast = useApp(st => st.showToast);
  const [calls, setCalls] = useState<CallRecord[] | null>(null); const [refreshing, setRefreshing] = useState(false);
  const load = useCallback(() => api('GET', '/calls').then(r => setCalls(r.calls)).catch(e => { toast(errMsg(e)); setCalls(c => c ?? []); }), [toast]);
  useFocusEffect(useCallback(() => { load(); }, [load]));
  const call = (c: CallRecord) => {
    if (!c.other) return;
    if (!callsAvailable()) return toast('Calls need the Understage development build (WebRTC isn’t available in Expo Go)');
    startCall(c.other.id, c.other.displayName ?? '').catch(e => toast(errMsg(e)));
  };
  return (
    <SafeAreaView style={s.screen} edges={['top']}>
      <T serif size={30} style={{ paddingHorizontal: 18, paddingTop: 4, paddingBottom: 8 }}>Calls</T>
      {!calls ? <Spinner /> : <FlatList data={calls} keyExtractor={c => c.id} contentContainerStyle={{ flexGrow: 1 }}
        refreshControl={<RefreshControl tintColor={C.gold} refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}
        ListEmptyComponent={<Empty icon="phone" title="No calls yet" body="End-to-end encrypted voice calls with your crew show up here." />}
        renderItem={({ item: c }) => {
          const missed = c.direction === 'incoming' && !c.answeredAt;
          return (
            <Row testID={`call-${c.id}`} style={{ paddingHorizontal: 18, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: C.border }}>
              <Avatar name={c.other?.displayName ?? '?'} uri={c.other?.avatar} size={44} />
              <View style={{ flex: 1 }}>
                <T weight="600" size={15} style={missed ? { color: C.red } : undefined}>{c.other?.displayName ?? 'Unknown'}</T>
                <T mu size={12.5}>{c.direction === 'outgoing' ? '↗ Outgoing' : missed ? '↙ Missed' : '↙ Incoming'}{c.answeredAt ? ` · ${dur(c.durationSec)}` : c.status !== 'ended' ? ` · ${c.status}` : ''} · {listTime(c.startedAt)}</T>
              </View>
              <Tap testID={`callback-${c.id}`} accessibilityLabel="Call back" onPress={() => call(c)} style={{ padding: 8 }}><Icon name="phone" size={22} color={C.gold} /></Tap>
            </Row>);
        }} />}
    </SafeAreaView>
  );
}
