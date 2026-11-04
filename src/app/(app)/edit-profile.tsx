import React from 'react';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Header, s } from '../../components/ui';
import { ProfileForm } from '../(onb)/profile';
export default function EditProfile() {
  return <SafeAreaView style={s.screen} edges={['top', 'bottom']}><Header title="Edit profile" /><ProfileForm editing cta="Save" onDone={() => router.back()} /></SafeAreaView>;
}
