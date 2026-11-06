import React, { useEffect, useMemo, useState } from 'react';
import { View, Modal, Pressable, StyleSheet } from 'react-native';
import Animated, { FadeIn, FadeOut, ZoomIn, useAnimatedStyle, useSharedValue, withRepeat, withSequence, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, useGlobalSearchParams } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { C, G } from '../theme';
import { T, Tap, Avatar, Badge } from './ui';
import { Icon, IconName } from './Icon';
import { useApp } from '../store/app';
import { bus } from '../lib/events';

const TABS: { name: string; label: string; icon: IconName; testID: string }[] = [
  { name: 'index', label: 'Chats', icon: 'chat', testID: 'tab-chats' },
  { name: 'workspace', label: 'Workspace', icon: 'users', testID: 'tab-workspace' },
  { name: 'calls', label: 'Calls', icon: 'phone', testID: 'tab-calls' },
  { name: 'settings', label: 'Settings', icon: 'gear', testID: 'tab-settings' },
];

type DockRoute = { key: string; name: string };
type DockProps = {
  state: { index: number; routes: DockRoute[] };
  navigateToTab: (routeKey: string) => void;
};

export function StageDock({ state, navigateToTab }: DockProps) {
  const ins = useSafeAreaInsets();
  const [open, setOpen] = useState(false);
  const [dismissedOrb, setDismissedOrb] = useState(false);
  const params = useGlobalSearchParams<{ orb?: string | string[] }>();
  const orbParam = Array.isArray(params.orb) ? params.orb[0] : params.orb;
  const wantOrb = orbParam === '1' || orbParam === 'true';
  const menuOpen = open || (wantOrb && !dismissedOrb);
  const closeMenu = () => { setOpen(false); if (wantOrb) setDismissedOrb(true); };
  useEffect(() => bus.on('dock:open', () => setOpen(true)), []);
  const workspaces = useApp(st => st.workspaces);
  const convs = useApp(st => st.conversations);
  const unread = useMemo(() => Object.values(convs).reduce((n, c) => n + (c.unread || 0), 0), [convs]);
  const adminWs = workspaces.filter(w => (w.myRole === 'owner' || w.myRole === 'admin') && !w.wrappedAt);
  const pulse = useSharedValue(1);
  useEffect(() => {
    pulse.value = withRepeat(withSequence(withTiming(1.06, { duration: 1400 }), withTiming(1, { duration: 1400 })), -1, false);
  }, [pulse]);
  const orbStyle = useAnimatedStyle(() => ({ transform: [{ scale: pulse.value }] }));

  const go = (name: string) => {
    const route = state.routes.find((r: DockRoute) => r.name === name);
    if (route) navigateToTab(route.key);
  };

  const actions: { key: string; label: string; icon: IconName; testID: string; run: () => void; hidden?: boolean; x: number; y: number }[] = [
    { key: 'add', label: 'New chat', icon: 'plus', testID: 'dock-add', run: () => router.push('/add'), x: -118, y: -118 },
    { key: 'scan', label: 'Scan QR', icon: 'qr', testID: 'dock-scan', run: () => router.push('/scan'), x: 118, y: -118 },
    { key: 'announce', label: 'Announce', icon: 'mega', testID: 'dock-announce', run: () => router.push(`/compose/${adminWs[0].id}`), hidden: !adminWs.length, x: -118, y: 8 },
    { key: 'call', label: 'Call', icon: 'phone', testID: 'dock-call', run: () => go('calls'), x: 118, y: 8 },
  ];
  const visible = actions.filter(a => !a.hidden);

  const closeAnd = (fn: () => void) => { closeMenu(); setTimeout(fn, 40); };

  return (
    <View pointerEvents="box-none" style={{ paddingBottom: Math.max(ins.bottom, 8) + 6, paddingHorizontal: 16, backgroundColor: 'transparent' }}>
      {!menuOpen ? (
        <LinearGradient colors={[...G.dock]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={ds.pill}>
          <DockTab tab={TABS[0]} focused={state.index === state.routes.findIndex((r: DockRoute) => r.name === 'index')} onPress={() => go('index')} badge={unread} />
          <DockTab tab={TABS[1]} focused={state.index === state.routes.findIndex((r: DockRoute) => r.name === 'workspace')} onPress={() => go('workspace')} />
          <Tap testID="dock-orb" accessibilityLabel="Stage menu" onPress={() => setOpen(true)} style={ds.orbHit}>
            <Animated.View style={orbStyle}>
              <View style={ds.orbGlow}>
                <LinearGradient colors={[...G.gold]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={ds.orb} />
              </View>
            </Animated.View>
          </Tap>
          <DockTab tab={TABS[2]} focused={state.index === state.routes.findIndex((r: DockRoute) => r.name === 'calls')} onPress={() => go('calls')} />
          <DockTab tab={TABS[3]} focused={state.index === state.routes.findIndex((r: DockRoute) => r.name === 'settings')} onPress={() => go('settings')} />
        </LinearGradient>
      ) : <View style={{ height: 68 }} />}

      <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={closeMenu}>
        <View style={{ flex: 1, backgroundColor: 'rgba(8,6,10,0.92)' }}>
          <Pressable style={StyleSheet.absoluteFill} onPress={closeMenu} testID="dock-dismiss" />
          <View pointerEvents="box-none" style={{ flex: 1, paddingTop: ins.top + 16, paddingHorizontal: 18 }}>
            {workspaces.length ? (
              <Animated.View entering={FadeIn.duration(220)} exiting={FadeOut} style={{ gap: 10 }}>
                <T size={11} weight="600" gold style={{ letterSpacing: 1.6, textTransform: 'uppercase' }}>Switch workspace</T>
                {workspaces.slice(0, 6).map((w, i) => (
                  <Tap key={w.id} testID={`dock-ws-${w.id}`} onPress={() => closeAnd(() => router.push(`/workspace/${w.id}`))}
                    style={[ds.wsCard, i === 0 && { borderColor: C.border2 }]}>
                    <Avatar name={w.initial} size={i === 0 ? 46 : 36} bg={C.gold} />
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <T serif size={i === 0 ? 20 : 16} numberOfLines={1}>{w.name}</T>
                      <T mu size={12} numberOfLines={1}>{w.memberCount} members{w.venue ? ` · ${w.venue}` : ''}{w.runLabel ? ` · ${w.runLabel}` : ''}</T>
                    </View>
                    {w.wrappedAt ? <T size={11} style={{ color: C.red }}>WRAPPED</T> : <T size={11} gold>{w.myRole.toUpperCase()}</T>}
                  </Tap>
                ))}
              </Animated.View>
            ) : null}
            <View style={{ flex: 1 }} />
            <View pointerEvents="box-none" style={{ height: 260 + Math.max(ins.bottom, 8), marginBottom: Math.max(ins.bottom, 8) + 8 }}>
              <View pointerEvents="box-none" style={{ position: 'absolute', left: '50%', bottom: 36, width: 0, height: 0 }}>
                {visible.map(a => (
                  <Animated.View key={a.key} entering={ZoomIn.springify().damping(16)} style={{ position: 'absolute', left: a.x - 46, top: a.y - 40, width: 92, alignItems: 'center' }}>
                    <Tap testID={a.testID} accessibilityLabel={a.label} onPress={() => closeAnd(a.run)} style={{ alignItems: 'center', gap: 6, width: 92 }}>
                      <View style={ds.actionBtn}><Icon name={a.icon} size={22} color={C.gold} /></View>
                      <T size={12} weight="600" style={{ textAlign: 'center' }}>{a.label}</T>
                    </Tap>
                  </Animated.View>
                ))}
                <Tap testID="dock-orb-close" accessibilityLabel="Close stage menu" onPress={closeMenu} style={{ position: 'absolute', left: -32, top: -32, width: 64, height: 64, alignItems: 'center', justifyContent: 'center' }}>
                  <View style={ds.orbGlow}>
                    <LinearGradient colors={[...G.gold]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={ds.orb} />
                  </View>
                </Tap>
              </View>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function DockTab({ tab, focused, onPress, badge }: { tab: typeof TABS[number]; focused: boolean; onPress: () => void; badge?: number }) {
  return (
    <Tap testID={tab.testID} accessibilityLabel={tab.label} onPress={onPress} style={ds.tab}>
      <View>
        <Icon name={tab.icon} size={22} color={focused ? C.gold : C.muted} />
        {tab.name === 'index' ? <Badge count={badge} style={{ position: 'absolute', top: -6, right: -10 }} /> : null}
      </View>
      <T size={10} weight={focused ? '700' : '500'} style={{ color: focused ? C.gold : C.muted, marginTop: 3 }}>{tab.label}</T>
    </Tap>
  );
}

const ds = StyleSheet.create({
  pill: {
    flexDirection: 'row', alignItems: 'center', borderRadius: 32, paddingHorizontal: 6, paddingVertical: 8,
    borderWidth: 1, borderColor: C.border2, overflow: 'hidden',
  },
  tab: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 4, minHeight: 52 },
  orbHit: { width: 64, height: 64, alignItems: 'center', justifyContent: 'center', marginTop: -18 },
  orbGlow: {
    width: 58, height: 58, borderRadius: 29, overflow: 'hidden', alignItems: 'center', justifyContent: 'center',
    shadowColor: C.gold, shadowOpacity: 0.7, shadowRadius: 16, shadowOffset: { width: 0, height: 0 },
    backgroundColor: 'rgba(216,178,106,0.2)',
  },
  orb: { width: 48, height: 48, borderRadius: 24, overflow: 'hidden' },
  action: { position: 'absolute', alignItems: 'center' },
  actionBtn: {
    width: 52, height: 52, borderRadius: 26, backgroundColor: C.glass,
    borderWidth: 1, borderColor: C.border2, alignItems: 'center', justifyContent: 'center',
  },
  wsCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: 18,
    backgroundColor: C.glass, borderWidth: 1, borderColor: C.border,
  },
});
