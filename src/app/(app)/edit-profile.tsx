import React from 'react';
import { router } from 'expo-router';
import { Header, s, Screen} from '../../components/ui';
import { ProfileForm } from '../(onb)/profile';
export default function EditProfile() {
  return <Screen style={s.screen} edges={['top', 'bottom']}><Header title="Edit profile" /><ProfileForm editing cta="Save" onDone={() => router.back()} /></Screen>;
}
