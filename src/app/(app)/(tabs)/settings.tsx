import React from 'react';
import { View, ScrollView, Alert } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { C } from '../../../theme';
import { T, Card, Row, Avatar, Tap, Label, Pill, s } from '../../../components/ui';
import { Icon, IconName } from '../../../components/Icon';
import { signOut } from '../../../lib/engine';
import { useApp } from '../../../store/app';

function Item({ icon, title, sub, onPress, testID, danger }: { icon: IconName; title: string; sub?: string; onPress: () => void; testID: string; danger?: boolean }) {
  return (
    <Tap testID={testID} onPress={onPress} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: C.border }}>
      <Icon name={icon} size={20} color={danger ? C.red : C.gold} />
      <View style={{ flex: 1 }}><T size={15} style={danger ? { color: C.red } : undefined}>{title}</T>{sub ? <T mu size={12}>{sub}</T> : null}</View>
      {!danger ? <T mu>›</T> : null}
    </Tap>);
}
export default function Settings() {
  const me = useApp(st => st.me)!;
  return (
    <SafeAreaView style={s.screen} edges={['top']}>
      <ScrollView contentContainerStyle={s.body}>
        <T serif size={30}>Settings</T>
        <Card testID="editprofile" onPress={() => router.push('/edit-profile')}>
          <Row><Avatar name={me.displayName ?? '?'} uri={me.avatar} size={56} />
            <View style={{ flex: 1 }}><T weight="700" size={17}>{me.displayName}</T><T mu size={13}>@{me.username}{me.role ? ` · ${me.role}` : ''}</T></View>
            <Pill>{me.plan === 'free' ? 'CREW' : me.plan.toUpperCase()}</Pill></Row>
        </Card>
        <Label>Work</Label>
        <View>
          <Item testID="st-hours" icon="clock" title="Working hours" sub={`${me.shift.start}–${me.shift.end} · ${me.timezone}`} onPress={() => router.push('/hours-settings')} />
          <Item testID="st-plan" icon="star" title="Subscription" sub={me.plan === 'free' ? 'Crew · free' : `${me.plan}${me.planStatus ? ` · ${me.planStatus}` : ''}`} onPress={() => router.push(me.plan === 'free' ? '/paywall' : '/plan')} />
          <Item testID="st-qr" icon="qr" title="My QR code" onPress={() => router.push('/myqr')} />
        </View>
        <Label>Privacy & safety</Label>
        <View>
          <Item testID="st-privacy" icon="shield" title="Privacy & encryption" onPress={() => router.push('/privacy')} />
          <Item testID="st-blocked" icon="block" title="Blocked people" onPress={() => router.push('/blocked')} />
          <Item testID="st-support" icon="help" title="Help & support" onPress={() => router.push('/support')} />
        </View>
        <Item testID="signout" icon="logout" title="Sign out" danger onPress={() => Alert.alert('Sign out?', 'Your messages stay encrypted on this phone until you sign in again.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Sign out', style: 'destructive', onPress: () => signOut() }])} />
      </ScrollView>
    </SafeAreaView>
  );
}
