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
    && rm -rf /var/lib/apt/lists/*

# Thiết lập thư mục làm việc mặc định
WORKDIR /workspace

# Giữ container chạy ở chế độ nền
CMD ["tail", "-f", "/dev/null"]
