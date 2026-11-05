import React, { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { C, F, S } from '../theme';
import { runMlsSelfTest, type MlsSelfTestResult } from '../lib/mls';

export default function MlsSelfTestScreen() {
  const [result, setResult] = useState<MlsSelfTestResult | null>(null);

  useEffect(() => {
    if (!__DEV__) {
      setResult({ ok: false, detail: 'MLS self-test is only available in __DEV__ builds.' });
      return;
    }
    let cancelled = false;
    runMlsSelfTest()
      .then((next) => {
        if (!cancelled) setResult(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setResult({
            ok: false,
            detail: err instanceof Error ? err.message : String(err),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const label = !result ? 'RUNNING' : result.ok ? 'PASS' : 'FAIL';
  const color = !result ? C.gold : result.ok ? C.green : C.red;

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: C.bg,
        alignItems: 'center',
        justifyContent: 'center',
        padding: S.pad,
      }}
    >
      <Text
        testID="mls-selftest-status"
        style={{
          color,
          fontFamily: F.heavy,
          fontSize: 64,
          letterSpacing: 2,
        }}
      >
        {label}
      </Text>
      <Text
        style={{
          color: C.muted,
          fontFamily: F.regular,
          fontSize: 16,
          marginTop: 16,
          textAlign: 'center',
        }}
      >
        {result?.detail ?? 'OpenMLS two-member round trip…'}
      </Text>
    </View>
  );
}
