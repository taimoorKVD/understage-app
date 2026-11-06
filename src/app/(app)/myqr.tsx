import React, { useEffect, useState } from 'react';
import { View, Share } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { T, Header, Avatar, Pill, Button, Spinner, ErrorText, s, Screen} from '../../components/ui';
import { api, errMsg } from '../../lib/api';
import { useApp } from '../../store/app';

export default function MyQr() {
  const me = useApp(st => st.me)!;
  const [inv, setInv] = useState<{ url: string; expiresAt: number } | null>(null); const [err, setErr] = useState<string | null>(null);
  const fetchInvite = () => api('POST', '/invites/regenerate', { kind: 'contact', ttlSec: 7 * 86400 }).then(setInv).catch(e => setErr(errMsg(e)));
  const make = () => { setErr(null); fetchInvite(); };
  useEffect(() => { fetchInvite(); }, []); // create one invite on mount
  return (
    <Screen style={s.screen} edges={['top', 'bottom']}>
      <Header title="My QR code" />
      <View style={[s.body, { alignItems: 'center', justifyContent: 'center', gap: 18 }]}>
        <View style={{ backgroundColor: '#fff', padding: 22, borderRadius: 24, width: 274, height: 274, alignItems: 'center', justifyContent: 'center' }} testID="qr">
          {inv ? <QRCode value={inv.url} size={230} ecl="H" /> : <Spinner />}
          {inv ? <View style={{ position: 'absolute', backgroundColor: '#fff', padding: 6, borderRadius: 12 }}><Avatar name={me.displayName ?? ''} uri={me.avatar} size={44} /></View> : null}
        </View>
        <T weight="700" size={20}>{me.displayName}</T>
        <T mu>@{me.username}{me.role ? ` · ${me.role}` : ''}</T>
        <Pill icon="lock">Phone number hidden</Pill>
        <ErrorText>{err}</ErrorText>
        {inv ? <T mu size={12}>Code expires {new Date(inv.expiresAt).toLocaleDateString('en-GB')}</T> : null}
        <Button testID="shareqr" title="Share invite link" variant="secondary" disabled={!inv} onPress={() => inv && Share.share({ message: `Add me on Understage: ${inv.url}` })} />
        <Button testID="newqr" title="Generate new code" variant="secondary" onPress={make} />
      </View>
    </Screen>
  );
}
