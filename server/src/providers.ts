/** Pluggable SMS / email / push providers. */
export interface OtpSender { send(kind: 'phone' | 'email', destination: string, code: string): Promise<void> }

export class ConsoleOtpSender implements OtpSender {
  public last: { destination: string; code: string } | null = null;
  async send(kind: 'phone' | 'email', destination: string, code: string) {
    this.last = { destination, code };
    // DEV ONLY: in production wire TwilioOtpSender (below) via SMS_PROVIDER=twilio.
    console.log(`[otp] ${kind} ${destination.slice(0, 3)}*** code=${code}`);
  }
}

export class TwilioOtpSender implements OtpSender {
  constructor(private sid: string, private token: string, private from: string) {}
  async send(kind: 'phone' | 'email', destination: string, code: string) {
    if (kind !== 'phone') throw new Error('Twilio sender handles phone only; configure an email provider');
    const body = new URLSearchParams({ To: destination, From: this.from, Body: `Your Understage code is ${code}` });
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${this.sid}/Messages.json`, {
      method: 'POST', body,
      headers: { Authorization: 'Basic ' + Buffer.from(`${this.sid}:${this.token}`).toString('base64') },
    });
    if (!r.ok) throw new Error(`SMS provider error ${r.status}`);
  }
}

export interface PushMessage { to: string; title: string; body: string; data?: Record<string, unknown>; sound?: 'default' | null }
export interface PushSender { send(msgs: PushMessage[]): Promise<void> }

export class MemoryPushSender implements PushSender {
  sent: PushMessage[] = [];
  async send(msgs: PushMessage[]) { this.sent.push(...msgs); }
}

export class ExpoPushSender implements PushSender {
  async send(msgs: PushMessage[]) {
    for (let i = 0; i < msgs.length; i += 100) {
      const r = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(msgs.slice(i, i + 100)),
      });
      if (!r.ok) console.warn('[push] expo push failed', r.status);
    }
  }
}

export function otpSenderFromEnv(): OtpSender {
  const e = process.env;
  if (e.SMS_PROVIDER === 'twilio' && e.TWILIO_SID && e.TWILIO_TOKEN && e.TWILIO_FROM) return new TwilioOtpSender(e.TWILIO_SID, e.TWILIO_TOKEN, e.TWILIO_FROM);
  if (e.NODE_ENV === 'production') throw new Error('Configure SMS_PROVIDER=twilio (TWILIO_SID/TOKEN/FROM) in production');
  return new ConsoleOtpSender();
}
