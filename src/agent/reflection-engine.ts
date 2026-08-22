export interface ToolExecutionFeedback {
  toolName: string;
  args: Record<string, any>;
  result: Record<string, any>;
  durationMs: number;
}

export interface ReflectionAnalysis {
  isFailure: boolean;
  reflectionPrompt?: string;
  consecutiveFailures: number;
  advice?: string;
}

/**
 * ReflectionEngine - Động cơ Tự vấn & Quy trình Gỡ lỗi Thông minh (Debugging Protocol)
 * 
 * Ngăn chặn tình trạng Agent "đoán mò" và lặp lại thao tác sai:
 * 1. Nhận diện các thất bại khi chạy lệnh (exitCode !== 0) hoặc lỗi sửa file.
 * 2. Tự động sinh ra hướng dẫn Debugging Protocol có cấu trúc cho LLM.
 * 3. Đếm số lần thất bại liên tiếp và cảnh báo khi Agent đi vào ngõ cụt.
 */
export class ReflectionEngine {
  private consecutiveFailures: number = 0;
  private maxConsecutiveFailuresBeforeWarning: number = 2;

  /**
   * Phân tích kết quả thực thi của Tool và xác định xem có cần kích hoạt Self-Reflection hay không
   */
  analyze(feedback: ToolExecutionFeedback): ReflectionAnalysis {
    const { toolName, result } = feedback;
    let isFailure = false;
    let reflectionPrompt: string | undefined;
    let advice: string | undefined;

    const environmentFailureCodes = new Set([
      'COMMAND_NOT_FOUND',
      'COMMAND_NOT_EXECUTABLE',
      'COMMAND_TIMEOUT',
      'COMMAND_RESOURCE_LIMIT',
      'NATIVE_DEPENDENCY_MISSING',
      'PACKAGE_DEPENDENCY_MISSING',
      'MULTIPLE_RUNTIMES_REQUIRED',
      'RUNTIME_SANDBOX_INIT_FAILED',
    ]);

    // 1. Lỗi môi trường/runtime cần hướng dẫn khắc phục, không phải phân tích stack trace mã nguồn.
    if (toolName === 'run_command' && environmentFailureCodes.has(result.errorCode)) {
      isFailure = true;
      this.consecutiveFailures++;
      const details = result.diagnostic || result.stderr || result.errorCode;
      const suggestion = result.suggestion || 'Correct the execution environment before retrying.';
      reflectionPrompt = [
        `\n⚠️ [EXECUTION ENVIRONMENT FAILURE - ${result.errorCode}]`,
        details,
        `👉 ${suggestion}`,
        `Do not inspect application stack traces or retry the same command unchanged because the process did not start successfully.`,
      ].join('\n');
      advice = `${result.errorCode}: ${details}`;
    }
    // 2. Phân tích lệnh run_command thất bại (test failed, build error, syntax error)
    else if (toolName === 'run_command' && result.exitCode !== undefined && result.exitCode !== 0) {
      isFailure = true;
      this.consecutiveFailures++;

      const errorSnippet = (result.stderr || result.stdout || '').trim().slice(0, 1000);

      reflectionPrompt = [
        `\n⚠️ [DEBUGGING PROTOCOL TRIGGERED - LỆNH THỰC THI THẤT BẠI (Exit Code: ${result.exitCode})]`,
        `Chi tiết lỗi:`,
        `----------------------------------------`,
        errorSnippet || '(Không có stderr)',
        `----------------------------------------`,
        `👉 QUY TRÌNH TỰ VẤN (SELF-REFLECTION):`,
        `1. [Đọc Stack Trace]: Xác định chính xác file và dòng code nào gây ra lỗi ở trên.`,
        `2. [Kiểm tra Diff]: Sử dụng git_diff hoặc read_file để quan sát lại những gì bạn vừa sửa.`,
        `3. [Đưa ra giả thuyết]: Nêu rõ nguyên nhân gốc rễ (Root Cause) trong suy nghĩ trước khi sửa tiếp.`,
        `4. [Không lặp lại lỗi]: Tuyệt đối KHÔNG chạy lại thao tác giống hệt bước vừa rồi!`,
      ].join('\n');

      advice = `Lệnh thất bại (exit: ${result.exitCode}). Kích hoạt quy trình tự vấn và phân tích Stack Trace.`;
    } 
    // 3. Phân tích lỗi sửa file replace_text không khớp
    else if (toolName === 'replace_text' && result.error) {
      isFailure = true;
      this.consecutiveFailures++;

      const suggestedRead = result.suggestedRead
        ? `Gọi read_file với đúng tham số: ${JSON.stringify(result.suggestedRead)}.`
        : 'Gọi read_file trên một khoảng dòng hẹp với includeLineNumbers=false.';

      reflectionPrompt = [
        `\n⚠️ [SELF-REFLECTION - THAY THẾ TEXT THẤT BẠI]`,
        `Mã lỗi: ${result.errorCode || 'REPLACE_TEXT_FAILED'}`,
        `Lý do: ${result.error}`,
        `👉 ${suggestedRead}`,
        `Dùng content nguyên bản không có số dòng làm oldText, truyền contentHash thành expectedFileHash, và không lặp lại nguyên tham số vừa thất bại.`,
        `Không sao chép phần preview trên CLI; nhãn "preview only" nghĩa là chỉ phần hiển thị bị rút gọn.`,
      ].join('\n');

      advice = `replace_text thất bại (${result.errorCode || 'unknown'}). Cần đọc lại đúng vùng file trước khi thử với tham số mới.`;
    }
    // 4. Phân tích lỗi chung khác
    else if (result.error || result.errorCode) {
      isFailure = true;
      this.consecutiveFailures++;

      reflectionPrompt = [
        `\n⚠️ [TOOL EXECUTION ERROR]`,
        `Lỗi gặp phải: ${result.error || result.errorCode}`,
        `👉 Hãy phân tích nguyên nhân và điều chỉnh lại tham số gọi tool.`,
      ].join('\n');

      advice = `Tool gặp lỗi: ${result.error || result.errorCode}`;
    } 
    // 5. Nếu thành công -> Reset bộ đếm thất bại liên tiếp
    else {
      this.consecutiveFailures = 0;
    }

    // Cảnh báo nếu Agent thất bại liên tiếp nhiều lần
    if (this.consecutiveFailures >= this.maxConsecutiveFailuresBeforeWarning && isFailure) {
      reflectionPrompt += `\n🚨 [CẢNH BÁO]: Bạn đã thất bại ${this.consecutiveFailures} lần liên tiếp! Hãy dừng lại, đánh giá lại toàn bộ chiến lược hoặc chia nhỏ bài toán thành các sub-tasks đơn giản hơn.`;
    }

    return {
      isFailure,
      reflectionPrompt,
      consecutiveFailures: this.consecutiveFailures,
      advice,
    };
  }

  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  reset(): void {
    this.consecutiveFailures = 0;
  }
}
