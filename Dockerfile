# syntax=docker/dockerfile:1

# ---- build stage ----
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- runtime stage: no dependencies, compiled JS only ----
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV APP_PORT=3000
COPY --from=build /app/dist ./dist
EXPOSE 3000
HEALTHCHECK --interval=5s --timeout=3s --start-period=4s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.APP_PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]

# ---- one-shot verification stage ----
FROM build AS verify
ENV APP_BASE_URL=http://app:3000
COPY tests ./tests
COPY verify ./verify
CMD ["npx", "tsx", "verify/verify.ts"]
