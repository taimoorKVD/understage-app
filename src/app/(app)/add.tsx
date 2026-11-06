import React, { useEffect, useState } from 'react';
import { View, ScrollView } from 'react-native';
import { router } from 'expo-router';
import { C } from '../../theme';
import { T, Header, Input, Avatar, Row, Button, Spinner, s, Screen} from '../../components/ui';
import { Icon } from '../../components/Icon';
import { api, errMsg } from '../../lib/api';
import { openDirect } from '../../lib/engine';
import { useApp } from '../../store/app';
import type { PublicUser } from '../../lib/types';

type R = PublicUser & { isContact: boolean };
export default function Add() {
  const toast = useApp(st => st.showToast);
  const [q, setQ] = useState(''); const [resRaw, setRes] = useState<{ q: string; results: R[] | null } | null>(null); const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    const t = q.trim(); if (t.replace(/^@/, '').length < 2) return;
    const h = setTimeout(() => { api<{ results: R[] }>('GET', `/users/search?q=${encodeURIComponent(t)}`).then(r => setRes({ q: t, results: r.results })).catch(e => { toast(errMsg(e)); setRes(p => ({ q: t, results: p?.results ?? null })); }); }, 300);
    return () => clearTimeout(h);
  }, [q, toast]);
  // Results only apply while the query is long enough; shorter queries show nothing (derived, not reset in the effect).
  const long = q.trim().replace(/^@/, '').length >= 2;
  const res = long ? resRaw?.results ?? null : null;
  const loading = long && resRaw?.q !== q.trim();
  const add = async (u: R) => {
    setBusy(u.id);
    try { if (!u.isContact) await api('POST', '/contacts', { userId: u.id }); const cid = await openDirect(u.id); router.replace(`/chat/${cid}`); }
    catch (e) { toast(errMsg(e)); } finally { setBusy(null); }
  };
  return (
    <Screen style={s.screen} edges={['top', 'bottom']}>
      <Header title="Add contact" subtitle="Find people by username — never by phone number" />
      <View style={[s.body, { flex: 1 }]}>
        <Input testID="search" value={q} onChangeText={setQ} placeholder="Search @username" autoCapitalize="none" autoCorrect={false} autoFocus left={<Icon name="users" size={18} color={C.muted} />} right={loading ? <Spinner size={16} /> : null} />
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: 10 }} keyboardShouldPersistTaps="handled">
          {res?.length === 0 ? <T mu style={{ textAlign: 'center', marginTop: 20 }}>No one found for “{q}”</T> : null}
          {res?.map(u => (
            <Row key={u.id} testID={`res-${u.username}`} style={{ backgroundColor: C.card, borderRadius: 16, padding: 12 }}>
              <Avatar name={u.displayName ?? '?'} uri={u.avatar} size={44} />
              <View style={{ flex: 1 }}><T weight="700">{u.displayName}</T><T mu size={13}>@{u.username}{u.role ? ` · ${u.role}` : ''}</T></View>
              <Button testID={`add-${u.username}`} title={u.isContact ? 'Message' : 'Add'} loading={busy === u.id} style={{ paddingVertical: 8, paddingHorizontal: 16 }} onPress={() => add(u)} />
            </Row>))}
        </ScrollView>
        <Row gap={10}>
          <Button testID="scanbtn" title="Scan QR" icon="cam" variant="secondary" style={{ flex: 1 }} onPress={() => router.push('/scan')} />
          <Button testID="myqr" title="My QR" icon="qr" variant="secondary" style={{ flex: 1 }} onPress={() => router.push('/myqr')} />
        </Row>
      </View>
    </Screen>
  );
}
