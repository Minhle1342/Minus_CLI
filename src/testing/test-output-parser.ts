import { StructuredTestReport, TestCaseDetail, TestFrameworkType } from './types.js';

/**
 * TestOutputParser - Bộ Phân tích Kết quả Kiểm thử Đa Ngôn ngữ (Codex Standard)
 */
export class TestOutputParser {
  /**
   * Tự động nhận diện framework và trích xuất cấu trúc báo cáo kiểm thử
   */
  static parse(
    rawOutput: string,
    exitCode: number,
    durationMs: number,
    commandExecuted: string,
    frameworkHint?: TestFrameworkType
  ): StructuredTestReport {
    const text = rawOutput || '';
    const framework = frameworkHint || this.detectFrameworkFromOutput(text, commandExecuted);

    let totalTests = 0;
    let passed = 0;
    let failed = 0;
    let skipped = 0;
    const testCases: TestCaseDetail[] = [];

    switch (framework) {
      case 'vitest':
      case 'jest': {
        // Ví dụ: Tests: 12 passed, 2 failed, 14 total
        const testsLine = text.match(/Tests:\s+([^\n\r]+)/i);
        if (testsLine) {
          const passMatch = testsLine[1].match(/(\d+)\s+passed/i);
          const failMatch = testsLine[1].match(/(\d+)\s+failed/i);
          const skipMatch = testsLine[1].match(/(\d+)\s+skipped/i);
          const totalMatch = testsLine[1].match(/(\d+)\s+total/i);

          passed = passMatch ? parseInt(passMatch[1], 10) : 0;
          failed = failMatch ? parseInt(failMatch[1], 10) : 0;
          skipped = skipMatch ? parseInt(skipMatch[1], 10) : 0;
          totalTests = totalMatch ? parseInt(totalMatch[1], 10) : (passed + failed + skipped);
        }
        break;
      }

      case 'mocha': {
        // Ví dụ: 12 passing (350ms), 2 failing
        const passMatch = text.match(/(\d+)\s+passing/i);
        const failMatch = text.match(/(\d+)\s+failing/i);
        const pendingMatch = text.match(/(\d+)\s+pending/i);

        passed = passMatch ? parseInt(passMatch[1], 10) : 0;
        failed = failMatch ? parseInt(failMatch[1], 10) : 0;
        skipped = pendingMatch ? parseInt(pendingMatch[1], 10) : 0;
        totalTests = passed + failed + skipped;
        break;
      }

      case 'pytest': {
        // Ví dụ: ====== 12 passed, 2 failed, 1 skipped in 0.45s ======
        const summaryMatch = text.match(/===+([^\n\r]+)===+/i);
        if (summaryMatch) {
          const passMatch = summaryMatch[1].match(/(\d+)\s+passed/i);
          const failMatch = summaryMatch[1].match(/(\d+)\s+failed/i);
          const skipMatch = summaryMatch[1].match(/(\d+)\s+skipped/i);

          passed = passMatch ? parseInt(passMatch[1], 10) : 0;
          failed = failMatch ? parseInt(failMatch[1], 10) : 0;
          skipped = skipMatch ? parseInt(skipMatch[1], 10) : 0;
          totalTests = passed + failed + skipped;
        }
        break;
      }

      case 'cargotest': {
        // Ví dụ: test result: ok. 12 passed; 0 failed; 0 ignored
        const match = text.match(/test result:\s+(\w+)\.\s+(\d+)\s+passed;\s+(\d+)\s+failed;\s+(\d+)\s+ignored/i);
        if (match) {
          passed = parseInt(match[2], 10);
          failed = parseInt(match[3], 10);
          skipped = parseInt(match[4], 10);
          totalTests = passed + failed + skipped;
        }
        break;
      }

      case 'gotest': {
        const passMatches = text.match(/--- PASS:/g);
        const failMatches = text.match(/--- FAIL:/g);
        passed = passMatches ? passMatches.length : 0;
        failed = failMatches ? failMatches.length : 0;
        totalTests = passed + failed;
        break;
      }

      default: {
        // Fallback dựa trên exitCode
        if (exitCode === 0) {
          passed = 1;
          totalTests = 1;
        } else {
          failed = 1;
          totalTests = 1;
        }
      }
    }

    const isPassed = exitCode === 0 && failed === 0;
    const summaryText = isPassed
      ? `✅ [Test Engineering]: Toàn bộ ${totalTests || passed} test cases đã VƯỢT QUA thành công (${durationMs}ms).`
      : `❌ [Test Engineering]: Phát hiện ${failed} test thất bại (Exit code: ${exitCode}, Thời gian: ${durationMs}ms).`;

    return {
      framework,
      totalTests: totalTests || (passed + failed + skipped),
      passed,
      failed,
      skipped,
      durationMs,
      exitCode,
      rawOutput: text,
      testCases,
      isPassed,
      summaryText,
      timestamp: new Date().toISOString(),
      commandExecuted,
    };
  }

  private static detectFrameworkFromOutput(output: string, command: string): TestFrameworkType {
    const cmd = (command || '').toLowerCase();
    const text = output || '';

    if (cmd.includes('vitest') || text.includes('VITEST')) return 'vitest';
    if (cmd.includes('jest') || text.includes('Jest:')) return 'jest';
    if (cmd.includes('mocha') || text.includes('passing (') || text.includes('failing')) return 'mocha';
    if (cmd.includes('pytest') || text.includes('pytest')) return 'pytest';
    if (cmd.includes('cargo test') || text.includes('test result:')) return 'cargotest';
    if (cmd.includes('go test')) return 'gotest';
    if (cmd.includes('npm test') || cmd.includes('npm run test')) return 'npm';

    return 'unknown';
  }
}
