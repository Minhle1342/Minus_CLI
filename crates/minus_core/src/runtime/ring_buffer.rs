/// RingBuffer - Bộ đệm vòng với dung lượng tối đa cố định
/// Giữ nguyên phần đầu và phần cuối nếu vượt quá dung lượng để bảo vệ context LLM
#[derive(Debug, Clone)]
pub struct CircularStreamBuffer {
    capacity: usize,
    buffer: Vec<u8>,
    total_bytes_written: usize,
}

impl CircularStreamBuffer {
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity,
            buffer: Vec::with_capacity(capacity.min(65536)),
            total_bytes_written: 0,
        }
    }

    pub fn write(&mut self, data: &[u8]) {
        self.total_bytes_written += data.len();
        if self.buffer.len() + data.len() <= self.capacity {
            self.buffer.extend_from_slice(data);
        } else {
            let half = self.capacity / 2;
            if self.buffer.len() < half {
                let take = half - self.buffer.len();
                self.buffer.extend_from_slice(&data[..take.min(data.len())]);
            }
        }
    }

    pub fn to_string_truncated(&self) -> String {
        if self.total_bytes_written <= self.capacity {
            String::from_utf8_lossy(&self.buffer).to_string()
        } else {
            let half = self.capacity / 2;
            let head = if self.buffer.len() >= half {
                String::from_utf8_lossy(&self.buffer[..half]).to_string()
            } else {
                String::from_utf8_lossy(&self.buffer).to_string()
            };
            let truncated_count = self.total_bytes_written.saturating_sub(self.capacity);
            format!(
                "{}\n\n[... Đã cắt bớt {} bytes output bởi Rust Circular Buffer ...]\n",
                head, truncated_count
            )
        }
    }

    pub fn total_bytes(&self) -> usize {
        self.total_bytes_written
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_within_capacity() {
        let mut buf = CircularStreamBuffer::new(100);
        buf.write(b"Hello Rust");
        assert_eq!(buf.to_string_truncated(), "Hello Rust");
        assert_eq!(buf.total_bytes(), 10);
    }

    #[test]
    fn test_overflow_truncation() {
        let mut buf = CircularStreamBuffer::new(20);
        buf.write(b"123456789012345678901234567890");
        let s = buf.to_string_truncated();
        assert!(s.contains("Đã cắt bớt 10 bytes"));
    }
}
