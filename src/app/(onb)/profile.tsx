import React, { useEffect, useState } from 'react';
import { View, ScrollView, KeyboardAvoidingView, Platform } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import { C } from '../../theme';
import { T, Button, Header, Input, Label, Tap, Avatar, ErrorText, Spinner, s } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { api, errMsg } from '../../lib/api';
import { setMe } from '../../lib/engine';
import { useApp } from '../../store/app';
import type { SelfUser } from '../../lib/types';

export async function pickAvatar(): Promise<string | null> {
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) { useApp.getState().showToast('Allow photo access in Settings to add a picture'); return null; }
  const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: true, aspect: [1, 1], quality: 0.25, base64: true });
  if (r.canceled || !r.assets[0]?.base64) return null;
  const uri = `data:image/jpeg;base64,${r.assets[0].base64}`;
  if (uri.length > 400_000) { useApp.getState().showToast('That photo is too large — try another'); return null; }
  return uri;
}

export function ProfileForm({ onDone, cta, editing }: { onDone: () => void; cta: string; editing?: boolean }) {
  const me = useApp(st => st.me)!;
  const [displayName, setName] = useState(me.displayName ?? '');
  const [username, setUsername] = useState(me.username ?? '');
  const [role, setRole] = useState(me.role ?? '');
  const [department, setDept] = useState(me.department ?? '');
  const [avatar, setAvatar] = useState<string | null>(me.avatar);
  const [checkRaw, setCheck] = useState<{ for: string; state: 'idle' | 'checking' | 'ok' | 'bad'; msg?: string } | null>(null);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const u = username.trim().toLowerCase();
    if (!u || u === me.username) return;
    const t = setTimeout(async () => {
      try { const r = await api<{ available: boolean; reason: string | null }>('GET', `/users/check-username?username=${encodeURIComponent(u)}`); setCheck(r.available ? { for: u, state: 'ok', msg: `@${u} is available` } : { for: u, state: 'bad', msg: r.reason ?? 'Not available' }); }
      catch (e) { setCheck({ for: u, state: 'bad', msg: errMsg(e) }); }
    }, 350);
    return () => clearTimeout(t);
  }, [username, me.username]);
  // Own/empty username is derived, not stored; a debounced server check covers everything else.
  const uNorm = username.trim().toLowerCase();
  const check = !uNorm ? { state: 'idle' as const, msg: undefined } : uNorm === me.username ? { state: 'ok' as const, msg: undefined } : checkRaw?.for === uNorm ? checkRaw : { state: 'checking' as const, msg: undefined };

  async function save() {
    setBusy(true); setErr(null);
    try {
      const r = await api<SelfUser>('PATCH', '/me', { displayName: displayName.trim(), username: username.trim().toLowerCase(), role: role.trim(), department: department.trim(), avatar });
      setMe(r); onDone();
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  }
  const ok = displayName.trim().length > 0 && check.state === 'ok';
  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={[s.body, { flexGrow: 1 }]} keyboardShouldPersistTaps="handled">
        <Tap testID="avatar" accessibilityLabel="Change photo" style={{ alignSelf: 'center' }} onPress={async () => { const a = await pickAvatar(); if (a) setAvatar(a); }}>
          <Avatar name={displayName || '?'} size={90} uri={avatar} />
          <View style={{ position: 'absolute', right: -4, bottom: 0, backgroundColor: C.gold, borderRadius: 16, padding: 6 }}><Icon name="cam" size={16} color="#000" /></View>
        </Tap>
        {avatar ? <Tap onPress={() => setAvatar(null)} style={{ alignSelf: 'center' }}><T mu size={12}>Remove photo</T></Tap> : null}
        <Label>Display name</Label>
        <Input testID="displayName" value={displayName} onChangeText={setName} placeholder="Sophie Marlowe" textContentType="name" />
        <Label>Username</Label>
        <Input testID="username" value={username} onChangeText={t => setUsername(t.replace(/\s/g, ''))} autoCapitalize="none" autoCorrect={false} placeholder="sophie.sm"
          left={<T gold weight="700">@</T>}
          right={check.state === 'checking' ? <Spinner size={16} /> : check.state === 'ok' ? <Icon name="check" size={18} color={C.green} /> : check.state === 'bad' ? <Icon name="x" size={18} color={C.red} /> : null} />
        <T size={12} style={{ color: check.state === 'bad' ? '#ff8a9a' : C.green, minHeight: 14 }} testID="username-msg">{check.msg ?? ''}</T>
        <Label>Role · Department</Label>
        <Input testID="role" value={role} onChangeText={setRole} placeholder="Stage Manager" />
        <Input testID="department" value={department} onChangeText={setDept} placeholder="Stage Management" />
        <ErrorText>{err}</ErrorText>
        <View style={{ flex: 1 }} />
        <Button testID="pcont" title={cta} disabled={!ok} loading={busy} onPress={save} />
        {editing ? null : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

export default function Profile() {
  return (
    <SafeAreaView style={s.screen} edges={['top', 'bottom']}>
      <Header title="Create your work profile" subtitle="Step 2 of 5" back={false} />
      <ProfileForm cta="Continue" onDone={() => router.push('/identity')} />
    </SafeAreaView>
  );
}
