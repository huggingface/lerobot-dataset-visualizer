FROM oven/bun:1 AS base

# Set working directory
WORKDIR /app

# Copy package files
COPY package.json bun.lock* ./

# Install dependencies
RUN bun install --frozen-lockfile

# Copy the rest of the application
COPY . .

# Build the application
RUN bun run build

# Expose port 7860
EXPOSE 7860

# Set environment variable for port
ENV PORT=7860

# Start the application
CMD ["bun", "start"]
