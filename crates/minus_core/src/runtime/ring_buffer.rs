/// RingBuffer - Bộ đệm vòng với dung lượng tối đa cố định
/// Giữ nguyên phần đầu và phần cuối nếu vượt quá dung lượng để bảo vệ context LLM
#[derive(Debug, Clone)]
pub struct CircularStreamBuffer {
    capacity: usize,
    head: Vec<u8>,
    tail: Vec<u8>,
    total_bytes_written: usize,
}

impl CircularStreamBuffer {
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity,
            head: Vec::with_capacity(((capacity + 1) / 2).min(65536)),
            tail: Vec::with_capacity((capacity / 2).min(65536)),
            total_bytes_written: 0,
        }
    }

    pub fn write(&mut self, data: &[u8]) {
        self.total_bytes_written += data.len();
        let head_capacity = (self.capacity + 1) / 2;
        let tail_capacity = self.capacity / 2;
        let head_space = head_capacity.saturating_sub(self.head.len());
        let head_take = head_space.min(data.len());
        self.head.extend_from_slice(&data[..head_take]);

        let remaining = &data[head_take..];
        if tail_capacity == 0 || remaining.is_empty() {
            return;
        }
        if remaining.len() >= tail_capacity {
            self.tail.clear();
            self.tail.extend_from_slice(&remaining[remaining.len() - tail_capacity..]);
            return;
        }
        let overflow = self.tail.len().saturating_add(remaining.len()).saturating_sub(tail_capacity);
        if overflow > 0 {
            self.tail.drain(..overflow);
        }
        self.tail.extend_from_slice(remaining);
    }

    pub fn to_string_truncated(&self) -> String {
        if self.total_bytes_written <= self.capacity {
            let mut retained = Vec::with_capacity(self.total_bytes_written);
            retained.extend_from_slice(&self.head);
            retained.extend_from_slice(&self.tail);
            String::from_utf8_lossy(&retained).to_string()
        } else {
            let head = String::from_utf8_lossy(&self.head);
            let tail = String::from_utf8_lossy(&self.tail);
            let truncated_count = self.total_bytes_written.saturating_sub(self.head.len() + self.tail.len());
            format!(
                "{}\n\n[... Đã cắt bớt {} bytes output bởi Rust Circular Buffer ...]\n\n{}",
                head, truncated_count, tail
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
        assert!(s.starts_with("1234567890"));
        assert!(s.ends_with("1234567890"));
    }
}
