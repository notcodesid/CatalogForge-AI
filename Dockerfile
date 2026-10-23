# One image for the web app and the worker: the ECS task chooses the command (`pnpm start` or `pnpm worker`).
# Dev dependencies stay in: the worker and the scripts run TypeScript directly with tsx
FROM node:24-slim
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 NEXT_TELEMETRY_DISABLED=1
RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

# RDS signs its certificates with Amazon's own authority, which Node doesn't know: trust it, so the database
# connection's SSL is verified
ADD https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /app/rds-ca.pem
RUN chmod 644 /app/rds-ca.pem
ENV NODE_EXTRA_CA_CERTS=/app/rds-ca.pem NODE_ENV=production PORT=3000

# Not as root. Next.js writes its cache into .next
RUN chown -R node:node /app/.next
USER node
EXPOSE 3000
CMD ["pnpm", "start"]
