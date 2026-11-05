/**
 * As Alex: decrypt a message envelope, download + decrypt its blob, classify
 * the bytes, optionally mark delivered/read. Does not print tokens, OTP, or keys.
 */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { decryptPayload, decryptBlob, type PlainMessage } from '../shared/e2ee.ts';

const API = process.env.API_URL || 'http://127.0.0.1:4000';
const PHONE = '+447700900300';
const CONV = process.env.CONV || 'c_kthwzfur3ztd';
const ALEX = 'u_FAl8p1_6KbKa';
const PEER = 'u_875nDU6SAca7';
const MESSAGE_ID = process.env.MESSAGE_ID || 'm_uhp2e7f3zETG';
const ID_PATH = process.env.ALEX_IDENTITY_PATH ||
  '/Users/kvmac/Library/Developer/CoreSimulator/Devices/49BAAD3B-A2A2-4E0B-B7D3-92D3B603BD1C/data/Containers/Data/Application/832F32E2-8953-4FC4-ACD8-46AC36736112/Documents/understage_secure_identity_u_FAl8p1_6KbKa.json';
const OUT = process.env.OUT || '/tmp/alex-media-verify.json';
const MARK = process.env.MARK !== '0';

function header(token: string) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function json(res: Response) {
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 200) }; }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} ${res.statusText} ${JSON.stringify(body)?.slice(0, 300)}`);
    (err as any).status = res.status;
    (err as any).body = body;
    throw err;
  }
  return body;
}

function classifyBytes(buf: Uint8Array): { kind: string; detail: string } {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { kind: 'jpeg', detail: 'ffd8ff' };
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { kind: 'png', detail: 'png' };
  if (buf.length >= 12 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return { kind: 'gif', detail: 'gif' };
  if (buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return { kind: 'webp', detail: 'webp' };
  if (buf.length >= 12) {
    const tag = String.fromCharCode(buf[4], buf[5], buf[6], buf[7]);
    const brand = String.fromCharCode(buf[8], buf[9], buf[10], buf[11]).replace(/\0/g, ' ').trim();
    if (tag === 'ftyp') {
      const b = brand.toLowerCase();
      if (b.startsWith('m4a') || b === 'mp42' || b === 'isom' || b.startsWith('m4b') || b === 'mp41') {
        return { kind: 'm4a', detail: `ftyp:${brand}` };
      }
      if (b.startsWith('heic') || b.startsWith('heif') || b === 'mif1' || b.startsWith('msf1')) {
        return { kind: 'heif', detail: `ftyp:${brand}` };
      }
      return { kind: 'mp4-family', detail: `ftyp:${brand}` };
    }
  }
  return { kind: 'unknown', detail: `len=${buf.length}` };
}

function runFfprobe(file: string): { ok: boolean; format?: string; codec?: string; duration?: string; stderrHead?: string } {
  const bins = [
    process.env.FFPROBE,
    'ffprobe',
    '/opt/homebrew/bin/ffprobe',
    '/usr/local/bin/ffprobe',
  ].filter(Boolean) as string[];
  const ffmpegs = [
    process.env.FFMPEG,
    'ffmpeg',
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
  ].filter(Boolean) as string[];

  for (const bin of bins) {
    const r = spawnSync(bin, ['-v', 'error', '-show_entries', 'format=format_name,duration:stream=codec_name,codec_type', '-of', 'json', file], { encoding: 'utf8' });
    if (r.error && (r.error as any).code === 'ENOENT') continue;
    if (r.status === 0) {
      try {
        const j = JSON.parse(r.stdout || '{}');
        const format = j.format?.format_name;
        const audio = (j.streams || []).find((s: any) => s.codec_type === 'audio');
        return { ok: true, format, codec: audio?.codec_name, duration: j.format?.duration };
      } catch {
        return { ok: r.status === 0, stderrHead: (r.stderr || '').slice(0, 200) };
      }
    }
    return { ok: false, stderrHead: (r.stderr || r.stdout || '').slice(0, 240) };
  }
  for (const bin of ffmpegs) {
    const r = spawnSync(bin, ['-hide_banner', '-i', file, '-f', 'null', '-'], { encoding: 'utf8' });
    if (r.error && (r.error as any).code === 'ENOENT') continue;
    const text = `${r.stderr || ''}\n${r.stdout || ''}`;
    const fmt = text.match(/Input #0,\s*([^,]+),/)?.[1]?.trim();
    const codec = text.match(/Audio:\s*([a-zA-Z0-9_]+)/)?.[1];
    const dur = text.match(/Duration:\s*([0-9:.]+)/)?.[1];
    const ok = /Audio:/i.test(text) && !/Invalid data/i.test(text);
    return { ok, format: fmt, codec, duration: dur, stderrHead: ok ? undefined : text.slice(0, 240) };
  }
  return { ok: false, stderrHead: 'ffprobe/ffmpeg not installed' };
}

async function main() {
  const identity = JSON.parse(fs.readFileSync(ID_PATH, 'utf8')) as { publicKey: string; secretKey: string };
  if (!identity?.publicKey || !identity?.secretKey) throw new Error('identity file missing keys');

  const reqOtp = await json(await fetch(`${API}/auth/otp/request`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'phone', destination: PHONE }),
  }));
  if (!reqOtp?.devCode) throw new Error('dev OTP was not returned');

  const session = await json(await fetch(`${API}/auth/otp/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'phone', destination: PHONE, code: String(reqOtp.devCode) }),
  }));
  const token = session.accessToken as string;
  if (!token) throw new Error('no access token');
  if (session.user?.id && session.user.id !== ALEX) throw new Error(`unexpected user ${session.user.id}`);

  const me = await json(await fetch(`${API}/me`, { headers: header(token) }));
  if (me.identityKey && me.identityKey !== identity.publicKey) {
    throw new Error('Simulator secret does not match published identity_key; refusing to rotate keys');
  }

  const peer = await json(await fetch(`${API}/users/${PEER}`, { headers: header(token) }));
  const peerPk = peer.identityKey || peer.user?.identityKey;
  if (!peerPk) throw new Error('peer has no published identity key');

  const page = await json(await fetch(`${API}/conversations/${CONV}/messages?limit=50`, { headers: header(token) }));
  const messages: any[] = page.messages || [];
  const msg = messages.find((m: any) => m.id === MESSAGE_ID);
  if (!msg) throw new Error(`message ${MESSAGE_ID} not in conversation page`);
  if (!msg.nonce || !msg.ciphertext) throw new Error('message missing envelope');

  const plain = decryptPayload(msg.nonce, msg.ciphertext, peerPk, identity.secretKey);
  if (!plain) throw new Error('envelope decrypt failed');

  const result: any = {
    ok: true,
    messageId: msg.id,
    seq: msg.seq,
    createdAt: msg.createdAt,
    envelopeType: plain.type,
    hasAttachment: 'attachment' in plain && !!(plain as any).attachment,
    mime: (plain as any).attachment?.mime ?? null,
    attachmentId: (plain as any).attachment?.id ?? null,
    declaredSize: (plain as any).attachment?.size ?? null,
    durationSec: (plain as any).durationSec ?? null,
    marked: null as null | { delivered: number; read: unknown },
  };

  if ('attachment' in plain && plain.attachment) {
    const att = await json(await fetch(`${API}/attachments/${plain.attachment.id}`, { headers: header(token) }));
    const blob = decryptBlob(att.data, plain.attachment.key, plain.attachment.nonce);
    if (!blob) throw new Error('blob decrypt failed');
    const classified = classifyBytes(blob);
    result.blobBytes = blob.length;
    result.classified = classified;
    const ext = classified.kind === 'jpeg' ? 'jpg' : classified.kind === 'png' ? 'png' : classified.kind === 'm4a' || classified.kind === 'mp4-family' ? 'm4a' : 'bin';
    const outFile = process.env.BLOB_OUT || `/tmp/alex-${MESSAGE_ID}.${ext}`;
    fs.writeFileSync(outFile, Buffer.from(blob));
    result.blobFile = outFile;
    if (plain.type === 'voice' || classified.kind === 'm4a' || classified.kind === 'mp4-family') {
      result.ffprobe = runFfprobe(outFile);
      result.validM4a = !!(result.ffprobe?.ok || classified.kind === 'm4a');
    }
    if (plain.type === 'image') {
      result.validImage = ['jpeg', 'png', 'gif', 'webp', 'heif'].includes(classified.kind);
    }
  }

  if (MARK) {
    const delivered = await json(await fetch(`${API}/messages/delivered`, {
      method: 'POST', headers: header(token), body: JSON.stringify({ messageIds: [msg.id] }),
    }));
    const read = await json(await fetch(`${API}/conversations/${CONV}/read`, {
      method: 'POST', headers: header(token), body: JSON.stringify({ seq: msg.seq }),
    }));
    result.marked = { delivered: delivered.updated, read };
  }

  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}

main().catch(e => {
  const err = { ok: false, error: (e as Error).message };
  fs.writeFileSync(OUT, JSON.stringify(err, null, 2));
  console.error(JSON.stringify(err));
  process.exit(1);
});
