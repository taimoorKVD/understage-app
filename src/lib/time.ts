import * as Localization from 'expo-localization';
import type { Shift } from './types';
export const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export function phoneTimezone(): string { return Localization.getCalendars()[0]?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
export function localParts(tz: string, at = Date.now()) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(new Date(at)).map(x => [x.type, x.value]));
  return { day: DAYS.indexOf(p.weekday), minutes: Number(p.hour) * 60 + Number(p.minute), hhmm: `${p.hour}:${p.minute}` };
}
const toMin = (s: string) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
/** Mirrors server/src/util.ts isOnShift (Mon=0; shifts may cross midnight). */
export function isOnShift(shift: Shift, tz: string, quiet: boolean, at = Date.now()) {
  if (!quiet) return true;
  const { day, minutes } = localParts(tz, at);
  const s = toMin(shift.start), e = toMin(shift.end);
  if (s <= e) return shift.days.includes(day) && minutes >= s && minutes < e;
  return (shift.days.includes(day) && minutes >= s) || (shift.days.includes((day + 6) % 7) && minutes < e);
}
/** "12:00 today" / "12:00 tomorrow" / "12:00 Mon" — when the next shift starts. */
export function nextShiftLabel(shift: Shift, tz: string, at = Date.now()) {
  const { day, minutes } = localParts(tz, at);
  const s = toMin(shift.start);
  for (let i = 0; i < 8; i++) {
    const d = (day + i) % 7;
    if (!shift.days.includes(d)) continue;
    if (i === 0 && minutes >= s) continue;
    return `${shift.start} ${i === 0 ? 'today' : i === 1 ? 'tomorrow' : DAYS[d]}`;
  }
  return shift.start;
}
function gmtOffsetLabel(tz: string, at: number) {
  try {
    const d = new Date(at);
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const p = Object.fromEntries(fmt.formatToParts(d).filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
    const asUTC = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
    const mins = Math.round((asUTC - d.getTime()) / 60_000);
    const sign = mins >= 0 ? '+' : '-';
    const abs = Math.abs(mins);
    const hh = Math.floor(abs / 60);
    const mm = abs % 60;
    return mm ? `GMT${sign}${hh}:${String(mm).padStart(2, '0')}` : `GMT${sign}${hh}`;
  } catch { return undefined; }
}
export function tzAbbr(tz: string, at = Date.now()) {
  try {
    const name = (style: 'shortOffset' | 'short' | 'longOffset') =>
      new Intl.DateTimeFormat('en-GB', { timeZone: tz, timeZoneName: style }).formatToParts(new Date(at)).find(p => p.type === 'timeZoneName')?.value;
    // Hermes often reports IANA zones as bare "GMT" for short/shortOffset; prefer an explicit offset (e.g. GMT+5).
    for (const style of ['shortOffset', 'longOffset', 'short'] as const) {
      const value = name(style);
      if (value && value !== 'GMT' && value !== 'UTC') return value;
    }
  } catch { /* fall through to a computed offset */ }
  return gmtOffsetLabel(tz, at) || tz;
}
export const tzCity = (tz: string) => tz.split('/').pop()!.replace(/_/g, ' ');
export function clock(at: number) { const d = new Date(at); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }
export function listTime(at: number) {
  const d = new Date(at), n = new Date();
  if (d.toDateString() === n.toDateString()) return clock(at);
  const y = new Date(n); y.setDate(n.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  if (n.getTime() - at < 6 * 86400_000) return DAYS[(d.getDay() + 6) % 7];
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}
export const dur = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
export const fmtDate = (at: number) => new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
