use napi_derive::napi;
use std::collections::HashSet;
use tree_sitter::{Node, Parser};

#[napi(object)]
pub struct RsRustRelation {
    pub target: String,
    pub relation: String,
    pub weight: f64,
    pub target_path: Option<String>,
}

#[napi(object)]
pub struct RsRustSymbol {
    pub name: String,
    pub qualified_name: String,
    pub kind: String,
    pub start_line: u32,
    pub end_line: u32,
    pub signature: String,
    pub outgoing_calls: Vec<String>,
    pub types_referenced: Vec<String>,
    pub graph_edges: Vec<RsRustRelation>,
}

#[napi(object)]
pub struct RsRustCode {
    pub symbols: Vec<RsRustSymbol>,
    pub imports: Vec<String>,
    pub has_error: bool,
}

pub fn parse_rust_code_native(source: &str) -> RsRustCode {
    let mut parser = Parser::new();
    if parser.set_language(&tree_sitter_rust::LANGUAGE.into()).is_err() {
        return RsRustCode { symbols: Vec::new(), imports: Vec::new(), has_error: true };
    }
    let Some(tree) = parser.parse(source, None) else {
        return RsRustCode { symbols: Vec::new(), imports: Vec::new(), has_error: true };
    };
    let root = tree.root_node();
    let mut result = RsRustCode { symbols: Vec::new(), imports: Vec::new(), has_error: root.has_error() };
    let mut impl_relations = Vec::new();
    visit(root, source, &[], &mut result, &mut impl_relations);
    for (owner, trait_name) in impl_relations {
        if let Some(symbol) = result.symbols.iter_mut().find(|symbol| symbol.name == owner && symbol.kind == "class") {
            if !symbol.types_referenced.contains(&trait_name) { symbol.types_referenced.push(trait_name.clone()); }
            symbol.graph_edges.push(RsRustRelation { target: trait_name, relation: "implements".into(), weight: 1.2, target_path: None });
        }
    }
    result.imports.sort();
    result.imports.dedup();
    result.symbols.sort_by(|a, b| a.start_line.cmp(&b.start_line).then(a.end_line.cmp(&b.end_line)).then(a.name.cmp(&b.name)));
    result
}

fn visit(node: Node<'_>, source: &str, owners: &[String], result: &mut RsRustCode, impl_relations: &mut Vec<(String, String)>) {
    if node.is_error() || node.kind() == "ERROR" || node.kind().contains("macro") { return; }
    if node.kind() == "use_declaration" {
        let statement = text(node, source).trim();
        let raw = statement.find("use ").map(|offset| &statement[offset + 4..]).unwrap_or(statement).trim_end_matches(';').trim();
        if !raw.is_empty() { result.imports.push(raw.to_string()); }
    }
    if node.kind() == "mod_item" && text(node, source).trim_end().ends_with(';') {
        if let Some(name) = node.child_by_field_name("name") {
            let module_path = owners.iter().map(String::as_str).chain(std::iter::once(text(name, source)))
                .collect::<Vec<_>>().join("::");
            result.imports.push(format!("self::{module_path}"));
        }
    }
    let kind = match node.kind() {
        "function_item" => Some(if owners.is_empty() { "function" } else { "method" }),
        "struct_item" => Some("class"),
        "enum_item" | "type_item" | "union_item" => Some("type"),
        "trait_item" => Some("interface"),
        _ => None,
    };
    if kind.is_some() && node.has_error() { return; }
    if let Some(kind) = kind {
        if let Some(name_node) = node.child_by_field_name("name") {
            let name = text(name_node, source).to_string();
            let qualified_name = if owners.is_empty() { name.clone() } else { format!("{}.{}", owners.join("."), name) };
            let header = text(node, source).lines().next().unwrap_or("").trim();
            let signature = header.chars().take(240).collect();
            let (calls, types, qualified_calls) = collect_relations(node, source, &name);
            let mut edges = Vec::new();
            for call in &calls {
                let paths: Vec<_> = qualified_calls.iter().filter(|(target, _)| target == call).collect();
                if paths.is_empty() {
                    edges.push(RsRustRelation { target: call.clone(), relation: "calls".into(), weight: 1.0, target_path: None });
                } else {
                    for (_, target_path) in paths {
                        edges.push(RsRustRelation { target: call.clone(), relation: "calls".into(), weight: 1.0, target_path: Some(target_path.clone()) });
                    }
                }
            }
            for ty in &types {
                if !calls.contains(ty) {
                    edges.push(RsRustRelation { target: ty.clone(), relation: "uses_type".into(), weight: 0.8, target_path: None });
                }
            }
            result.symbols.push(RsRustSymbol {
                name, qualified_name, kind: kind.into(),
                start_line: node.start_position().row as u32 + 1,
                end_line: node.end_position().row as u32 + if node.end_position().column == 0 { 0 } else { 1 },
                signature, outgoing_calls: calls, types_referenced: types, graph_edges: edges,
            });
        }
    }

    let mut child_owners = owners.to_vec();
    match node.kind() {
        "mod_item" | "trait_item" | "struct_item" | "enum_item" => {
            if let Some(name) = node.child_by_field_name("name") { child_owners.push(text(name, source).to_string()); }
        }
        "impl_item" => {
            let header = text(node, source).split('{').next().unwrap_or("").trim();
            let impl_header = header.trim_start_matches("impl").trim();
            let target = impl_header.split(" for ").last().unwrap_or(impl_header).trim();
            let target = target.split_whitespace().last().unwrap_or(target);
            let name = target.rsplit("::").next().unwrap_or(target).split('<').next().unwrap_or(target).trim();
            if !name.is_empty() {
                child_owners.push(name.to_string());
                if let Some((trait_path, _)) = impl_header.split_once(" for ") {
                    let trait_name = trait_path.rsplit("::").next().unwrap_or(trait_path).trim();
                    if !trait_name.is_empty() { impl_relations.push((name.to_string(), trait_name.to_string())); }
                }
            }
        }
        _ => {}
    }
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        visit(child, source, &child_owners, result, impl_relations);
    }
}

fn collect_relations(node: Node<'_>, source: &str, own_name: &str) -> (Vec<String>, Vec<String>, Vec<(String, String)>) {
    let mut calls = Vec::new();
    let mut types = Vec::new();
    let mut qualified_calls = Vec::new();
    let mut seen_calls = HashSet::new();
    let mut seen_types = HashSet::new();
    collect_descendants(node, source, own_name, &mut calls, &mut types, &mut qualified_calls, &mut seen_calls, &mut seen_types);
    calls.truncate(50);
    types.truncate(30);
    (calls, types, qualified_calls)
}

fn collect_descendants(node: Node<'_>, source: &str, own_name: &str, calls: &mut Vec<String>, types: &mut Vec<String>, qualified_calls: &mut Vec<(String, String)>, seen_calls: &mut HashSet<String>, seen_types: &mut HashSet<String>) {
    if node.is_error() || node.kind() == "ERROR" || node.kind().contains("macro") { return; }
    if node.kind() == "call_expression" {
        if let Some(callee) = node.child_by_field_name("function") {
            let raw = text(callee, source);
            let name = raw.rsplit("::").next().unwrap_or(raw).rsplit('.').next().unwrap_or(raw).trim();
            if !name.is_empty() && name != own_name {
                if seen_calls.insert(name.to_string()) { calls.push(name.to_string()); }
                if let Some((target_path, _)) = raw.rsplit_once("::") {
                    let pair = (name.to_string(), target_path.to_string());
                    if !qualified_calls.contains(&pair) { qualified_calls.push(pair); }
                }
            }
        }
    }
    if node.kind() == "type_identifier" {
        let name = text(node, source);
        if name != own_name && seen_types.insert(name.to_string()) { types.push(name.to_string()); }
    }
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        collect_descendants(child, source, own_name, calls, types, qualified_calls, seen_calls, seen_types);
    }
}

fn text<'a>(node: Node<'_>, source: &'a str) -> &'a str {
    source.get(node.byte_range()).unwrap_or("")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_rust_symbols_and_calls() {
        let parsed = parse_rust_code_native("use crate::crypto::hash;\ntrait Runner { fn run(&self); }\nstruct Service;\nimpl Runner for Service { fn run(&self) { hash(1); } }\n");
        assert!(!parsed.has_error);
        assert!(parsed.imports.iter().any(|item| item == "crate::crypto::hash"));
        assert!(parsed.symbols.iter().any(|item| item.qualified_name == "Service.run" && item.outgoing_calls.contains(&"hash".to_string())));
        assert!(parsed.symbols.iter().any(|item| item.name == "Service" && item.graph_edges.iter().any(|edge| edge.target == "Runner" && edge.relation == "implements")));
    }

    #[test]
    fn malformed_item_does_not_hide_valid_unicode_source() {
        let parsed = parse_rust_code_native("// kiểm tra\nfn valid() { println!(\"xin chào\"); }\nfn broken( {\n");
        assert!(parsed.has_error);
        assert!(parsed.symbols.iter().any(|item| item.name == "valid" && item.start_line == 2));
        assert!(!parsed.symbols.iter().any(|item| item.name == "broken"));
    }

    #[test]
    fn external_modules_and_qualified_calls_keep_their_paths() {
        let parsed = parse_rust_code_native("mod crypto;\nmod other;\nmod nested { mod inner; }\nfn run() { crypto::hash(); other::hash(); println!(\"ignore\"); }\n");
        assert!(!parsed.has_error);
        assert!(parsed.imports.contains(&"self::crypto".to_string()));
        assert!(parsed.imports.contains(&"self::other".to_string()));
        assert!(parsed.imports.contains(&"self::nested::inner".to_string()));
        let run = parsed.symbols.iter().find(|symbol| symbol.name == "run").unwrap();
        let paths: Vec<_> = run.graph_edges.iter().filter(|edge| edge.target == "hash")
            .map(|edge| edge.target_path.as_deref()).collect();
        assert_eq!(paths, vec![Some("crypto"), Some("other")]);
        assert!(!run.outgoing_calls.contains(&"println".to_string()));
    }
}
