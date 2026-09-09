FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
RUN pnpm install --frozen-lockfile
COPY src ./src
RUN pnpm build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    GRYPHON_DATA_DIR=/var/lib/gryphon \
    GRYPHON_CLIENTS_DIR=/etc/gryphon/clients \
    GRYPHON_PUBLIC_HOST=0.0.0.0 \
    GRYPHON_ADMIN_SOCKET=/run/gryphon-admin/admin.sock \
    GRYPHON_CLIENT_SOCKET=/run/gryphon/client.sock
RUN mkdir -p /var/lib/gryphon /run/gryphon /run/gryphon-admin /etc/gryphon/clients && chown -R node:node /var/lib/gryphon /run/gryphon /run/gryphon-admin
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/package.json ./package.json
USER node
EXPOSE 18380
ENTRYPOINT ["node", "dist/main.js"]
