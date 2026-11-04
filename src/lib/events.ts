type Fn = (d: any) => void;
const subs = new Map<string, Set<Fn>>();
/** Tiny in-app pub/sub so screens can react to realtime events without polling. */
export const bus = {
  on(ev: string, fn: Fn) { if (!subs.has(ev)) subs.set(ev, new Set()); subs.get(ev)!.add(fn); return () => { subs.get(ev)?.delete(fn); }; },
  emit(ev: string, d?: unknown) { subs.get(ev)?.forEach(f => { try { f(d); } catch (e) { console.warn(e); } }); },
};
