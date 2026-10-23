# bots image (Bun): the labelled demo trader fleet (24 traders, 4 LPs from BOTS_MNEMONIC). Build context:
# services/bots. No ports published; health on :8790/health inside the network.
#   docker build -t bellswap-v2-bots services/bots
FROM oven/bun:1.3.5-debian
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY tsconfig.json ./
COPY src src
ENV BOTS_RPC_URL=http://anvil:8545 BOTS_BELL_URL=http://bell:8787 BOTS_HEALTH_PORT=8790
EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD bun -e "fetch('http://127.0.0.1:'+(process.env.BOTS_HEALTH_PORT||8790)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "run", "src/index.ts"]
