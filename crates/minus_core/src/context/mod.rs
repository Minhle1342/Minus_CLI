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

#[derive(Debug, Serialize, Deserialize)]
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
                            let head_len = (max_chars_per_tool / 2) as usize;
                            let mut truncated = response_str.chars().take(head_len).collect::<String>();
                            truncated.push_str(&format!(
                                "\n[... Đã lược bớt {} ký tự bởi minus_core Context Compactor ...]\n",
                                response_str.len().saturating_sub(max_chars_per_tool as usize)
                            ));
                            *response_val = Value::String(truncated);
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

    // 2. Kiểm tra nếu vẫn vượt quá ngân sách token tối đa -> Tỉa bớt các tin nhắn trung gian
    let mut current_chars = count_total_message_chars(&messages);
    let target_chars = (max_tokens as f64 * 3.8) as usize;
    let mut pruned_count = 0u32;

    if current_chars > target_chars && messages.len() > preserve_count + 1 {
        let mut pruned_messages = Vec::new();
        // Giữ lại tin nhắn đầu tiên (warm-start / instructions)
        pruned_messages.push(messages.remove(0));

        let available_middle = messages.len().saturating_sub(preserve_count);
        let mut skipped_idx = 0;

        while current_chars > target_chars && skipped_idx < available_middle && !messages.is_empty() {
            let removed = messages.remove(0);
            let removed_chars = count_single_message_chars(&removed);
            current_chars = current_chars.saturating_sub(removed_chars);
            pruned_count += 1;
            skipped_idx += 1;
        }

        if pruned_count > 0 {
            pruned_messages.push(RawSessionMessage {
                role: "user".to_string(),
                parts: vec![RawContentPart {
                    text: Some(format!(
                        "[ROLLING DIALOGUE SYNOPSIS - MINUS_CORE]: Đã lưu trữ và lược bỏ {} bước đối thoại trung gian trước đó để tối ưu hoá ngân sách bộ nhớ.",
                        pruned_count
                    )),
                    function_call: None,
                    function_response: None,
                    extra: Value::Object(serde_json::Map::new()),
                }],
                extra: Value::Object(serde_json::Map::new()),
            });
        }

        pruned_messages.append(&mut messages);
        messages = pruned_messages;
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

        assert!(old_response["response"].is_string());
        assert_eq!(current_response["response"]["content"], "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    }
}
