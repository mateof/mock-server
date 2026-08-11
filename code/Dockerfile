# Build stage - install dependencies
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

# Production stage - minimal image
FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app

# git es necesario para la auto-importación desde repositorio
# (MOCK_SERVER_GIT_REPO), que hace `git clone` en tiempo de ejecución.
# La imagen base no lo trae.
RUN apk add --no-cache git

# Copy only production dependencies from builder
COPY --from=builder /app/node_modules ./node_modules

# Copy application files
COPY package.json ./
COPY app.js ./
COPY middlewares ./middlewares
COPY routes ./routes
COPY services ./services
COPY views ./views
COPY public ./public
COPY locales ./locales

# Create non-root user for security
RUN addgroup -g 1001 -S appgroup && \
    adduser -u 1001 -S appuser -G appgroup && \
    chown -R appuser:appgroup /app

USER appuser

EXPOSE 3880

CMD ["node", "app.js"]
