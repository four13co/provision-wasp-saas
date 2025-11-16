# Multi-stage Dockerfile for Wasp server deployment
# This Dockerfile is copied to the project root and used by CI/CD to build the server image

# Build stage - prepare dependencies
FROM node:20-alpine AS builder

WORKDIR /app

# Copy pre-built Wasp server from CI/CD
# Note: The workflow copies app/.wasp/build/server/* to the build context
COPY package*.json ./
COPY prisma ./prisma/

# Install dependencies (including devDependencies for Prisma generation)
RUN npm ci

# Generate Prisma client
RUN npx prisma generate

# Production stage - minimal runtime image
FROM node:20-alpine AS production

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

# Create non-root user for security
RUN addgroup -g 1001 -S wasp && \
    adduser -S wasp -u 1001 -G wasp

WORKDIR /app

# Copy node_modules from builder (includes generated Prisma client)
COPY --from=builder --chown=wasp:wasp /app/node_modules ./node_modules

# Copy application code
COPY --chown=wasp:wasp . .

# Set production environment
ENV NODE_ENV=production

# Expose port (Wasp server default)
EXPOSE 3001

# Switch to non-root user
USER wasp

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3001/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

# Start the server
CMD ["node", "server.js"]
