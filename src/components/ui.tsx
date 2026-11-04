import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View, type PressableProps, type StyleProp, type TextInputProps, type TextStyle, type ViewStyle, Animated, Easing, Image } from 'react-native';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { C, F, AVC, R } from '../theme';
import { Icon, type IconName } from './Icon';

export function T({ style, serif, mu, gold, size, weight, children, ...p }: React.ComponentProps<typeof Text> & { serif?: boolean; mu?: boolean; gold?: boolean; size?: number; weight?: '400' | '500' | '600' | '700' | '800' | '300' }) {
  const ff = serif ? F.serif : weight === '700' ? F.bold : weight === '600' ? F.semibold : weight === '800' ? F.heavy : weight === '500' ? F.medium : weight === '300' ? F.light : F.regular;
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
  const bg = variant === 'primary' ? C.gold : variant === 'danger' ? C.red : C.input;
  const fg = variant === 'primary' ? C.goldText : variant === 'success' ? C.green : C.text;
  return (
    <Tap testID={testID} accessibilityRole="button" accessibilityLabel={title} disabled={disabled || loading} onPress={onPress} haptic
      style={[s.btn, { backgroundColor: bg, opacity: disabled ? 0.4 : 1 }, variant === 'secondary' && s.btn2, variant === 'success' && { borderWidth: 1, borderColor: C.green }, style]}>
      {loading ? <ActivityIndicator color={variant === 'primary' ? C.goldText : C.gold} /> : (
        <View style={s.row}>{icon ? <Icon name={icon} size={18} color={fg} /> : null}<T weight={variant === 'secondary' ? '600' : '700'} size={variant === 'secondary' ? 15 : 16} style={[{ color: fg, textAlign: 'center' }, textStyle]}>{title}</T></View>
      )}
    </Tap>
  );
}

export function Card({ style, children, onPress, testID }: { style?: StyleProp<ViewStyle>; children?: React.ReactNode; onPress?: () => void; testID?: string }) {
  if (onPress) return <Tap testID={testID} onPress={onPress} style={[s.card, style]}>{children}</Tap>;
  return <View testID={testID} style={[s.card, style]}>{children}</View>;
}

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

export const Label = ({ children, style }: { children: React.ReactNode; style?: StyleProp<TextStyle> }) => <T weight="600" size={12} mu style={[{ textTransform: 'uppercase', letterSpacing: 1.5 }, style]}>{children}</T>;

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
export function Avatar({ name, size = 40, style, bg, uri }: { name: string; size?: number; style?: StyleProp<ViewStyle>; bg?: string; uri?: string | null }) {
  if (uri) return <Image source={{ uri }} style={[{ width: size, height: size, borderRadius: size / 2, backgroundColor: C.input }, style as any]} />;
  return (
    <View style={[{ width: size, height: size, borderRadius: size / 2, backgroundColor: bg ?? avatarColor(name), alignItems: 'center', justifyContent: 'center' }, style]}>
      <T weight="700" size={size * 0.38} style={{ color: '#fff' }}>{initials(name)}</T>
    </View>
  );
}

export function Header({ title, subtitle, back = true, right, onBack, avatar, testID }: { title: string; subtitle?: React.ReactNode; back?: boolean; right?: React.ReactNode; onBack?: () => void; avatar?: string; testID?: string }) {
  return (
    <View style={s.hdr} testID={testID}>
      {back ? <Tap testID="back" accessibilityLabel="Back" onPress={onBack ?? (() => (router.canGoBack() ? router.back() : router.replace('/')))} style={{ padding: 4 }}><Icon name="back" size={24} /></Tap> : null}
      {avatar ? <Avatar name={avatar} size={38} /> : null}
      <View style={{ flex: 1, minWidth: 0 }}>
        <T weight="700" size={17} numberOfLines={1}>{title}</T>
        {subtitle ? (typeof subtitle === 'string' ? <T size={12} mu numberOfLines={1}>{subtitle}</T> : subtitle) : null}
      </View>
      {right}
    </View>
  );
}

export function Bar({ pct, style }: { pct: number; style?: StyleProp<ViewStyle> }) {
  return <View style={[s.bar, style]}><View style={{ width: `${Math.max(0, Math.min(100, pct))}%`, height: '100%', backgroundColor: C.gold }} /></View>;
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
      <Icon name={icon} size={36} color={C.muted} />
      <T weight="600" size={16} style={{ textAlign: 'center' }}>{title}</T>
      {body ? <T mu size={13} style={{ textAlign: 'center', lineHeight: 19 }}>{body}</T> : null}
      {action}
    </View>
  );
}

export function ErrorText({ children }: { children?: React.ReactNode }) {
  if (!children) return null;
  return <T size={13} style={{ color: '#ff8a9a' }}>{children}</T>;
}

export const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, justifyContent: 'center' },
  btn: { paddingVertical: 16, paddingHorizontal: 16, borderRadius: R.btn, alignItems: 'center', justifyContent: 'center', minHeight: 54 },
  btn2: { borderWidth: 1, borderColor: C.border2, paddingVertical: 15 },
  card: { backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: R.card, padding: 14 },
  inp: { backgroundColor: C.input, borderWidth: 1, borderColor: C.border2, borderRadius: R.inp, paddingVertical: 14, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 10 },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 4, paddingHorizontal: 9, borderRadius: R.pill, alignSelf: 'flex-start' },
  tog: { width: 46, height: 28, borderRadius: 14 },
  knob: { position: 'absolute', top: 3, width: 22, height: 22, borderRadius: 11, backgroundColor: '#fff' },
  hdr: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingTop: 10, paddingBottom: 12, paddingHorizontal: 18, borderBottomWidth: 1, borderBottomColor: C.border },
  bar: { height: 8, borderRadius: 4, backgroundColor: C.track, overflow: 'hidden' },
  body: { flex: 1, paddingHorizontal: 18, paddingVertical: 16, gap: 12 },
  screen: { flex: 1, backgroundColor: C.bg },
});
