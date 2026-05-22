# syntax=docker/dockerfile:1.7

# -- deps stage ---------------------------------------------------------
FROM node:20-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev

# -- build stage --------------------------------------------------------
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci
COPY src ./src
RUN npm run build

# -- final stage --------------------------------------------------------
# Distroless: no shell, no package manager, small attack surface.
# For interactive debugging, swap the FROM line below for:
#   FROM node:20-slim AS final
# and then `docker exec -it ... sh` works.
FROM gcr.io/distroless/nodejs20-debian12 AS final
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000

COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

USER nonroot
EXPOSE 3000
CMD ["dist/cli/start.js"]
