import React, { useCallback, useEffect, useState } from 'react';
import { View, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { T, Header, Row, Avatar, Button, Empty, Spinner, s } from '../../components/ui';
import { api, errMsg } from '../../lib/api';
import { useApp } from '../../store/app';
import type { PublicUser } from '../../lib/types';
export default function Blocked() {
  const toast = useApp(st => st.showToast); const [list, setList] = useState<PublicUser[] | null>(null);
  const load = useCallback(() => api('GET', '/blocks').then(r => setList(r.blocked)).catch(e => { toast(errMsg(e)); setList([]); }), [toast]);
  useEffect(() => { load(); }, [load]);
  return (
    <SafeAreaView style={s.screen} edges={['top', 'bottom']}>
      <Header title="Blocked people" />
      <ScrollView contentContainerStyle={[s.body, { flexGrow: 1 }]}>
        {!list ? <Spinner /> : !list.length ? <Empty icon="block" title="Nobody blocked" body="People you block can't message or call you." /> : list.map(u => (
          <Row key={u.id} testID={`bl-${u.username}`}><Avatar name={u.displayName ?? '?'} uri={u.avatar} size={40} /><View style={{ flex: 1 }}><T weight="600">{u.displayName}</T><T mu size={12}>@{u.username}</T></View>
            <Button testID={`unblock-${u.username}`} title="Unblock" variant="secondary" style={{ paddingVertical: 8, paddingHorizontal: 14 }} onPress={async () => { try { await api('DELETE', `/blocks/${u.id}`); toast(`${u.displayName} unblocked`); load(); } catch (e) { toast(errMsg(e)); } }} /></Row>))}
      </ScrollView>
    </SafeAreaView>
  );
}
