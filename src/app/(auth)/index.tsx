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
      <LinearGradient colors={['#4a1626', C.bg]} style={{ position: 'absolute', top: 0, left: 0, right: 0, height: '60%' }} />
      <SafeAreaView style={{ flex: 1, paddingHorizontal: 26, paddingBottom: 20 }}>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 18 }}>
          <View style={{ width: 96, height: 96, borderRadius: 26, backgroundColor: C.red, alignItems: 'center', justifyContent: 'center', shadowColor: C.red, shadowOpacity: 0.5, shadowRadius: 30, shadowOffset: { width: 0, height: 20 } }}>
            <Icon name="chat" size={50} color="#fff" />
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
