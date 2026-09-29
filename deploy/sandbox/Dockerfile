# Minus Sandbox - Pre-built isolated development container (Debian-based for high stability)
FROM node:20-slim

# Cài đặt sẵn toàn bộ công cụ cốt lõi để container khởi động tức thì không cần download qua mạng
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    git \
    bash \
    ripgrep \
    ca-certificates \
    tar \
    gzip \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Bun (pinned to BUN_VERSION; keep in sync with src/toolchains/toolchain-recipes.ts)
ARG BUN_VERSION=bun-v1.2.4
RUN curl -fsSL -o /tmp/bun.zip "https://github.com/oven-sh/bun/releases/download/${BUN_VERSION}/bun-linux-x64.zip" \
    && unzip -q /tmp/bun.zip -d /tmp \
    && mv /tmp/bun-linux-x64/bun /usr/local/bin/bun \
    && chmod +x /usr/local/bin/bun \
    && rm -rf /tmp/bun.zip /tmp/bun-linux-x64 \
    && bun --version

# Thiết lập thư mục làm việc mặc định
WORKDIR /workspace

# Giữ container chạy ở chế độ nền
CMD ["tail", "-f", "/dev/null"]
