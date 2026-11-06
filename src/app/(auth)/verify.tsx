import React, { useEffect, useRef, useState } from 'react';
import { View, TextInput, KeyboardAvoidingView, Platform, Pressable } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { C, F } from '../../theme';
import { T, Button, Header, Input, Label, Card, Row, Tap, ErrorText, s, Screen} from '../../components/ui';
import { Icon } from '../../components/Icon';
import { api, errMsg } from '../../lib/api';
import { signedIn, finishOnboarding } from '../../lib/engine';
import { useApp } from '../../store/app';
import type { SelfUser } from '../../lib/types';

export default function Verify() {
  const { mode } = useLocalSearchParams<{ mode?: string }>();
  const [kind, setKind] = useState<'phone' | 'email'>('phone');
  const [cc, setCc] = useState('+44');
  const [value, setValue] = useState('');
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState('');
  const [devCode, setDevCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [left, setLeft] = useState(0);
  const codeRef = useRef<React.ComponentRef<typeof TextInput>>(null);
  // Guards against double submission (auto-submit on 6th digit + Verify tap, or OTP autofill firing twice).
  const inFlight = useRef(false);
  useEffect(() => { if (left <= 0) return; const t = setTimeout(() => setLeft(left - 1), 1000); return () => clearTimeout(t); }, [left]);

  const destination = kind === 'phone' ? `${cc}${value.replace(/[^\d]/g, '').replace(/^0/, '')}` : value.trim();
  const valid = kind === 'phone' ? value.replace(/\D/g, '').length >= 6 : /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.trim());

  async function sendCode() {
    setBusy(true); setErr(null);
    try {
      const r = await api<{ devCode?: string }>('POST', '/auth/otp/request', { kind, destination });
      setSent(true); setLeft(59); setDevCode(r.devCode ?? null); setCode('');
      setTimeout(() => codeRef.current?.focus(), 200);
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  }
  async function verify(c: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true); setErr(null);
    try {
      const r = await api<{ accessToken: string; refreshToken: string; user: SelfUser; isNew: boolean }>('POST', '/auth/otp/verify', { kind, destination, code: c });
      await signedIn(r, r.user);
      const id = useApp.getState().identity;
      if (r.user.profileComplete && id && id.publicKey === r.user.identityKey) await finishOnboarding();
      else useApp.setState({ status: 'onboarding' });
    } catch (e) { setErr(errMsg(e)); setCode(''); } finally { inFlight.current = false; setBusy(false); }
  }

  return (
    <Screen style={s.screen} edges={['top', 'bottom']}>
      <Header title={mode === 'signin' ? 'Sign in' : 'Verify your account'} subtitle={mode === 'signin' ? 'We will send you a code' : 'Step 1 of 5'} />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <View style={s.body}>
          <Row gap={8}>
            {(['phone', 'email'] as const).map(k => (
              <Button key={k} testID={`kind-${k}`} title={k === 'phone' ? 'Phone' : 'Email'} variant={kind === k ? 'primary' : 'secondary'} style={{ flex: 1, minHeight: 42, paddingVertical: 10 }} onPress={() => { setKind(k); setSent(false); setValue(''); setErr(null); }} />
            ))}
          </Row>
          <Label>{kind === 'phone' ? 'Mobile number' : 'Work email'}</Label>
          {kind === 'phone' ? (
            <Input testID="phone" value={value} onChangeText={setValue} keyboardType="phone-pad" textContentType="telephoneNumber" placeholder="7700 900001" editable={!sent || !busy}
              left={<TextInput testID="cc" value={cc} onChangeText={t => setCc('+' + t.replace(/[^\d]/g, '').slice(0, 4))} keyboardType="phone-pad" style={{ color: C.text, fontFamily: F.semibold, fontSize: 16, minWidth: 44 }} />} />
          ) : (
            <Input testID="email" value={value} onChangeText={setValue} keyboardType="email-address" autoCapitalize="none" autoCorrect={false} textContentType="emailAddress" placeholder="you@theatre.co.uk" />
          )}
          <Card style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
            <Icon name="lock" size={22} color={C.gold} />
            <T size={13} mu style={{ flex: 1 }}>Used for verification only. <T size={13} weight="700">Never visible</T> to other users.</T>
          </Card>
          {sent ? (
            <View style={{ gap: 10 }}>
              <Label>Enter the code we sent {kind === 'phone' ? 'by SMS' : 'by email'}</Label>
              <Pressable onPress={() => codeRef.current?.focus()} style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                {[0, 1, 2, 3, 4, 5].map(i => (
                  <View key={i} style={{ width: 46, height: 56, borderRadius: 12, borderWidth: 1, borderColor: code.length === i ? C.gold : C.border2, backgroundColor: C.input, alignItems: 'center', justifyContent: 'center' }}>
                    <T size={24} weight="700">{code[i] ?? ''}</T>
                  </View>
                ))}
              </Pressable>
              <TextInput ref={codeRef} testID="code" value={code} maxLength={6} keyboardType="number-pad" textContentType="oneTimeCode" autoComplete="one-time-code"
                onChangeText={t => { const c = t.replace(/\D/g, ''); setCode(c); if (c.length === 6) verify(c); }} style={{ position: 'absolute', opacity: 0, height: 1, width: 1 }} />
              {left > 0 ? <T mu size={13}>Resend code in 0:{String(left).padStart(2, '0')}</T> : <Tap testID="resend" onPress={sendCode}><T gold size={13} weight="600">Resend code</T></Tap>}
              {__DEV__ && devCode ? <T size={12} mu testID="devcode">Development server — code: {devCode}</T> : null}
            </View>
          ) : null}
          <ErrorText>{err}</ErrorText>
          <View style={{ flex: 1 }} />
          {!sent ? <Button testID="sendcode" title="Send code" disabled={!valid} loading={busy} onPress={sendCode} />
            : <Button testID="verify" title="Verify" disabled={code.length !== 6 || busy} loading={busy} onPress={() => verify(code)} />}
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}
