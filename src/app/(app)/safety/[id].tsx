import React, { useEffect, useState } from 'react';
import { View, ScrollView } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import QRCode from 'react-native-qrcode-svg';
import { C } from '../../../theme';
import { T, Header, Avatar, Row, Card, Button, Pill, Spinner, s } from '../../../components/ui';
import { Icon } from '../../../components/Icon';
import { useApp } from '../../../store/app';
import { api, errMsg } from '../../../lib/api';
import { conversationSafetyNumber } from '../../../lib/crypto';
import { otherMember } from '../../../lib/format';
import { fmtDate } from '../../../lib/time';
import type { PublicUser } from '../../../lib/types';

export default function Safety() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const me = useApp(st => st.me)!; const identity = useApp(st => st.identity); const conv = useApp(st => st.conversations[id]); const toast = useApp(st => st.showToast);
  const other = conv ? otherMember(conv, me.id) : undefined;
  const [peer, setPeer] = useState<(PublicUser & { isContact: boolean; verified: boolean }) | null>(null); const [busy, setBusy] = useState(false);
  useEffect(() => { if (other) api('GET', `/users/${other.id}`).then(setPeer).catch(e => toast(errMsg(e))); }, [other?.id]); // eslint-disable-line react-hooks/exhaustive-deps -- refetch only when the peer id changes
  if (!peer || !identity) return <SafeAreaView style={[s.screen, { alignItems: 'center', justifyContent: 'center' }]}><Spinner /></SafeAreaView>;
  const first = (peer.displayName || '').split(' ')[0];
  const num = conversationSafetyNumber(
    { id: me.id, publicKey: identity.publicKey, mlsSignaturePublicKey: me.mlsSignaturePublicKey },
    { id: peer.id, publicKey: peer.identityKey ?? '', mlsSignaturePublicKey: peer.mlsSignaturePublicKey },
  );
  const toggle = async () => {
    setBusy(true);
    try { if (!peer.isContact) await api('POST', '/contacts', { userId: peer.id }); await api('POST', `/contacts/${peer.id}/verify`, { verified: !peer.verified }); setPeer({ ...peer, isContact: true, verified: !peer.verified }); toast(peer.verified ? 'Verification removed' : `${first} is verified`); }
    catch (e) { toast(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <SafeAreaView style={s.screen} edges={['top', 'bottom']}>
      <Header title="Verify safety number" subtitle="End-to-end encryption" />
      <ScrollView contentContainerStyle={[s.body, { alignItems: 'center', gap: 14 }]}>
        <Row><Avatar name={me.displayName ?? ''} uri={me.avatar} size={56} /><Icon name="lock" size={22} color={C.gold} /><Avatar name={peer.displayName ?? ''} uri={peer.avatar} size={56} /></Row>
        <T weight="700">You and {peer.displayName}</T>
        {peer.verified ? <Pill testID="verified-pill" icon="check" bg={C.greenPill} color={C.green}>Verified</Pill> : null}
        {num ? <>
          <View style={{ backgroundColor: '#fff', padding: 14, borderRadius: 16 }}><QRCode value={`understage-safety:${num.join('')}`} size={150} /></View>
          <Card style={{ width: '100%' }} testID="safetynum">
            {[0, 4, 8].map(i => <T key={i} size={17} style={{ fontFamily: 'Courier', letterSpacing: 1, textAlign: 'center', lineHeight: 28 }}>{num.slice(i, i + 4).join(' ')}</T>)}
          </Card>
          <T mu size={13} style={{ textAlign: 'center' }}>Compare these numbers on both phones. If they match, nobody is listening in.{peer.keyUpdatedAt ? `\n${first}'s key last changed ${fmtDate(peer.keyUpdatedAt)}.` : ''}</T>
          <Button testID="verify" title={peer.verified ? 'Mark as unverified' : 'Mark as verified'} variant={peer.verified ? 'secondary' : 'primary'} loading={busy} style={{ width: '100%' }} onPress={toggle} />
        </> : <T mu>{first} hasn’t set up encryption keys yet.</T>}
      </ScrollView>
    </SafeAreaView>
  );
}
