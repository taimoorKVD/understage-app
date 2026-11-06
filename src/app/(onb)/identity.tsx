import React from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { C } from '../../theme';
import { T, Button, Header, Label, Pill, Avatar, Row, s, Screen} from '../../components/ui';
import { Icon } from '../../components/Icon';
import { useApp } from '../../store/app';

export default function Identity() {
  const me = useApp(st => st.me)!;
  const rows: [string, string, string][] = [['Work name & role', 'Visible', C.green], ['Working-hours status', 'Visible', C.green], ['Phone number / email', 'Never', C.red], ['Personal contacts', 'Never', C.red], ['Location', 'Never', C.red]];
  return (
    <Screen style={s.screen} edges={['top', 'bottom']}>
      <Header title="Your work identity" subtitle="Step 3 of 5" />
      <View style={s.body}>
        <LinearGradient colors={[C.goldCard, C.card]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ borderRadius: 18, borderWidth: 1, borderColor: C.gold, padding: 14 }}>
          <Row>
            <Avatar name={me.displayName ?? '?'} uri={me.avatar} size={54} />
            <View style={{ flex: 1 }}><T weight="700" size={17}>{me.displayName}</T><T mu size={13}>@{me.username}{me.role ? ` · ${me.role}` : ''}</T></View>
            <Pill>WORK</Pill>
          </Row>
        </LinearGradient>
        <View style={{ opacity: 0.55, backgroundColor: C.card, borderRadius: 18, borderWidth: 1, borderColor: C.border, padding: 14 }}>
          <Row>
            <View style={{ width: 54, height: 54, borderRadius: 27, backgroundColor: C.track, alignItems: 'center', justifyContent: 'center' }}><Icon name="lock" size={24} color={C.text} /></View>
            <View style={{ flex: 1 }}><T weight="700">Personal life</T><T mu size={13}>Not connected to Understage</T></View>
            <Pill bg={C.track} color={C.muted}>PRIVATE</Pill>
          </Row>
        </View>
        <Label style={{ marginTop: 6 }}>What colleagues can see</Label>
        {rows.map(([a, b, c]) => <Row key={a} style={{ justifyContent: 'space-between' }}><T size={14}>{a}</T><T size={14} weight="600" style={{ color: c }}>{b}</T></Row>)}
        <View style={{ flex: 1 }} />
        <Button testID="icont" title="Continue" onPress={() => router.push('/hours')} />
      </View>
    </Screen>
  );
}
