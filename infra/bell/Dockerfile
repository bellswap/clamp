# bell v2 service image (services/bell). Kept in infra/ as the default build file of the stack.
# docker-compose.yml uses services/bell/Dockerfile when it exists (BELL_DOCKERFILE), else this file.
FROM oven/bun:1.3.5
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY . .
RUN mkdir -p /data
ENV BELL_PORT=8787 BELL_STATE_FILE=/data/state.json BELL_BOOK=/data/book.json
EXPOSE 8787
CMD ["bun", "run", "src/index.ts"]
