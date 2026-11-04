import React, { useEffect } from 'react';
import { View } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useFonts, Inter_300Light, Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold, Inter_800ExtraBold } from '@expo-google-fonts/inter';
import { PlayfairDisplay_600SemiBold, PlayfairDisplay_700Bold } from '@expo-google-fonts/playfair-display';
import { C } from '../theme';
import { useApp } from '../store/app';
import { boot } from '../lib/engine';
import '../lib/calls';
import { useNotificationRouting } from '../lib/notifications';
import { ToastHost, BannerHost, CallOverlay, OffShiftOverlay, useShiftWatcher } from '../components/Overlays';
import { Spinner } from '../components/ui';

function Watchers() { useNotificationRouting(); useShiftWatcher(); return null; }

export default function Root() {
  const [fonts] = useFonts({ Inter_300Light, Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold, Inter_800ExtraBold, PlayfairDisplay_600SemiBold, PlayfairDisplay_700Bold });
  const status = useApp(s => s.status);
  useEffect(() => { boot().catch(e => { console.warn('boot', e); useApp.setState({ status: 'signedOut' }); }); }, []);
  const ready = fonts && status !== 'loading';
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: C.bg }}>
      <SafeAreaProvider>
        <StatusBar style="light" />
        {!ready ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: C.bg }}><Spinner /></View>
        ) : (
          <>
            <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: C.bg }, animation: 'slide_from_right' }}>
              <Stack.Protected guard={status === 'signedOut'}><Stack.Screen name="(auth)" /></Stack.Protected>
              <Stack.Protected guard={status === 'onboarding'}><Stack.Screen name="(onb)" /></Stack.Protected>
              <Stack.Protected guard={status === 'ready'}><Stack.Screen name="(app)" /></Stack.Protected>
            </Stack>
            {status === 'ready' ? <Watchers /> : null}
            <OffShiftOverlay />
            <CallOverlay />
            <BannerHost />
            <ToastHost />
          </>
        )}
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
