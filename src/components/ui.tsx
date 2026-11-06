import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View, Modal, type PressableProps, type StyleProp, type TextInputProps, type TextStyle, type ViewStyle, Animated, Easing, Image } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Circle } from 'react-native-svg';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { SafeAreaView, type SafeAreaViewProps } from 'react-native-safe-area-context';
import { CurtainBg } from './CurtainBg';
import { C, F, AVC, R, G } from '../theme';
import { Icon, type IconName } from './Icon';

export function T({ style, serif, mu, gold, size, weight, children, ...p }: React.ComponentProps<typeof Text> & { serif?: boolean; mu?: boolean; gold?: boolean; size?: number; weight?: '400' | '500' | '600' | '700' | '800' | '300' }) {
  const ff = serif ? (weight === '700' || weight === '800' ? F.serifBold : F.serif) : weight === '700' ? F.bold : weight === '600' ? F.semibold : weight === '800' ? F.heavy : weight === '500' ? F.medium : weight === '300' ? F.light : F.regular;
  return <Text {...p} style={[{ color: mu ? C.muted : gold ? C.gold : C.text, fontFamily: ff, fontSize: size ?? 15 }, style]}>{children}</Text>;
}

/** Pressable with the prototype's .tp:active{transform:scale(.97)} feedback. */
export function Tap({ style, children, haptic, ...p }: PressableProps & { style?: StyleProp<ViewStyle>; haptic?: boolean; children?: React.ReactNode }) {
  return (
    <Pressable {...p} onPress={e => { if (haptic) Haptics.selectionAsync().catch(() => {}); p.onPress?.(e); }}
      style={({ pressed }) => [style as ViewStyle, pressed && !p.disabled ? { transform: [{ scale: 0.97 }], opacity: 0.92 } : null]}>
      {children}
    </Pressable>
  );
}

export function Button({ title, onPress, variant = 'primary', disabled, loading, style, icon, testID, textStyle }: { title: string; onPress?: () => void; variant?: 'primary' | 'secondary' | 'danger' | 'success'; disabled?: boolean; loading?: boolean; style?: StyleProp<ViewStyle>; icon?: IconName; testID?: string; textStyle?: StyleProp<TextStyle> }) {
  const bg = variant === 'primary' ? 'transparent' : variant === 'danger' ? C.red : C.input;
  const fg = variant === 'primary' ? C.goldText : variant === 'success' ? C.green : C.text;
  return (
    <Tap testID={testID} accessibilityRole="button" accessibilityLabel={title} disabled={disabled || loading} onPress={onPress} haptic
      style={[s.btn, { backgroundColor: bg, opacity: disabled ? 0.4 : 1, overflow: 'hidden' }, variant === 'secondary' && s.btn2, variant === 'success' && { borderWidth: 1, borderColor: C.green }, style]}>
      {variant === 'primary' ? <LinearGradient colors={[...G.gold]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} /> : null}
      {loading ? <ActivityIndicator color={variant === 'primary' ? C.goldText : C.gold} /> : (
        <View style={s.row}>{icon ? <Icon name={icon} size={18} color={fg} /> : null}<T weight={variant === 'secondary' ? '600' : '700'} size={variant === 'secondary' ? 15 : 16} style={[{ color: fg, textAlign: 'center' }, textStyle]}>{title}</T></View>
      )}
    </Tap>
  );
}
export const GoldButton = Button;

export function Card({ style, children, onPress, testID }: { style?: StyleProp<ViewStyle>; children?: React.ReactNode; onPress?: () => void; testID?: string }) {
  if (onPress) return <Tap testID={testID} onPress={onPress} style={[s.card, style]}>{children}</Tap>;
  return <View testID={testID} style={[s.card, style]}>{children}</View>;
}
export const GlassCard = Card;

export function Input({ style, left, right, containerStyle, ...p }: TextInputProps & { left?: React.ReactNode; right?: React.ReactNode; containerStyle?: StyleProp<ViewStyle> }) {
  const [focus, setFocus] = React.useState(false);
  return (
    <View style={[s.inp, focus && { borderColor: C.gold }, containerStyle]}>
      {left}
      <TextInput placeholderTextColor={C.muted} selectionColor={C.gold} keyboardAppearance="dark" {...p}
        onFocus={e => { setFocus(true); p.onFocus?.(e); }} onBlur={e => { setFocus(false); p.onBlur?.(e); }}
        style={[{ flex: 1, color: C.text, fontFamily: F.regular, fontSize: 15, padding: 0 }, style]} />
      {right}
    </View>
  );
}

export function SearchField(props: TextInputProps & { containerStyle?: StyleProp<ViewStyle> }) {
  return <Input left={<Icon name="search" size={16} color={C.muted} />} placeholder={props.placeholder ?? 'Search'} containerStyle={[{ borderRadius: 22, paddingVertical: 10 }, props.containerStyle]} {...props} />;
}

export const Label = ({ children, style }: { children: React.ReactNode; style?: StyleProp<TextStyle> }) => <T weight="600" size={12} gold style={[{ textTransform: 'uppercase', letterSpacing: 1.5 }, style]}>{children}</T>;

export function Badge({ count, style }: { count?: number; style?: StyleProp<ViewStyle> }) {
  if (!count) return null;
  return (
    <View style={[{ minWidth: 18, height: 18, paddingHorizontal: 5, borderRadius: 9, backgroundColor: C.gold, alignItems: 'center', justifyContent: 'center' }, style]}>
      <T size={10} weight="800" style={{ color: C.goldText }}>{count > 99 ? '99+' : count}</T>
    </View>
  );
}

export function Pill({ children, icon, color = C.gold, bg = C.pill, style, testID }: { children: React.ReactNode; icon?: IconName; color?: string; bg?: string; style?: StyleProp<ViewStyle>; testID?: string }) {
  return <View testID={testID} style={[s.pill, { backgroundColor: bg }, style]}>{icon ? <Icon name={icon} size={11} color={color} /> : null}<T weight="600" size={11} style={{ color }}>{children}</T></View>;
}

export function Toggle({ value, onChange, disabled, testID }: { value: boolean; onChange?: (v: boolean) => void; disabled?: boolean; testID?: string }) {
  const [a] = useState(() => new Animated.Value(value ? 1 : 0));
  useEffect(() => { Animated.timing(a, { toValue: value ? 1 : 0, duration: 180, easing: Easing.out(Easing.quad), useNativeDriver: false }).start(); }, [value, a]);
  return (
    <Pressable testID={testID} accessibilityRole="switch" accessibilityState={{ checked: value, disabled }} disabled={disabled} onPress={() => { Haptics.selectionAsync().catch(() => {}); onChange?.(!value); }}
      style={{ opacity: disabled ? 0.7 : 1 }}>
      <Animated.View style={[s.tog, { backgroundColor: a.interpolate({ inputRange: [0, 1], outputRange: [C.border2, C.green] }) }]}>
        <Animated.View style={[s.knob, { left: a.interpolate({ inputRange: [0, 1], outputRange: [3, 21] }) }]} />
      </Animated.View>
    </Pressable>
  );
}

export function initials(n: string) { return n.replace(/[^A-Za-z ]/g, '').split(' ').filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?'; }
export function avatarColor(n: string) { let h = 0; for (const c of n) h += c.charCodeAt(0); return AVC[h % 7]; }
export function Avatar({ name, size = 40, style, bg, uri, ring }: { name: string; size?: number; style?: StyleProp<ViewStyle>; bg?: string; uri?: string | null; ring?: boolean }) {
  const inner = uri
    ? <Image source={{ uri }} style={[{ width: size, height: size, borderRadius: size / 2, backgroundColor: C.input }, style as any]} />
    : <View style={[{ width: size, height: size, borderRadius: size / 2, backgroundColor: bg ?? avatarColor(name), alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth, borderColor: C.border2 }, style]}>
        <T weight="700" size={size * 0.38} style={{ color: '#fff' }}>{initials(name)}</T>
      </View>;
  if (!ring) return inner;
  return <View style={{ padding: 2, borderRadius: (size + 8) / 2, borderWidth: 1.5, borderColor: C.gold }}>{inner}</View>;
}

export function Header({ title, subtitle, back = true, right, onBack, avatar, testID }: { title: string; subtitle?: React.ReactNode; back?: boolean; right?: React.ReactNode; onBack?: () => void; avatar?: string; testID?: string }) {
  return (
    <View style={s.hdr} testID={testID}>
      {back ? <Tap testID="back" accessibilityLabel="Back" onPress={onBack ?? (() => (router.canGoBack() ? router.back() : router.replace('/')))} style={{ padding: 4 }}><Icon name="back" size={24} /></Tap> : null}
      {avatar ? <Avatar name={avatar} size={38} /> : null}
      <View style={{ flex: 1, minWidth: 0 }}>
        <T serif size={20} numberOfLines={1}>{title}</T>
        {subtitle ? (typeof subtitle === 'string' ? <T size={12} mu numberOfLines={1}>{subtitle}</T> : subtitle) : null}
      </View>
      {right}
    </View>
  );
}

export function Bar({ pct, style }: { pct: number; style?: StyleProp<ViewStyle> }) {
  return <View style={[s.bar, style]}><View style={{ width: `${Math.max(0, Math.min(100, pct))}%`, height: '100%', backgroundColor: C.gold }} /></View>;
}

export function ProgressRing({ pct, size = 168, stroke = 10, children }: { pct: number; size?: number; stroke?: number; children?: React.ReactNode }) {
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(100, pct));
  const dash = (p / 100) * circ;
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={size} height={size} style={{ position: 'absolute' }}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={C.track} strokeWidth={stroke} fill="none" />
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={C.gold} strokeWidth={stroke} fill="none" strokeDasharray={`${dash} ${circ}`} strokeLinecap="round" transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      </Svg>
      <View style={{ alignItems: 'center' }}>{children}</View>
    </View>
  );
}

export function Spinner({ size = 22 }: { size?: number }) {
  const [r] = useState(() => new Animated.Value(0));
  useEffect(() => { const l = Animated.loop(Animated.timing(r, { toValue: 1, duration: 800, easing: Easing.linear, useNativeDriver: true })); l.start(); return () => l.stop(); }, [r]);
  return <Animated.View style={{ width: size, height: size, borderRadius: size / 2, borderWidth: Math.max(2, size / 8), borderColor: '#444', borderTopColor: C.gold, transform: [{ rotate: r.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] }) }] }} />;
}

export function Row({ style, children, gap = 10, testID }: { style?: StyleProp<ViewStyle>; children?: React.ReactNode; gap?: number; testID?: string }) {
  return <View testID={testID} style={[{ flexDirection: 'row', alignItems: 'center', gap }, style]}>{children}</View>;
}

export function Empty({ icon, title, body, action }: { icon: IconName; title: string; body?: string; action?: React.ReactNode }) {
  return (
    <View style={{ alignItems: 'center', paddingVertical: 40, gap: 10, paddingHorizontal: 20 }}>
      <Icon name={icon} size={36} color={C.gold} />
      <T serif size={20} style={{ textAlign: 'center' }}>{title}</T>
      {body ? <T mu size={13} style={{ textAlign: 'center', lineHeight: 19 }}>{body}</T> : null}
      {action}
    </View>
  );
}
export const EmptyState = Empty;

export function Skeleton({ width = '100%', height = 16, style }: { width?: number | string; height?: number; style?: StyleProp<ViewStyle> }) {
  const [on, setOn] = useState(true);
  useEffect(() => { const i = setInterval(() => setOn(v => !v), 700); return () => clearInterval(i); }, []);
  return <View style={[{ width: width as number, height, borderRadius: 8, backgroundColor: on ? '#2a2230' : '#221c28' }, style]} />;
}

export function ConfirmDialog({ visible, title, body, confirm = 'Confirm', cancel = 'Cancel', danger, busy, onConfirm, onClose, testID }: {
  visible: boolean; title: string; body?: string; confirm?: string; cancel?: string; danger?: boolean; busy?: boolean; onConfirm: () => void; onClose: () => void; testID?: string;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: 'rgba(8,6,10,0.72)', justifyContent: 'center', padding: 28 }}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <View style={[s.card, { padding: 22 }]}>
          <T serif size={24}>{title}</T>
          {body ? <T mu size={14} style={{ marginTop: 10, lineHeight: 21 }}>{body}</T> : null}
          <Row style={{ marginTop: 22 }} gap={10}>
            <Button title={cancel} variant="secondary" style={{ flex: 1 }} onPress={onClose} />
            <Button testID={testID} title={confirm} variant={danger ? 'danger' : 'primary'} loading={busy} style={{ flex: 1 }} onPress={onConfirm} />
          </Row>
        </View>
      </View>
    </Modal>
  );
}

export function ErrorText({ children }: { children?: React.ReactNode }) {
  if (!children) return null;
  return <T size={13} style={{ color: '#ff8a9a' }}>{children}</T>;
}


export function Screen({ children, style, ...rest }: SafeAreaViewProps) {
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <CurtainBg />
      <SafeAreaView {...rest} style={[{ flex: 1, backgroundColor: 'transparent' }, style]}>{children}</SafeAreaView>
    </View>
  );
}

export const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, justifyContent: 'center' },
  btn: { paddingVertical: 16, paddingHorizontal: 16, borderRadius: R.btn, alignItems: 'center', justifyContent: 'center', minHeight: 54 },
  btn2: { borderWidth: 1, borderColor: C.border2, paddingVertical: 15 },
  card: { backgroundColor: C.glass, borderWidth: 1, borderColor: C.border, borderRadius: R.card, padding: 14 },
  inp: { backgroundColor: C.input, borderWidth: 1, borderColor: C.border2, borderRadius: R.inp, paddingVertical: 14, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 10 },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 4, paddingHorizontal: 9, borderRadius: R.pill, alignSelf: 'flex-start' },
  tog: { width: 46, height: 28, borderRadius: 14 },
  knob: { position: 'absolute', top: 3, width: 22, height: 22, borderRadius: 11, backgroundColor: '#fff' },
  hdr: { flexDirection: 'row', alignItems: 'center', gap: 12, marginHorizontal: 12, marginTop: 6, marginBottom: 8, paddingTop: 10, paddingBottom: 10, paddingHorizontal: 12, borderRadius: 22, backgroundColor: C.glass, borderWidth: 1, borderColor: C.border },
  bar: { height: 8, borderRadius: 4, backgroundColor: C.track, overflow: 'hidden' },
  body: { flex: 1, paddingHorizontal: 18, paddingVertical: 16, gap: 12 },
  screen: { flex: 1, backgroundColor: 'transparent' },
});
