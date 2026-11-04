import crypto from 'node:crypto';

export const now = () => Date.now();
export const uid = (p = '') => p + crypto.randomBytes(9).toString('base64url');
export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
export const hmac = (secret: string, s: string) => crypto.createHmac('sha256', secret).update(s).digest('base64url');
export const safeEq = (a: string, b: string) => {
  const A = Buffer.from(a), B = Buffer.from(b);
  return A.length === B.length && crypto.timingSafeEqual(A, B);
};

export class HttpError extends Error {
  constructor(public status: number, public code: string, message?: string) { super(message || code); }
}

/** Local wall-clock parts for a timezone. */
export function localParts(tz: string, at = Date.now()) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const parts = Object.fromEntries(f.formatToParts(new Date(at)).map(p => [p.type, p.value]));
  const dayIdx = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts.weekday);
  return { day: dayIdx, minutes: Number(parts.hour) * 60 + Number(parts.minute), hhmm: `${parts.hour}:${parts.minute}` };
}

const toMin = (s: string) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };

export interface ShiftUser { timezone: string; work_days: string; shift_start: string; shift_end: string; quiet_hours: number }

/** True when the user is inside their working hours (shifts may cross midnight). */
export function isOnShift(u: ShiftUser, at = Date.now()): boolean {
  if (!u.quiet_hours) return true; // quiet hours disabled => always reachable
  const { day, minutes } = localParts(u.timezone, at);
  const days: number[] = JSON.parse(u.work_days);
  const s = toMin(u.shift_start), e = toMin(u.shift_end);
  if (s <= e) return days.includes(day) && minutes >= s && minutes < e;
  // overnight shift: started today (after s) or started yesterday (before e)
  const yesterday = (day + 6) % 7;
  return (days.includes(day) && minutes >= s) || (days.includes(yesterday) && minutes < e);
}
