// bell v2: the playground service (faucet, demo signer replay, settler, indexer, leaderboard). docs/INTERFACES.md.
import { App, log } from './app';
import { loadEnv, type Env } from './config';
import { handler } from './server';

export function start(env: Env = loadEnv()) {
  const app = new App(env);
  const h = handler(app);
  const server = Bun.serve({ port: env.port, hostname: '0.0.0.0', idleTimeout: 60, fetch: (req, srv) => h(req, srv) });
  log(`listening on :${server.port}, chain ${env.chainId} at ${env.rpcUrl}, house ${app.chain.house.address}, signer ${app.chain.signer.address}, speed ${app.speed} bars per minute, origins ${env.origins.join(' ')}`);
  app.start();
  const stop = () => {
    app.stop();
    server.stop(true);
  };
  return { app, server, stop };
}

if (import.meta.main) {
  const s = start();
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => (s.stop(), process.exit(0)));
}
