import React, { useEffect, useState } from 'react';
import { View, Modal } from 'react-native';
import Animated, { FadeInUp, FadeOutUp, FadeIn, FadeOut } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { C } from '../theme';
import { useApp } from '../store/app';
import { useCall, accept, decline, end, toggleMute, toggleSpeaker } from '../lib/calls';
import { dur, isOnShift, nextShiftLabel, tzAbbr } from '../lib/time';
import { T, Tap, Avatar, Button, Row } from './ui';
import { Icon } from './Icon';

export function ToastHost() {
  const t = useApp(s => s.toast);
  const ins = useSafeAreaInsets();
  if (!t) return null;
  return (
    <Animated.View key={t.id} entering={FadeIn} exiting={FadeOut} pointerEvents="none" style={{ position: 'absolute', bottom: ins.bottom + 90, left: 24, right: 24, alignItems: 'center', zIndex: 100 }}>
      <View testID="toast" style={{ backgroundColor: '#2a2230', borderColor: C.border2, borderWidth: 1, paddingVertical: 11, paddingHorizontal: 16, borderRadius: 14 }}>
        <T size={14} weight="500" style={{ textAlign: 'center' }}>{t.text}</T>
      </View>
    </Animated.View>
  );
}

export function BannerHost() {
  const b = useApp(s => s.banner);
  const ins = useSafeAreaInsets();
  if (!b) return null;
  return (
    <Animated.View key={b.id} entering={FadeInUp} exiting={FadeOutUp} style={{ position: 'absolute', top: ins.top + 6, left: 10, right: 10, zIndex: 90 }}>
      <Tap testID="banner" onPress={() => { useApp.setState({ banner: null }); b.onPress?.(); }} style={{ flexDirection: 'row', gap: 12, alignItems: 'center', backgroundColor: 'rgba(40,32,44,0.97)', borderRadius: 20, padding: 14, borderWidth: 1, borderColor: C.border2 }}>
        <View style={{ width: 38, height: 38, borderRadius: 10, backgroundColor: C.red, alignItems: 'center', justifyContent: 'center' }}><Icon name={b.icon ?? 'chat'} size={20} color="#fff" /></View>
        <View style={{ flex: 1 }}>
          <T weight="700" size={14}>{b.title}</T>
          <T size={13} mu numberOfLines={3}>{b.body}</T>
        </View>
      </Tap>
    </Animated.View>
  );
}

/** Full-screen call UI (incoming / outgoing / in-call / ended) — prototype screens 17–19. */
export function CallOverlay() {
  const c = useCall();
  const ins = useSafeAreaInsets();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { if (c.phase !== 'active') return; const i = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(i); }, [c.phase]);
  if (c.phase === 'idle') return null;
  const big = (icon: any, bg: string, label: string, onPress: () => void, testID: string, on?: boolean) => (
    <View style={{ alignItems: 'center', gap: 8 }}>
      <Tap testID={testID} accessibilityLabel={label} onPress={onPress} style={{ width: 70, height: 70, borderRadius: 35, backgroundColor: on ? C.text : bg, alignItems: 'center', justifyContent: 'center' }}>
        <Icon name={icon} size={28} color={on ? C.bg : '#fff'} />
      </Tap>
      <T size={12} mu>{label}</T>
    </View>
  );
  const status = c.phase === 'active' && c.answeredAt ? dur(Math.max(0, now - c.answeredAt) / 1000) : c.status;
  return (
    <Modal visible animationType="fade" presentationStyle="fullScreen">
      <View testID="call-overlay" style={{ flex: 1, backgroundColor: '#140c12', paddingTop: ins.top + 50, paddingBottom: ins.bottom + 40, alignItems: 'center' }}>
        <Row gap={6}><Icon name="lock" size={13} color={C.gold} /><T size={12} gold weight="600">End-to-end encrypted audio</T></Row>
        <Avatar name={c.peerName} size={120} style={{ marginTop: 40 }} />
        <T serif size={32} style={{ marginTop: 22 }}>{c.peerName}</T>
        <T mu size={15} style={{ marginTop: 6 }} testID="call-status">{status}</T>
        <View style={{ flex: 1 }} />
        {c.phase === 'incoming' ? (
          <Row gap={70}>{big('x', C.red, 'Decline', decline, 'call-decline')}{big('phone', C.green, 'Accept', accept, 'call-accept')}</Row>
        ) : c.phase === 'ended' ? null : (
          <View style={{ gap: 30, alignItems: 'center' }}>
            <Row gap={40}>{big('mic', '#2c2332', c.muted ? 'Unmute' : 'Mute', toggleMute, 'call-mute', c.muted)}{big('spk', '#2c2332', 'Speaker', toggleSpeaker, 'call-speaker', c.speaker)}</Row>
            {big('phone', C.red, 'End', () => end(), 'call-end')}
          </View>
        )}
      </View>
    </Modal>
  );
}

/** Off-shift screen (prototype 27_quiet): shown when the app opens outside working hours with quiet hours on. */
export function OffShiftOverlay() {
  const me = useApp(s => s.me), dismissed = useApp(s => s.offShiftDismissed), held = useApp(s => s.heldCount), status = useApp(s => s.status);
  const [, tick] = useState(0);
  useEffect(() => { const i = setInterval(() => tick(x => x + 1), 30_000); return () => clearInterval(i); }, []);
  if (status !== 'ready' || !me || dismissed || !me.quietHours || isOnShift(me.shift, me.timezone, true)) return null;
  return (
    <Modal visible animationType="fade" presentationStyle="fullScreen">
      <View testID="offshift" style={{ flex: 1, backgroundColor: '#0b0910', padding: 28, justifyContent: 'center', alignItems: 'center', gap: 16 }}>
        <View style={{ width: 110, height: 110, borderRadius: 55, backgroundColor: '#1d1726', alignItems: 'center', justifyContent: 'center' }}><Icon name="moon" size={54} color={C.violet} /></View>
        <T serif size={32}>You’re off shift</T>
        <T mu size={15} style={{ textAlign: 'center', lineHeight: 22 }}>Quiet hours are on. Messages and calls are held{'\n'}until your shift starts {nextShiftLabel(me.shift, me.timezone)} ({tzAbbr(me.timezone)}).</T>
        <View style={{ backgroundColor: '#1d1726', borderRadius: 16, paddingVertical: 12, paddingHorizontal: 18 }}><T size={14} style={{ color: C.violet }} weight="600">{held} held {held === 1 ? 'notification' : 'notifications'}</T></View>
        <Button testID="offshift-open" title="Open anyway" variant="secondary" style={{ alignSelf: 'stretch', marginTop: 20 }} onPress={() => useApp.setState({ offShiftDismissed: true })} />
        <Tap testID="offshift-hours" onPress={() => { useApp.setState({ offShiftDismissed: true }); router.push('/hours-settings'); }}><T gold weight="600">Change working hours</T></Tap>
      </View>
    </Modal>
  );
}

/** Morning summary (prototype "shiftstart"): when the shift begins, release held notifications and summarise them. */
export function useShiftWatcher() {
  const me = useApp(s => s.me), status = useApp(s => s.status);
  useEffect(() => {
    if (status !== 'ready' || !me) return;
    let wasOn: boolean | null = null, stopped = false;
    const check = async () => {
      const on = isOnShift(me.shift, me.timezone, me.quietHours);
      if (on && wasOn !== true) {
        try {
          const { refreshHeld } = await import('../lib/engine');
          const { api } = await import('../lib/api');
          const h = await refreshHeld();
          if (!stopped && h.onShift && h.count > 0) {
            await api('POST', '/me/held/release', {});
            const chats = h.groups.filter(g => g.conversationId).length;
            const anns = h.groups.filter(g => g.kind === 'announcement' || g.kind === 'reminder').reduce((n, g) => n + g.count, 0);
            const first = (me.displayName || '').split(' ')[0];
            useApp.getState().showBanner({ icon: 'clock', title: `Good ${new Date().getHours() < 12 ? 'morning' : 'day'}${first ? ', ' + first : ''} — your shift has started`,
              body: `${h.count} notification${h.count === 1 ? '' : 's'} from ${chats} chat${chats === 1 ? '' : 's'} were held.${anns ? ` ${anns} announcement${anns === 1 ? '' : 's'} need${anns === 1 ? 's' : ''} you.` : ''}` });
            useApp.setState({ heldCount: 0 });
          }
        } catch {}
      }
      wasOn = on;
    };
    check();
    const i = setInterval(check, 30_000);
    return () => { stopped = true; clearInterval(i); };
  }, [status, me?.shift.start, me?.shift.end, me?.timezone, me?.quietHours, me?.shift.days.join()]); // eslint-disable-line react-hooks/exhaustive-deps -- restart the shift watcher only when shift fields change, not on every new `me` object
}
