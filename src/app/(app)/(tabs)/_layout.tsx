import React from 'react';
import { Tabs } from 'expo-router';
import { C } from '../../../theme';
import { StageDock } from '../../../components/StageDock';

export default function TabsLayout() {
  return (
    <Tabs
      tabBar={props => <StageDock {...props} />}
      screenOptions={{
        headerShown: false,
        tabBarShowLabel: false,
        tabBarStyle: { position: 'absolute', backgroundColor: 'transparent', borderTopWidth: 0, elevation: 0 },
        sceneStyle: { backgroundColor: C.bg },
      }}>
      <Tabs.Screen name="index" options={{ title: 'Chats' }} />
      <Tabs.Screen name="workspace" options={{ title: 'Workspace' }} />
      <Tabs.Screen name="calls" options={{ title: 'Calls' }} />
      <Tabs.Screen name="settings" options={{ title: 'Settings' }} />
    </Tabs>
  );
}
