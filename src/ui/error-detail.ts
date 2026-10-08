export function formatTuiErrorDetail(rawErr: unknown, maxLen = 140): string {
  if (!rawErr) return '';
  let errStr = typeof rawErr === 'object' && rawErr !== null
    ? ((rawErr as any).message || (rawErr as any).error || JSON.stringify(rawErr))
    : String(rawErr);

  // Nếu chuỗi chứa nhiều dòng, chuẩn hóa
  const lines = errStr.split(/\r?\n/).map((l: string) => l.trim()).filter(Boolean);
  if (lines.length === 0) return '';

  // 1. Xử lý [SYSTEM EVIDENCE GATE]
  if (/\[SYSTEM EVIDENCE GATE\]/i.test(errStr)) {
    const reasonLine = lines.find((l: string) => /^-\s+|^•\s+|^(?:No successful|The request|The final answer)/i.test(l));
    if (reasonLine) {
      const cleanReason = reasonLine.replace(/^[-•]\s*/, '').trim();
      errStr = `[SYSTEM EVIDENCE GATE]: ${cleanReason}`;
    } else {
      errStr = lines[0];
    }
  }
  // 2. Xử lý [CRITIC GATE REJECTION]
  else if (/\[CRITIC GATE REJECTION/i.test(errStr)) {
    const reasonLine = lines.find((l: string) => /^(?:❌|•|\[HARD)/i.test(l));
    if (reasonLine) {
      errStr = `[CRITIC GATE]: ${reasonLine.replace(/^[❌•]\s*/, '').trim()}`;
    } else {
      errStr = lines[0];
    }
  }
  // 3. Xử lý các trường hợp chứa "Command failed: C:\...\node.exe ..."
  else if (/Command failed:\s*/i.test(errStr)) {
    // 1. Tìm dòng lỗi ngoại lệ thực sự (TypeError, SyntaxError, Error, v.v.)
    const exceptionLine = lines.find((l: string) =>
      /(?:(?:[A-Z][a-zA-Z0-9_]*Error|Error|FATAL ERROR|ERR_[A-Z0-9_]+)(?:\s*\[[^\]]+\])?:\s*[^\n]+)/.test(l) &&
      !/^Command failed:\s*/i.test(l)
    );

    if (exceptionLine) {
      // Nếu có tiền tố như "Script execution failed with exit code X: Command failed: ...", giữ tiền tố thoát code
      const exitCodePrefix = errStr.match(/^(?:Script execution failed with exit code \d+|Command failed with exit code \d+):/i);
      errStr = exitCodePrefix ? `${exitCodePrefix[0]} ${exceptionLine}` : exceptionLine;
    } else {
      // Tìm dòng không phải command invocation, không phải stack trace
      const nonCmdLines = lines.filter((l: string) => !/^Command failed:\s*/i.test(l) && !/^at\s+/i.test(l) && !/^\^/i.test(l) && !/^Node\.js v/i.test(l));
      if (nonCmdLines.length > 0) {
        const exitCodePrefix = errStr.match(/^(?:Script execution failed with exit code \d+|Command failed with exit code \d+):/i);
        errStr = exitCodePrefix ? `${exitCodePrefix[0]} ${nonCmdLines[0]}` : nonCmdLines[0];
      } else {
        // Nếu chỉ có 1 dòng Command failed, loại bỏ đường dẫn thư mục tuyệt đối dài dòng
        // VD: Command failed: C:\Program Files\nodejs\node.exe D:\path\file.mjs -> Command failed: node.exe file.mjs
        errStr = errStr.replace(/Command failed:\s*"?.*[/\\]([a-zA-Z0-9_.-]+(?:\.exe)?)"?/i, 'Command failed: $1');
      }
    }
  }

  // Chuyển toàn bộ ký tự xuống dòng thành dấu cách để đảm bảo output luôn nằm gọn trên 1 dòng
  const singleLine = errStr.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
  if (singleLine.length <= maxLen) {
    return singleLine;
  }
  return `${singleLine.slice(0, maxLen - 1)}…`;
}

