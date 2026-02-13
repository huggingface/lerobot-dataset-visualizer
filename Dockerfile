FROM oven/bun:1 AS base

# Install apt dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    cmake \
    git \
    wget \
    ca-certificates \
    libglib2.0-0 \
    libgl1-mesa-glx \
    libegl1-mesa \
    ffmpeg \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

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
