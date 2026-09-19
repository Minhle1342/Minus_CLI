use napi_derive::napi;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RsCompactionResult {
    pub compacted_messages_json: String,
    pub original_chars: u32,
    pub compacted_chars: u32,
    pub estimated_tokens_saved: u32,
    pub pruned_count: u32,
    pub masked_count: u32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct RawSessionMessage {
    pub role: String,
    #[serde(default)]
    pub parts: Vec<RawContentPart>,
    #[serde(flatten)]
    pub extra: Value,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct RawContentPart {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(rename = "functionCall", skip_serializing_if = "Option::is_none")]
    pub function_call: Option<Value>,
    #[serde(rename = "functionResponse", skip_serializing_if = "Option::is_none")]
    pub function_response: Option<Value>,
    #[serde(flatten)]
    pub extra: Value,
}

/// Nén ngữ cảnh hội thoại Session History trực tiếp trên Native Rust
/// Giảm thiểu tối đa việc cấp phát chuỗi tạm (transient UTF-16 objects) trong V8 Heap
pub fn compact_history_native(
    messages_json: &str,
    max_tokens: u32,
    preserve_last_n: u32,
    max_chars_per_tool: u32,
) -> RsCompactionResult {
    let original_chars = messages_json.chars().count() as u32;

    let mut messages: Vec<RawSessionMessage> = match serde_json::from_str(messages_json) {
        Ok(m) => m,
        Err(_) => {
            return RsCompactionResult {
                compacted_messages_json: messages_json.to_string(),
                original_chars,
                compacted_chars: original_chars,
                estimated_tokens_saved: 0,
                pruned_count: 0,
                masked_count: 0,
            };
        }
    };

    let total_messages = messages.len();
    if total_messages == 0 {
        return RsCompactionResult {
            compacted_messages_json: messages_json.to_string(),
            original_chars: 0,
            compacted_chars: 0,
            estimated_tokens_saved: 0,
            pruned_count: 0,
            masked_count: 0,
        };
    }

    let tool_result_indices: Vec<usize> = messages.iter().enumerate()
        .filter(|(_, msg)| msg.parts.iter().any(|part| part.function_response.is_some()))
        .map(|(idx, _)| idx)
        .collect();
    let preserve_count = (preserve_last_n as usize).min(tool_result_indices.len());
    let mask_cutoff_idx = if preserve_count == 0 {
        total_messages
    } else if tool_result_indices.len() > preserve_count {
        tool_result_indices[tool_result_indices.len() - preserve_count]
    } else {
        0
    };
    let mut masked_count = 0u32;

    // 1. Masking các tool results cũ nằm trước ngưỡng preserve_last_n
    // Đảm bảo functionResponse.response luôn là Value::Object hợp lệ với API schema
    for (idx, msg) in messages.iter_mut().enumerate() {
        if tool_result_indices.len() <= preserve_count || idx >= mask_cutoff_idx {
            continue;
        }

        for part in &mut msg.parts {
            // Kiểm tra functionResponse
            if let Some(ref mut resp) = part.function_response {
                if let Some(resp_obj) = resp.as_object_mut() {
                    if let Some(response_val) = resp_obj.get_mut("response") {
                        let response_str = response_val.to_string();
                        if response_str.len() > max_chars_per_tool as usize {
                            let path_val = response_val.get("path")
                                .or_else(|| response_val.get("filePath"))
                                .or_else(|| response_val.get("targetFile"))
                                .cloned();
                            let exit_code_val = response_val.get("exitCode").cloned();
                            let status_val = response_val.get("status").cloned();

                            let mut map = serde_json::Map::new();
                            map.insert(
                                "status".to_string(),
                                status_val.unwrap_or_else(|| Value::String("masked".to_string())),
                            );
                            if let Some(p) = path_val {
                                map.insert("path".to_string(), p);
                            }
                            if let Some(ec) = exit_code_val {
                                map.insert("exitCode".to_string(), ec);
                            }
                            map.insert(
                                "observationMask".to_string(),
                                Value::String(format!(
                                    "[OBSERVATION MASKED: Đã lược bớt {} ký tự bởi minus_core Native Compactor]",
                                    response_str.len().saturating_sub(max_chars_per_tool as usize)
                                )),
                            );
                            *response_val = Value::Object(map);
                            masked_count += 1;
                        }
                    }
                }
            }

            // Kiểm tra text part có output quá dài
            if let Some(ref mut text) = part.text {
                if text.len() > (max_chars_per_tool * 2) as usize {
                    let head_len = max_chars_per_tool as usize;
                    let mut truncated = text.chars().take(head_len).collect::<String>();
                    truncated.push_str(&format!(
                        "\n[... Đã tóm lược {} ký tự output cũ bởi minus_core ...]\n",
                        text.len().saturating_sub(max_chars_per_tool as usize)
                    ));
                    *text = truncated;
                    masked_count += 1;
                }
            }
        }
    }

    // 2. Kiểm tra nếu vẫn vượt quá ngân sách token tối đa -> Tỉa bớt các turn trung gian theo ranh giới Turn nguyên tử
    // Bảo toàn hoàn toàn cặp tool call / response invariants
    let current_chars = count_total_message_chars(&messages);
    let target_chars = (max_tokens as f64 * 3.8) as usize;
    let mut pruned_count = 0u32;

    let user_turn_indices: Vec<usize> = messages.iter().enumerate()
        .filter(|(_, msg)| msg.role == "user" && !msg.parts.iter().any(|p| p.function_response.is_some()))
        .map(|(idx, _)| idx)
        .collect();

    let preserved_turns = (preserve_last_n as usize).max(1);

    if current_chars > target_chars && user_turn_indices.len() > preserved_turns + 1 {
        let max_prunable_turn = user_turn_indices.len() - preserved_turns;
        let mut prune_until_turn_idx = 1;
        let mut chars_after_prune = current_chars;

        for k in 1..max_prunable_turn {
            let turn_start = user_turn_indices[k];
            let turn_end = user_turn_indices[k + 1];
            let turn_chars: usize = messages[turn_start..turn_end]
                .iter()
                .map(count_single_message_chars)
                .sum();
            chars_after_prune = chars_after_prune.saturating_sub(turn_chars);
            prune_until_turn_idx = k + 1;
            pruned_count += (turn_end - turn_start) as u32;

            if chars_after_prune <= target_chars {
                break;
            }
        }

        if prune_until_turn_idx > 1 {
            let turn0_end = user_turn_indices[1];
            let prune_end = user_turn_indices[prune_until_turn_idx];
            let pruned_turns_total = prune_until_turn_idx - 1;

            let mut new_messages = Vec::new();
            // Turn 0 (Goal ban đầu)
            new_messages.extend_from_slice(&messages[0..turn0_end]);

            // Rolling Synopsis cho các intermediate turns đã lược bỏ
            let turn_range_str = if pruned_turns_total == 1 {
                "TURN 1".to_string()
            } else {
                format!("TURNS 1 to {}", pruned_turns_total)
            };
            new_messages.push(RawSessionMessage {
                role: "user".to_string(),
                parts: vec![RawContentPart {
                    text: Some(format!(
                        "[ROLLING DIALOGUE SYNOPSIS - MINUS_CORE - {} ARCHIVED]: Đã lưu trữ và lược bỏ {} lượt đối thoại trung gian trước đó để tối ưu hoá ngân sách bộ nhớ.",
                        turn_range_str,
                        pruned_turns_total
                    )),
                    function_call: None,
                    function_response: None,
                    extra: Value::Object(serde_json::Map::new()),
                }],
                extra: Value::Object(serde_json::Map::new()),
            });

            // Active Preserved Tail Window
            new_messages.extend_from_slice(&messages[prune_end..]);
            messages = new_messages;
        }
    }

    let final_json = serde_json::to_string(&messages).unwrap_or_else(|_| messages_json.to_string());
    let compacted_chars = final_json.chars().count() as u32;
    let tokens_saved = ((original_chars.saturating_sub(compacted_chars) as f64) / 3.8).round() as u32;

    RsCompactionResult {
        compacted_messages_json: final_json,
        original_chars,
        compacted_chars,
        estimated_tokens_saved: tokens_saved,
        pruned_count,
        masked_count,
    }
}

fn count_single_message_chars(msg: &RawSessionMessage) -> usize {
    let mut count = msg.role.len();
    for part in &msg.parts {
        if let Some(ref t) = part.text {
            count += t.len();
        }
        if let Some(ref fc) = part.function_call {
            count += fc.to_string().len();
        }
        if let Some(ref fr) = part.function_response {
            count += fr.to_string().len();
        }
    }
    count
}

fn count_total_message_chars(messages: &[RawSessionMessage]) -> usize {
    messages.iter().map(count_single_message_chars).sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_compact_history() {
        let raw_json = r#"[
            {"role": "user", "parts": [{"text": "Hello, fix the bug"}]},
            {"role": "model", "parts": [{"functionCall": {"name": "read_file", "args": {"path": "src/index.ts"}}}]},
            {"role": "user", "parts": [{"functionResponse": {"name": "read_file", "response": {"content": "Very long content 1234567890 1234567890 1234567890 1234567890"}}}]},
            {"role": "model", "parts": [{"text": "Done analyzing"}]}
        ]"#;

        let res = compact_history_native(raw_json, 1000, 0, 20);
        assert!(res.masked_count > 0);
        assert!(res.compacted_chars < res.original_chars);
    }

    #[test]
    fn preserves_the_last_tool_result_even_when_a_later_message_exists() {
        let raw_json = r#"[
            {"role":"user","parts":[{"text":"Inspect files"}]},
            {"role":"model","parts":[{"functionCall":{"id":"old","name":"read_file"}}]},
            {"role":"user","parts":[{"functionResponse":{"id":"old","name":"read_file","response":{"content":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}}]},
            {"role":"model","parts":[{"functionCall":{"id":"current","name":"read_file"}}]},
            {"role":"user","parts":[{"functionResponse":{"id":"current","name":"read_file","response":{"content":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}}}]},
            {"role":"model","parts":[{"text":"Continue"}]}
        ]"#;

        let res = compact_history_native(raw_json, 1_000, 1, 20);
        let messages: Vec<RawSessionMessage> = serde_json::from_str(&res.compacted_messages_json).unwrap();
        let old_response = messages[2].parts[0].function_response.as_ref().unwrap();
        let current_response = messages[4].parts[0].function_response.as_ref().unwrap();

        assert!(old_response["response"].is_object());
        assert_eq!(old_response["response"]["status"], "masked");
        assert_eq!(current_response["response"]["content"], "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    }

    #[test]
    fn test_turn_pruning_preserves_tool_pairing() {
        let raw_json = r#"[
            {"role":"user","parts":[{"text":"Turn 0: Task start"}]},
            {"role":"model","parts":[{"functionCall":{"id":"c0","name":"tool0"}}]},
            {"role":"user","parts":[{"functionResponse":{"id":"c0","name":"tool0","response":{"result":"ok0"}}}]},
            {"role":"user","parts":[{"text":"Turn 1: Intermediate step"}]},
            {"role":"model","parts":[{"functionCall":{"id":"c1","name":"tool1"}}]},
            {"role":"user","parts":[{"functionResponse":{"id":"c1","name":"tool1","response":{"result":"ok1"}}}]},
            {"role":"user","parts":[{"text":"Turn 2: Final step"}]},
            {"role":"model","parts":[{"functionCall":{"id":"c2","name":"tool2"}}]},
            {"role":"user","parts":[{"functionResponse":{"id":"c2","name":"tool2","response":{"result":"ok2"}}}]}
        ]"#;

        let res = compact_history_native(raw_json, 10, 1, 1000);
        assert!(res.pruned_count > 0);
        let messages: Vec<RawSessionMessage> = serde_json::from_str(&res.compacted_messages_json).unwrap();

        assert_eq!(messages[0].parts[0].text.as_deref(), Some("Turn 0: Task start"));
        assert!(messages.iter().any(|m| m.parts.iter().any(|p| p.text.as_deref().unwrap_or("").contains("ROLLING DIALOGUE SYNOPSIS"))));
        assert!(messages.iter().any(|m| m.parts.iter().any(|p| p.text.as_deref() == Some("Turn 2: Final step"))));
    }
}
