import React, { useRef } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { SafeAreaView } from 'react-native-safe-area-context';
import { C } from '../../theme';
import { T, Tap, Button, s } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { useApp } from '../../store/app';
import { tokenFromInviteUrl as tokenFromUrl } from '../../../shared/deep-link';
export { tokenFromUrl };

export default function Scan() {
  const [perm, request] = useCameraPermissions(); const toast = useApp(st => st.showToast); const done = useRef(false);
  return (
    <View style={[s.screen, { backgroundColor: '#000' }]}>
      {perm?.granted ? <CameraView style={{ position: 'absolute', inset: 0 }} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={({ data }) => { if (done.current) return; const t = tokenFromUrl(data); if (!t) { toast("That isn't an Understage code"); return; } done.current = true; router.replace(`/invite/${t}`); }} /> : null}
      <SafeAreaView style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <Tap testID="scanclose" accessibilityLabel="Close" onPress={() => router.back()} style={{ position: 'absolute', top: 60, left: 18 }}><Icon name="x" size={26} color="#fff" /></Tap>
        <T weight="600" style={{ position: 'absolute', top: 64 }}>Scan a colleague’s code</T>
        {perm?.granted ? <View style={{ width: 260, height: 260, borderWidth: 4, borderColor: C.gold, borderRadius: 18 }} /> : (
          <View style={{ padding: 30, gap: 14, alignItems: 'center' }}>
            <Icon name="cam" size={40} color={C.gold} />
            <T style={{ textAlign: 'center' }}>Understage needs the camera to scan QR codes. Nothing is recorded.</T>
            <Button testID="camperm" title={perm?.canAskAgain === false ? 'Camera blocked — enable in Settings' : 'Allow camera'} onPress={request} />
          </View>)}
      </SafeAreaView>
    </View>
  );
}
