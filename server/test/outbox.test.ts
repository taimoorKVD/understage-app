import { describe, it, expect } from 'vitest';
import { Outbox, PermanentSendError, MAX_ATTEMPTS } from '../../shared/outbox';

describe('offline outbox', () => {
  it('never marks sent while offline; sends on reconnect in order', async () => {
    let clock = 1000;
    const ob = new Outbox<string>(() => {}, () => clock);
    ob.enqueue('a', 'c1', 'one'); ob.enqueue('b', 'c1', 'two');
    const sent: string[] = [];
    expect(await ob.flush(async i => { sent.push(i.payload); return { serverId: 's' + i.clientId }; }, false)).toBe(0);
    expect(ob.items.map(i => i.state)).toEqual(['pending', 'pending']);
    expect(await ob.flush(async i => { sent.push(i.payload); return { serverId: 's' }; }, true)).toBe(2);
    expect(sent).toEqual(['one', 'two']); expect(ob.items).toHaveLength(0);
  });

  it('transient failure → backoff + preserves per-conversation order; permanent → failed; retry works', async () => {
    let clock = 0;
    const ob = new Outbox<string>(() => {}, () => clock);
    ob.enqueue('a', 'c1', 'first'); ob.enqueue('b', 'c1', 'second'); ob.enqueue('x', 'c2', 'other');
    let fail = true; const sent: string[] = [];
    await ob.flush(async i => { if (fail && i.clientId === 'a') throw new Error('network'); sent.push(i.payload); return { serverId: '1' }; }, true);
    expect(sent).toEqual(['other']); // c2 not blocked by c1
    expect(ob.items.find(i => i.clientId === 'a')!.state).toBe('pending');
    expect(ob.items.find(i => i.clientId === 'b')!.attempts).toBe(0);
    // before backoff expires nothing is sent
    await ob.flush(async i => { sent.push(i.payload); return { serverId: '1' }; }, true);
    expect(sent).toEqual(['other']);
    clock += 1001; fail = false;
    await ob.flush(async i => { sent.push(i.payload); return { serverId: '1' }; }, true);
    expect(sent).toEqual(['other', 'first', 'second']);
    ob.enqueue('p', 'c3', 'bad');
    await ob.flush(async () => { throw new PermanentSendError('403 BLOCKED'); }, true);
    expect(ob.items[0].state).toBe('failed'); expect(ob.items[0].error).toBe('403 BLOCKED');
    ob.retry('p'); expect(ob.items[0].state).toBe('pending');
    await ob.flush(async () => ({ serverId: 'ok' }), true);
    expect(ob.items).toHaveLength(0);
  });

  it('gives up after MAX_ATTEMPTS and recovers crashed "sending" items on load', async () => {
    let clock = 0;
    const ob = new Outbox<string>(() => {}, () => clock);
    ob.enqueue('a', 'c', 'x');
    for (let i = 0; i < MAX_ATTEMPTS; i++) { await ob.flush(async () => { throw new Error('offline'); }, true); clock += 120_000; }
    expect(ob.items[0].state).toBe('failed');
    const ob2 = new Outbox<string>();
    ob2.load([{ ...ob.items[0], state: 'sending' }]);
    expect(ob2.items[0].state).toBe('pending');
  });
});
