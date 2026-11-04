import React, { useState } from 'react';
import { View } from 'react-native';
import { C } from '../theme';
import { T, Tap, Card, Label, Row, Toggle, Button } from './ui';
import { Icon, type IconName } from './Icon';
import { Sheet } from './Sheet';
import { phoneTimezone, tzAbbr } from '../lib/time';

export interface HoursValue { workDays: number[]; shiftStart: string; shiftEnd: string; followPhoneTz: boolean; touringMode: boolean; quietHours: boolean; timezone: string }
const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const fromMin = (m: number) => { const x = ((m % 1440) + 1440) % 1440; return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`; };

function TimePicker({ value, onChange, title, onClose }: { value: string; onChange: (v: string) => void; title: string; onClose: () => void }) {
  const [v, setV] = useState(value);
  const step = (d: number) => setV(fromMin(toMin(v) + d));
  const btn = (label: string, d: number) => <Tap testID={`tp${d}`} onPress={() => step(d)} style={{ backgroundColor: C.input, borderRadius: 12, paddingVertical: 10, paddingHorizontal: 14 }}><T weight="700">{label}</T></Tap>;
  return (
    <Sheet visible onClose={onClose} title={title}>
      <T size={48} weight="700" style={{ textAlign: 'center' }} testID="tp-value">{v}</T>
      <Row gap={8}>{btn('−1h', -60)}{btn('−15m', -15)}{btn('+15m', 15)}{btn('+1h', 60)}</Row>
      <Button testID="tp-done" title="Done" onPress={() => { onChange(v); onClose(); }} />
    </Sheet>
  );
}

export function HoursEditor({ value, onChange }: { value: HoursValue; onChange: (v: HoursValue) => void }) {
  const [pick, setPick] = useState<'start' | 'end' | null>(null);
  const tz = value.followPhoneTz ? phoneTimezone() : value.timezone;
  const toggleRow = (icon: IconName, title: string, sub: string, v: boolean, key: keyof HoursValue) => (
    <Card style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      <Icon name={icon} size={22} color={C.gold} />
      <View style={{ flex: 1 }}><T weight="600">{title}</T><T mu size={13}>{sub}</T></View>
      <Toggle testID={`tog-${key}`} value={v} onChange={x => onChange({ ...value, [key]: x, ...(key === 'followPhoneTz' && x ? { timezone: phoneTimezone() } : {}) })} />
    </Card>
  );
  return (
    <View style={{ gap: 12 }}>
      <Label>Work days</Label>
      <Row style={{ justifyContent: 'space-between' }}>
        {'MTWTFSS'.split('').map((d, i) => {
          const on = value.workDays.includes(i);
          return (
            <Tap key={i} testID={`day${i}`} accessibilityLabel={`Day ${i}`} onPress={() => onChange({ ...value, workDays: on ? value.workDays.filter(x => x !== i) : [...value.workDays, i].sort() })}
              style={{ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? C.gold : C.track }}>
              <T weight="700" size={14} style={{ color: on ? '#000' : C.text }}>{d}</T>
            </Tap>
          );
        })}
      </Row>
      <Row gap={12}>
        {(['start', 'end'] as const).map(k => (
          <Card key={k} testID={`shift-${k}`} style={{ flex: 1 }} onPress={() => setPick(k)}>
            <Label>{k === 'start' ? 'Start' : 'End'}</Label>
            <T size={30} weight="700" style={{ marginTop: 4 }}>{k === 'start' ? value.shiftStart : value.shiftEnd}</T>
          </Card>
        ))}
      </Row>
      {toggleRow('clock', 'Time zone', `${tz.replace(/_/g, ' ')} (${tzAbbr(tz)})${value.followPhoneTz ? ' · from phone' : ''}`, value.followPhoneTz, 'followPhoneTz')}
      {toggleRow('plane', 'Touring mode', "Follow my location's time zone", value.touringMode, 'touringMode')}
      {toggleRow('moon', 'Quiet hours', 'Nothing breaks through. Ever.', value.quietHours, 'quietHours')}
      {pick ? <TimePicker title={pick === 'start' ? 'Shift starts' : 'Shift ends'} value={pick === 'start' ? value.shiftStart : value.shiftEnd} onClose={() => setPick(null)}
        onChange={v => onChange({ ...value, [pick === 'start' ? 'shiftStart' : 'shiftEnd']: v })} /> : null}
    </View>
  );
}
