import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, withRepeat, withTiming, Easing } from 'react-native-reanimated';
import { C } from '../../theme';
import { T, Button, Header, Card, Row, Spinner, ErrorText, s, Screen} from '../../components/ui';
import { Icon } from '../../components/Icon';
import { ensureKeys, finishOnboarding } from '../../lib/engine';
import { errMsg } from '../../lib/api';
import { useApp } from '../../store/app';

const STEPS = ['Creating identity key on this phone', 'Publishing your public key', 'Saving secret key to iOS Keychain'];

export default function Keys() {
  const me = useApp(st => st.me)!;
  const [step, setStep] = useState(0); const [done, setDone] = useState(false); const [err, setErr] = useState<string | null>(null);
  const [replacing] = useState(() => !!me.identityKey && useApp.getState().identity?.publicKey !== me.identityKey);
  const rot = useSharedValue(0);
  useEffect(() => { rot.value = withRepeat(withTiming(360, { duration: 1400, easing: Easing.linear }), -1); }, [rot]);
  const spin = useAnimatedStyle(() => ({ transform: [{ rotate: `${rot.value}deg` }], opacity: done ? 0 : 1 }));
  const run = async () => {
    setErr(null); setStep(0);
    try { await ensureKeys(n => setStep(n)); setStep(3); setDone(true); } catch (e) { setErr(errMsg(e)); }
  };
  useEffect(() => { run(); }, []); // eslint-disable-line react-hooks/set-state-in-effect -- key setup must start once on mount and reports progress via setState
  return (
    <Screen style={s.screen} edges={['top', 'bottom']}>
      <Header title="Securing your account" subtitle="Step 5 of 5" back={false} />
      <View style={[s.body, { alignItems: 'center', justifyContent: 'center', gap: 20 }]}>
        <View style={{ width: 150, height: 150, borderRadius: 75, borderWidth: 2, borderColor: C.gold, backgroundColor: C.goldCard, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="key" size={70} color={C.gold} width={1.5} />
          <Animated.View style={[{ position: 'absolute', width: 166, height: 166, borderRadius: 83, borderWidth: 3, borderColor: 'transparent', borderTopColor: C.gold }, spin]} />
        </View>
        <T serif size={27} style={{ textAlign: 'center' }}>Your messages are{'\n'}end-to-end encrypted</T>
        <T mu size={14} style={{ textAlign: 'center', lineHeight: 21 }}>Keys are created on this phone. Only you and{'\n'}the people you talk to can read messages.</T>
        {replacing ? <T size={12} style={{ color: C.gold, textAlign: 'center' }}>New phone detected: a new key will replace the old one. Your contacts will see your safety number change, and older messages sent to the old key can’t be read here.</T> : null}
        <Card style={{ alignSelf: 'stretch' }}>
          {STEPS.map((t, i) => (
            <Row key={t} style={{ justifyContent: 'flex-start', paddingVertical: 6, opacity: step > i ? 1 : step === i ? 0.8 : 0.35 }} testID={`ks${i}`}>
              {step > i ? <Icon name="check" size={16} color={C.green} /> : <Spinner size={16} />}
              <T size={14}>{t}</T>
            </Row>
          ))}
        </Card>
        <ErrorText>{err}</ErrorText>
        {err ? <Button testID="kretry" title="Try again" variant="secondary" style={{ alignSelf: 'stretch' }} onPress={run} /> : null}
        <Button testID="kgo" title="Start messaging" disabled={!done} style={{ alignSelf: 'stretch' }} onPress={() => finishOnboarding()} />
      </View>
    </Screen>
  );
}
