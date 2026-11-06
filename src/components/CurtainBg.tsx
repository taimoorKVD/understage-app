import React from 'react';
import { StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { G } from '../theme';

export function CurtainBg() {
  return <LinearGradient colors={[...G.page]} start={{ x: 0.15, y: 0 }} end={{ x: 0.85, y: 1 }} pointerEvents="none" style={StyleSheet.absoluteFill} />;
}
