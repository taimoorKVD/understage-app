import './env.js';
import { buildApp } from './app.js';
import { openDb } from './db.js';
import { loadConfig } from './config.js';
import { attachRealtime, LateEmitter } from './realtime.js';
import { ExpoPushSender, MemoryPushSender, otpSenderFromEnv } from './providers.js';

const cfg = loadConfig();
const emitter = new LateEmitter();
const built = buildApp({
  db: openDb(cfg.dbFile), otp: otpSenderFromEnv(), emit: emitter,
  push: cfg.expoPushEnabled ? new ExpoPushSender() : new MemoryPushSender(),
});
await built.app.ready();
attachRealtime(built.app.server, built, emitter);
await built.app.listen({ port: cfg.port, host: '0.0.0.0' });
console.log(`[understage] API + realtime on :${cfg.port} (db=${cfg.dbFile}, push=${cfg.expoPushEnabled ? 'expo' : 'memory'})`);

setInterval(() => { built.jobs.releaseHeld().catch(e => console.error('[jobs] releaseHeld', e)); built.jobs.purgeWrapped(); }, 60_000);
