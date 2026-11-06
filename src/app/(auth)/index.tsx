import React from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { C } from '../../theme';
import { T, Button } from '../../components/ui';
import { Icon } from '../../components/Icon';

export default function Welcome() {
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <LinearGradient colors={['#3a1420', '#0B0A0C']} style={{ position: 'absolute', top: 0, left: 0, right: 0, height: '60%' }} />
      <SafeAreaView style={{ flex: 1, paddingHorizontal: 26, paddingBottom: 20 }}>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 18 }}>
          <View style={{ width: 96, height: 96, borderRadius: 48, backgroundColor: C.gold, alignItems: 'center', justifyContent: 'center', shadowColor: C.gold, shadowOpacity: 0.55, shadowRadius: 28, shadowOffset: { width: 0, height: 12 } }}>
            <Icon name="chat" size={46} color={C.goldText} />
          </View>
          <T serif size={42}>Understage</T>
          <T mu size={16} style={{ textAlign: 'center' }}>Work chat for the people{'\n'}who make the show happen.</T>
        </View>
        <Button testID="getstarted" title="Get started" onPress={() => router.push({ pathname: '/verify', params: { mode: 'new' } })} />
        <Button testID="signin" title="I already have an account" variant="secondary" style={{ marginTop: 12 }} onPress={() => router.push({ pathname: '/verify', params: { mode: 'signin' } })} />
      </SafeAreaView>
    </View>
  );
}
