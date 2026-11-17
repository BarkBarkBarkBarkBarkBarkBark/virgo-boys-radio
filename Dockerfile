FROM node:20-alpine

# Icecast and Caddy run beside the existing Fastify API on the same Fly Machine.
# Packages must be in the image, never installed interactively into the VM.
RUN apk add --no-cache icecast caddy gettext

RUN corepack enable && corepack prepare pnpm@10.33.2 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/ui/package.json packages/ui/package.json

RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm --filter @virgo-boys-radio/shared build \
    && pnpm --filter @virgo-boys-radio/api build

COPY apps/api/src/db/migrations ./apps/api/dist/db/migrations

EXPOSE 3001

CMD ["sh", "/app/infra/fly/start.sh"]
