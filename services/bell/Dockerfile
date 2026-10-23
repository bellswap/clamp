# bell v2 service image (Bun). Build context: services/bell (self-contained: the catalog and the built ABIs are
# vendored under vendor/).
#   docker build -t bellswap-v2-bell services/bell
# State (indexer, faucet log, replay rounds, chart cache) lives on the /data volume; the address book is mounted at
# /data/book.json by the deploy script (BELL_BOOK).
FROM oven/bun:1.3.5-debian
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY tsconfig.json ./
COPY src src
COPY vendor vendor
ENV BELL_PORT=8787 BELL_STATE_FILE=/data/state.json BELL_BOOK=/data/book.json BELL_CHAIN_ID=46633
EXPOSE 8787
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD bun -e "fetch('http://127.0.0.1:'+(process.env.BELL_PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "run", "src/index.ts"]
