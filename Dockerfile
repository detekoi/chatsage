# Stage 1: Build Stage - Install dependencies and copy source code
FROM node:18-alpine AS builder
LABEL maintainer="Henry Manes" description="Build stage for ChatSage Twitch Bot"

WORKDIR /usr/src/app

# Install dependencies
# Copy package.json and package-lock.json first to leverage Docker cache
COPY package.json package-lock.json* ./
# Use 'npm ci' for clean, reproducible installs based on package-lock.json
# Only install production dependencies to keep the final image smaller
RUN npm ci --omit=dev --ignore-scripts

# Copy the rest of the application source code
COPY ./src ./src
# Copy config examples if needed for reference within build, but not essential
# COPY ./config ./config

# Optional: Add a healthcheck or build step here if necessary

# Stage 2: Production Stage - Create the final lightweight image
FROM node:18-alpine AS production
LABEL maintainer="Henry Manes" description="Production image for ChatSage Twitch Bot"

WORKDIR /usr/src/app

# Set environment to production
ENV NODE_ENV=production
# Set default log level (can be overridden by environment variable at runtime)
ENV LOG_LEVEL=info
# Disable pretty logging for production JSON output
ENV PINO_PRETTY_LOGGING=false

# Create a non-root user and group for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Copy dependencies from the builder stage
COPY --from=builder /usr/src/app/node_modules ./node_modules
# Copy application code from the builder stage
COPY --from=builder /usr/src/app/src ./src
# Ensure package.json exists for version lookup etc., but don't need lock file
COPY --from=builder /usr/src/app/package.json ./package.json

# Change ownership of application files to the non-root user
RUN chown -R appuser:appgroup /usr/src/app

# Switch to the non-root user
USER appuser

# Define the command to run the application
# Use 'node' directly for simplicity
CMD [ "node", "src/bot.js" ]

# Expose port (Optional: Not strictly needed as bot connects outbound, but good practice)
# EXPOSE 3000