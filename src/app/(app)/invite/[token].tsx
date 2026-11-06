import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { C } from '../../../theme';
import { T, Header, Avatar, Row, Card, Button, Spinner, ErrorText, s, Screen} from '../../../components/ui';
import { Icon } from '../../../components/Icon';
import { api, errMsg } from '../../../lib/api';
import { openDirect, refreshAll } from '../../../lib/engine';
import type { PublicUser } from '../../../lib/types';

type Inv = { kind: 'contact' | 'workspace'; user: PublicUser; self: boolean; workspace: { id: string; name: string; initial: string; memberCount: number } | null };
export default function Invite() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const [inv, setInv] = useState<Inv | null>(null); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  useEffect(() => { api<Inv>('POST', '/invites/resolve', { token }).then(setInv).catch(e => setErr(errMsg(e))); }, [token]);
  const accept = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api('POST', '/invites/accept', { token });
      if (r.kind === 'workspace') { await refreshAll(); router.replace(`/workspace/${r.workspaceId}`); }
      else router.replace(`/chat/${await openDirect(inv!.user.id)}`);
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Screen style={s.screen} edges={['top', 'bottom']}>
      <Header title={inv?.kind === 'workspace' ? 'Join workspace' : 'Add contact'} />
      <View style={[s.body, { justifyContent: 'flex-end' }]}>
        {!inv && !err ? <Spinner /> : null}
        {inv ? <Card testID="scard">
          <Row>
            {inv.workspace ? <Avatar name={inv.workspace.initial} bg={C.gold} size={48} /> : <Avatar name={inv.user.displayName ?? ''} uri={inv.user.avatar} size={48} />}
            <View style={{ flex: 1 }}>
              <T weight="700">{inv.workspace ? inv.workspace.name : inv.user.displayName}</T>
              <T mu size={13}>{inv.workspace ? `${inv.workspace.memberCount} members · invited by ${inv.user.displayName}` : `@${inv.user.username}${inv.user.role ? ` · ${inv.user.role}` : ''}`}</T>
            </View>
            <Icon name="check" size={22} color={C.green} />
          </Row>
          {inv.self ? <T mu style={{ marginTop: 10 }}>That’s your own code.</T> :
            <Button testID="addpriya" title={inv.kind === 'workspace' ? 'Join workspace' : 'Add contact'} loading={busy} style={{ marginTop: 12 }} onPress={accept} />}
        </Card> : null}
        <ErrorText>{err}</ErrorText>
      </View>
    </Screen>
  );
}
