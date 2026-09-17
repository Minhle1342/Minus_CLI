use napi_derive::napi;
use regex::Regex;
use std::fs;
use std::path::Path;
use std::sync::OnceLock;

#[napi(object)]
#[derive(Debug, Clone)]
pub struct RsSymbolDefinition {
    pub found: bool,
    pub name: String,
    pub kind: String,
    pub line: u32,
    pub character: u32,
    pub file: String,
    pub type_signature: String,
    pub is_exported: bool,
    pub doc_comment: Option<String>,
}

static SYMBOL_REGEXES: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();

fn get_symbol_regexes() -> &'static Vec<(Regex, &'static str)> {
    SYMBOL_REGEXES.get_or_init(|| {
        vec![
            // Function: export (async)? function name(params): return
            (
                Regex::new(r"^(?:\s*(export(?:\s+default)?)\s+)?(?:async\s+)?function\s+([a-zA-Z0-9_$]+)\s*(<[^>]*>)?\s*\(([^)]*)\)").unwrap(),
                "function",
            ),
            // Class: export class Name (extends ...)?
            (
                Regex::new(r"^(?:\s*(export(?:\s+default)?)\s+)?class\s+([a-zA-Z0-9_$]+)").unwrap(),
                "class",
            ),
            // Interface: export interface Name
            (
                Regex::new(r"^(?:\s*(export)\s+)?interface\s+([a-zA-Z0-9_$]+)").unwrap(),
                "interface",
            ),
            // Type alias: export type Name = ...
            (
                Regex::new(r"^(?:\s*(export)\s+)?type\s+([a-zA-Z0-9_$]+)\s*(<[^>]*>)?\s*=").unwrap(),
                "type",
            ),
            // Enum: export enum Name
            (
                Regex::new(r"^(?:\s*(export)\s+)?enum\s+([a-zA-Z0-9_$]+)").unwrap(),
                "enum",
            ),
            // Arrow function or const assignment: export const name = (async)? (params) => / function
            (
                Regex::new(r"^(?:\s*(export)\s+)?(?:const|let|var)\s+([a-zA-Z0-9_$]+)\s*(?::\s*([^=]+))?\s*=\s*(?:async\s*)?(?:\([^)]*\)|[a-zA-Z0-9_$]+)\s*=>").unwrap(),
                "function",
            ),
            // Const/Variable declaration
            (
                Regex::new(r"^(?:\s*(export)\s+)?(?:const|let|var)\s+([a-zA-Z0-9_$]+)\s*(?::\s*([^=;]+))?").unwrap(),
                "variable",
            ),
            // Method declaration in class/interface: (public|private|protected)? (async)? name(params)
            (
                Regex::new(r"^\s*(?:(?:public|private|protected|static|readonly|async|override)\s+)*([a-zA-Z0-9_$]+)\s*(<[^>]*>)?\s*\(([^)]*)\)").unwrap(),
                "method",
            ),
            // Rust fn / struct / enum / trait
            (
                Regex::new(r"^(?:\s*(pub(?:\([^)]+\))?)\s+)?(?:async\s+)?fn\s+([a-zA-Z0-9_]+)").unwrap(),
                "function",
            ),
            (
                Regex::new(r"^(?:\s*(pub(?:\([^)]+\))?)\s+)?struct\s+([a-zA-Z0-9_]+)").unwrap(),
                "struct",
            ),
            (
                Regex::new(r"^(?:\s*(pub(?:\([^)]+\))?)\s+)?enum\s+([a-zA-Z0-9_]+)").unwrap(),
                "enum",
            ),
            (
                Regex::new(r"^(?:\s*(pub(?:\([^)]+\))?)\s+)?trait\s+([a-zA-Z0-9_]+)").unwrap(),
                "interface",
            ),
            // Python def / class
            (
                Regex::new(r"^(?:\s*)def\s+([a-zA-Z0-9_]+)\s*\(([^)]*)\)").unwrap(),
                "function",
            ),
            (
                Regex::new(r"^(?:\s*)class\s+([a-zA-Z0-9_]+)").unwrap(),
                "class",
            ),
        ]
    })
}

/// Trích xuất toàn bộ symbol từ nội dung file mã nguồn với tốc độ siêu nhanh (Native Rust)
pub fn extract_file_symbols_native(file_path: &str, content: Option<&str>) -> Vec<RsSymbolDefinition> {
    let owned_content: String;
    let text = match content {
        Some(c) => c,
        None => {
            if let Ok(c) = fs::read_to_string(Path::new(file_path)) {
                owned_content = c;
                &owned_content
            } else {
                return Vec::new();
            }
        }
    };

    let regexes = get_symbol_regexes();
    let mut results = Vec::new();
    let lines: Vec<&str> = text.lines().collect();

    let mut current_doc_comment: Option<String> = None;
    let mut doc_lines: Vec<&str> = Vec::new();

    for (idx, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        let line_num = (idx + 1) as u32;

        // Xử lý doc comments (JSDoc hoặc Rust doc /// hoặc Python docstring)
        if trimmed.starts_with("/**") || trimmed.starts_with("/*") || trimmed.starts_with("///") || trimmed.starts_with("\"\"\"") {
            doc_lines.clear();
            doc_lines.push(trimmed);
            if trimmed.ends_with("*/") || (trimmed.starts_with("\"\"\"") && trimmed.len() > 3 && trimmed[3..].contains("\"\"\"")) {
                current_doc_comment = Some(doc_lines.join("\n"));
                doc_lines.clear();
            }
            continue;
        } else if !doc_lines.is_empty() {
            doc_lines.push(trimmed);
            if trimmed.ends_with("*/") || trimmed.ends_with("\"\"\"") {
                current_doc_comment = Some(doc_lines.join("\n"));
                doc_lines.clear();
            }
            continue;
        }

        if trimmed.is_empty() || trimmed.starts_with("//") || trimmed.starts_with('#') {
            if trimmed.is_empty() {
                current_doc_comment = None;
            }
            continue;
        }

        for (re, kind) in regexes {
            if let Some(caps) = re.captures(trimmed) {
                // Tên symbol thường là group cuối cùng hoặc group 2
                let (sym_name, is_exported) = if caps.len() >= 3 {
                    let export_grp = caps.get(1).map(|m| m.as_str()).unwrap_or("");
                    let name_grp = caps.get(2).map(|m| m.as_str()).unwrap_or("");
                    let is_exp = export_grp.contains("export") || export_grp.contains("pub");
                    (name_grp, is_exp)
                } else if caps.len() >= 2 {
                    let name_grp = caps.get(1).map(|m| m.as_str()).unwrap_or("");
                    (name_grp, false)
                } else {
                    ("", false)
                };

                if !sym_name.is_empty() && sym_name != "if" && sym_name != "for" && sym_name != "while" && sym_name != "switch" {
                    let char_pos = line.find(sym_name).unwrap_or(0) as u32;
                    let type_sig = trimmed.to_string();

                    results.push(RsSymbolDefinition {
                        found: true,
                        name: sym_name.to_string(),
                        kind: kind.to_string(),
                        line: line_num,
                        character: char_pos,
                        file: file_path.to_string(),
                        type_signature: type_sig,
                        is_exported,
                        doc_comment: current_doc_comment.take(),
                    });
                    break;
                }
            }
        }
    }

    results
}

/// Tìm kiếm định nghĩa chính xác của 1 symbol trong file cụ thể
pub fn find_symbol_in_file_native(
    file_path: &str,
    symbol_name: &str,
    content: Option<&str>,
) -> RsSymbolDefinition {
    let symbols = extract_file_symbols_native(file_path, content);
    for sym in symbols {
        if sym.name == symbol_name {
            return sym;
        }
    }

    RsSymbolDefinition {
        found: false,
        name: symbol_name.to_string(),
        kind: "unknown".to_string(),
        line: 0,
        character: 0,
        file: file_path.to_string(),
        type_signature: String::new(),
        is_exported: false,
        doc_comment: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_ts_symbols() {
        let code = r#"
        /**
         * Calculate summary
         */
        export function calculateTotal(a: number, b: number): number {
            return a + b;
        }

        export class UserManager {
            private id: string;
            
            getUser(): string {
                return this.id;
            }
        }

        export interface UserConfig {
            name: string;
        }
        "#;

        let symbols = extract_file_symbols_native("test.ts", Some(code));
        assert!(symbols.iter().any(|s| s.name == "calculateTotal" && s.is_exported && s.kind == "function"));
        assert!(symbols.iter().any(|s| s.name == "UserManager" && s.is_exported && s.kind == "class"));
        assert!(symbols.iter().any(|s| s.name == "UserConfig" && s.is_exported && s.kind == "interface"));
    }
}
