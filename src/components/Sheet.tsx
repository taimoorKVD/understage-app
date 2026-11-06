import React from 'react';
import { Modal, Pressable, View, KeyboardAvoidingView, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C } from '../theme';
import { T } from './ui';

/** Bottom sheet (prototype `.sheet`). */
export function Sheet({ visible, onClose, title, children, testID }: { visible: boolean; onClose: () => void; title?: string; children?: React.ReactNode; testID?: string }) {
  const ins = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)' }} onPress={onClose} accessibilityLabel="Close" />
        <View testID={testID} style={{ backgroundColor: C.glass, borderTopLeftRadius: 26, borderTopRightRadius: 26, borderWidth: 1, borderColor: C.border2, padding: 18, paddingBottom: 18 + ins.bottom, gap: 12 }}>
          <View style={{ alignSelf: 'center', width: 40, height: 5, borderRadius: 3, backgroundColor: C.border2, marginBottom: 4 }} />
          {title ? <T serif size={22}>{title}</T> : null}
          {children}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
