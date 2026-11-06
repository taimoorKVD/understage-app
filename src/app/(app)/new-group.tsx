import React, { useEffect, useState } from 'react';
import { View, FlatList } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { C } from '../../theme';
import { T, Header, Input, Avatar, Button, Tap, Empty, ErrorText, s, Screen} from '../../components/ui';
import { Icon } from '../../components/Icon';
import { api, errMsg } from '../../lib/api';
import { createGroup, refreshConversation } from '../../lib/engine';
import { useApp } from '../../store/app';
import type { PublicUser } from '../../lib/types';

export default function NewGroup() {
  const { addTo } = useLocalSearchParams<{ addTo?: string }>();
  const conv = useApp(st => (addTo ? st.conversations[addTo] : undefined)); const existing = conv?.members.map(m => m.id) ?? [];
  const [contacts, setContacts] = useState<PublicUser[] | null>(null); const [sel, setSel] = useState<string[]>([]); const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api('GET', '/contacts').then(r => setContacts(r.contacts.filter((c: PublicUser) => !existing.includes(c.id)))).catch(e => setErr(errMsg(e))); }, []); // eslint-disable-line react-hooks/exhaustive-deps -- load contacts once; `existing` is a fresh array each render
  const toggle = (id: string) => setSel(x => (x.includes(id) ? x.filter(y => y !== id) : [...x, id]));
  const limit = 49 - existing.length;
  const go = async () => {
    setBusy(true); setErr(null);
    try {
      if (addTo) { await api('POST', `/conversations/${addTo}/members`, { userIds: sel }); await refreshConversation(addTo); router.back(); }
      else router.replace(`/chat/${await createGroup(title.trim(), sel)}`);
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Screen style={s.screen} edges={['top', 'bottom']}>
      <Header title={addTo ? 'Add people' : 'New group'} subtitle={`${sel.length} selected · up to 50 per encrypted group`} />
      <View style={[s.body, { flex: 1 }]}>
        {!addTo ? <Input testID="gname" value={title} onChangeText={setTitle} placeholder="Group name, e.g. Lighting Dept" maxLength={60} /> : null}
        <FlatList data={contacts ?? []} keyExtractor={c => c.id} style={{ flex: 1 }}
          ListEmptyComponent={contacts ? <Empty icon="users" title="No contacts to add" body="Add colleagues first, by @username or QR." /> : undefined}
          renderItem={({ item: c }) => {
            const on = sel.includes(c.id);
            return <Tap testID={`pick-${c.username}`} onPress={() => (on || sel.length < limit ? toggle(c.id) : useApp.getState().showToast('Encrypted groups are limited to 50 members'))} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8 }}>
              <Avatar name={c.displayName ?? ''} uri={c.avatar} size={40} />
              <View style={{ flex: 1 }}><T weight="600">{c.displayName}</T><T mu size={12}>@{c.username}{c.role ? ` · ${c.role}` : ''}</T></View>
              <View style={{ width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: on ? C.gold : C.border2, backgroundColor: on ? C.gold : 'transparent', alignItems: 'center', justifyContent: 'center' }}>{on ? <Icon name="check" size={14} color="#000" /> : null}</View>
            </Tap>;
          }} />
        <ErrorText>{err}</ErrorText>
        <Button testID="gcreate" title={addTo ? 'Add to group' : 'Create group'} loading={busy} disabled={!sel.length || (!addTo && !title.trim())} onPress={go} />
      </View>
    </Screen>
  );
}
