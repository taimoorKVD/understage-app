import { Tabs } from 'expo-router';
import { C, F } from '../../../theme';
import { Icon } from '../../../components/Icon';
import { useApp } from '../../../store/app';

export default function TabsLayout() {
  const unread = useApp(s => s.convOrder.reduce((n, id) => n + (s.conversations[id]?.unread ?? 0), 0));
  return (
    <Tabs screenOptions={{
      headerShown: false, tabBarActiveTintColor: C.gold, tabBarInactiveTintColor: C.muted,
      tabBarStyle: { backgroundColor: '#120e15', borderTopColor: C.border }, tabBarLabelStyle: { fontFamily: F.medium, fontSize: 11 },
      sceneStyle: { backgroundColor: C.bg },
    }}>
      <Tabs.Screen name="index" options={{ title: 'Chats', tabBarButtonTestID: 'tab-chats', tabBarBadge: unread || undefined, tabBarBadgeStyle: { backgroundColor: C.gold, color: '#000' }, tabBarIcon: ({ color }) => <Icon name="chat" size={22} color={color as string} /> }} />
      <Tabs.Screen name="workspace" options={{ title: 'Workspace', tabBarButtonTestID: 'tab-workspace', tabBarIcon: ({ color }) => <Icon name="users" size={22} color={color as string} /> }} />
      <Tabs.Screen name="calls" options={{ title: 'Calls', tabBarButtonTestID: 'tab-calls', tabBarIcon: ({ color }) => <Icon name="phone" size={22} color={color as string} /> }} />
      <Tabs.Screen name="settings" options={{ title: 'Settings', tabBarButtonTestID: 'tab-settings', tabBarIcon: ({ color }) => <Icon name="gear" size={22} color={color as string} /> }} />
    </Tabs>
  );
}
