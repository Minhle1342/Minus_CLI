use napi_derive::napi;

#[napi(object)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RsShellAnalysis {
    pub segments: Vec<String>,
    pub operators: Vec<String>,
    pub complex: bool,
    pub error: Option<String>,
}

/// Phân tích cú pháp shell dạng token stream và AST
/// Xử lý trích dẫn kép, đơn, escape sequences, command substitution, pipe, logical operators
pub fn parse_shell_command(command: &str) -> RsShellAnalysis {
    let mut segments: Vec<String> = Vec::new();
    let mut operators: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut quote: Option<u8> = None;
    let mut escaped = false;
    let mut complex = false;

    let bytes = command.as_bytes();
    let len = bytes.len();
    let mut i = 0;

    while i < len {
        let b = bytes[i];

        if escaped {
            current.push(b as char);
            escaped = false;
            i += 1;
            continue;
        }

        if b == b'`' || (b == b'\\' && quote != Some(b'\'')) {
            current.push(b as char);
            escaped = true;
            i += 1;
            continue;
        }

        if let Some(q) = quote {
            current.push(b as char);
            if b == q {
                quote = None;
            }
            i += 1;
            continue;
        }

        if b == b'\'' || b == b'"' {
            quote = Some(b);
            current.push(b as char);
            i += 1;
            continue;
        }

        // Kiểm tra command substitution: $(...) hoặc backtick hoặc grouping (...)
        if b == b'$' && i + 1 < len && bytes[i + 1] == b'(' {
            complex = true;
        }
        if b == b'(' || b == b')' {
            complex = true;
        }

        // Kiểm tra toán tử 2 ký tự: && hoặc ||
        if i + 1 < len {
            if b == b'&' && bytes[i + 1] == b'&' {
                let val = current.trim();
                if val.is_empty() {
                    return RsShellAnalysis {
                        segments,
                        operators,
                        complex: true,
                        error: Some("Empty shell command segment.".to_string()),
                    };
                }
                segments.push(val.to_string());
                current.clear();
                operators.push("&&".to_string());
                i += 2;
                continue;
            } else if b == b'|' && bytes[i + 1] == b'|' {
                let val = current.trim();
                if val.is_empty() {
                    return RsShellAnalysis {
                        segments,
                        operators,
                        complex: true,
                        error: Some("Empty shell command segment.".to_string()),
                    };
                }
                segments.push(val.to_string());
                current.clear();
                operators.push("||".to_string());
                i += 2;
                continue;
            }
        }

        // Kiểm tra toán tử 1 ký tự: |, ;, newline
        if b == b'|' || b == b';' || b == b'\n' || b == b'\r' {
            let val = current.trim();
            if val.is_empty() {
                if b == b'\r' && i + 1 < len && bytes[i + 1] == b'\n' {
                    i += 1;
                    continue;
                }
                return RsShellAnalysis {
                    segments,
                    operators,
                    complex: true,
                    error: Some("Empty shell command segment.".to_string()),
                };
            }
            segments.push(val.to_string());
            current.clear();
            let op = match b {
                b'\n' | b'\r' => "newline".to_string(),
                b'|' => "|".to_string(),
                b';' => ";".to_string(),
                _ => (b as char).to_string(),
            };
            operators.push(op);
            i += 1;
            continue;
        }

        current.push(b as char);
        i += 1;
    }

    if quote.is_some() || escaped {
        return RsShellAnalysis {
            segments,
            operators,
            complex: true,
            error: Some("Unterminated quote or escape sequence.".to_string()),
        };
    }

    let val = current.trim().to_string();
    if !val.is_empty() {
        segments.push(val);
    }

    if segments.is_empty() {
        return RsShellAnalysis {
            segments,
            operators,
            complex,
            error: Some("No executable command segment.".to_string()),
        };
    }

    RsShellAnalysis {
        segments,
        operators,
        complex,
        error: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_single_command() {
        let res = parse_shell_command("npm test");
        assert_eq!(res.segments, vec!["npm test"]);
        assert!(res.operators.is_empty());
        assert!(!res.complex);
        assert!(res.error.is_none());
    }

    #[test]
    fn test_chained_command() {
        let res = parse_shell_command("npm run build && npm test");
        assert_eq!(res.segments, vec!["npm run build", "npm test"]);
        assert_eq!(res.operators, vec!["&&"]);
        assert!(!res.complex);
        assert!(res.error.is_none());
    }

    #[test]
    fn test_complex_subshell() {
        let res = parse_shell_command("echo $(whoami)");
        assert!(res.complex);
        assert_eq!(res.segments, vec!["echo $(whoami)"]);
    }

    #[test]
    fn test_unterminated_quote() {
        let res = parse_shell_command("git commit -m \"unfinished");
        assert!(res.error.is_some());
        assert!(res.complex);
    }
}
