# rpc-guard image (Bun): JSON-RPC proxy between eRPC and anvil that rejects transactions from the public anvil dev
# keys and to the price reference (src/guard.ts). Build context: services/rpc-guard.
#   docker build -t bellswap-v2-rpc-guard services/rpc-guard
FROM oven/bun:1.3.5-debian
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY tsconfig.json ./
COPY src src
ENV RPC_GUARD_PORT=8546 RPC_GUARD_UPSTREAM=http://anvil:8545 RPC_GUARD_BELL_URL=http://bell:8787
EXPOSE 8546
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s CMD bun -e "fetch('http://127.0.0.1:'+(process.env.RPC_GUARD_PORT||8546)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "run", "src/index.ts"]
