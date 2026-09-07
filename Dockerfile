FROM node:20-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:20-alpine AS build
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000 PILOT_STRICT_CONFIG=true
RUN addgroup -S nodejs && adduser -S nextjs -G nodejs
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=dependencies --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=build --chown=nextjs:nodejs /app/src ./src
COPY --from=build --chown=nextjs:nodejs /app/scripts ./scripts
COPY --from=build --chown=nextjs:nodejs /app/app ./app
COPY --from=build --chown=nextjs:nodejs /app/package.json ./package.json
USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
