import type { FastifyInstance } from 'fastify';

export function shouldLogHttpRequests(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.REQUEST_LOG === '1') return true;
  if (env.REQUEST_LOG === '0') return false;
  return env.NODE_ENV !== 'production' && env.NODE_ENV !== 'test';
}

/** method + path + status + ip only. Query strings (possible tokens) are stripped. */
export function formatHttpLog(req: { method?: string; url?: string; ip?: string }, status: number): string {
  const method = req.method || '?';
  const path = String(req.url || '/').split('?')[0] || '/';
  const ip = req.ip || '-';
  return `[http] ${method} ${path} ${status} ${ip}`;
}

export function registerRequestLogging(
  app: FastifyInstance,
  env: NodeJS.ProcessEnv = process.env,
  write: (line: string) => void = console.log,
): void {
  if (!shouldLogHttpRequests(env)) return;
  app.addHook('onResponse', (req, reply, done) => {
    write(formatHttpLog({ method: req.method, url: req.url, ip: req.ip }, reply.statusCode));
    done();
  });
}
