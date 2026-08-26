import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  getVisibleWidth,
  stripAnsiForDisplay,
  padRightVisible,
  createBoxHeader,
  createBoxDivider,
  createBoxFooter,
  formatMarkdownTerminal,
  RealtimeSlashCommandHints,
  CLI,
  colors as c,
} from './ui/cli-ui.js';
import { validateSchemaValue } from './tools/schema-validator.js';
import { applyPatchTool } from './tools/apply-patch.js';

describe('Antigravity CLI UI & Input Bug Fixes', () => {
  describe('1. Visible Width & Unicode East-Asian / Emoji calculation', () => {
    it('should calculate accurate width for plain ASCII text', () => {
      assert.strictEqual(getVisibleWidth('Hello World'), 11);
      assert.strictEqual(getVisibleWidth(''), 0);
    });

    it('should strip ANSI colors and measure only visible width', () => {
      const colored = `${c.geminiCyan}${c.bold}MINUS CLI${c.reset}`;
      assert.strictEqual(getVisibleWidth(colored), 9);

      const trueColor = `\x1b[38;2;255;100;50mCustom RGB\x1b[0m`;
      assert.strictEqual(getVisibleWidth(trueColor), 10);
    });

    it('should measure 2 columns for Emojis and Extended Pictographics', () => {
      assert.strictEqual(getVisibleWidth('🤖'), 2);
      assert.strictEqual(getVisibleWidth('🐱'), 2);
      assert.strictEqual(getVisibleWidth('🚀'), 2);
      assert.strictEqual(getVisibleWidth('⚡'), 2);
      assert.strictEqual(getVisibleWidth('🧠'), 2);
      assert.strictEqual(getVisibleWidth('🤖 Model:'), 9); // 2 + 1 + 6 = 9
    });

    it('should handle Vietnamese diacritics and combining marks accurately', () => {
      const vnText = 'Đổi workspace thành công';
      assert.strictEqual(getVisibleWidth(vnText), vnText.length);
    });

    it('should pad strings accurately using getVisibleWidth', () => {
      const padded = padRightVisible(`${c.brightCyan}Test${c.reset}`, 10);
      assert.strictEqual(getVisibleWidth(padded), 10);
    });
  });

  describe('2. Box Border Header, Divider and Footer Alignment', () => {
    it('should produce identical visible width for Box Header, Divider, and Footer (No Emoji)', () => {
      const width = 80;
      const title = 'ACTIVE WORKSPACE';
      const header = createBoxHeader(title, c.geminiBlue, width);
      const divider = createBoxDivider(c.geminiBlue, width);
      const footer = createBoxFooter(c.geminiBlue, width);

      assert.strictEqual(getVisibleWidth(header), width, 'Header width must equal targetWidth');
      assert.strictEqual(getVisibleWidth(divider), width, 'Divider width must equal targetWidth');
      assert.strictEqual(getVisibleWidth(footer), width, 'Footer width must equal targetWidth');
    });

    it('should produce identical visible width even with emojis in title', () => {
      const width = 80;
      const titleWithEmoji = '🤖 DANH SÁCH MÔ HÌNH KHẢ DỤNG (SELECT MODEL)';
      const header = createBoxHeader(titleWithEmoji, c.geminiPurple, width);
      const divider = createBoxDivider(c.geminiPurple, width);
      const footer = createBoxFooter(c.geminiPurple, width);

      assert.strictEqual(getVisibleWidth(header), width, 'Header with emoji must equal targetWidth');
      assert.strictEqual(getVisibleWidth(divider), width, 'Divider must equal targetWidth');
      assert.strictEqual(getVisibleWidth(footer), width, 'Footer must equal targetWidth');
    });

    it('should maintain alignment across narrow (60) and wide (120) terminal widths', () => {
      for (const w of [60, 75, 80, 100, 120]) {
        const header = createBoxHeader('🛠️  REGISTERED TOOLS', c.geminiGreen, w);
        const footer = createBoxFooter(c.geminiGreen, w);
        assert.strictEqual(getVisibleWidth(header), w);
        assert.strictEqual(getVisibleWidth(footer), w);
      }
    });
  });

  describe('3. Markdown Formatter Code Block & Style Preservation', () => {
    it('should preserve comments (#) inside fenced code blocks without converting to headers', () => {
      const codeBlock = '```bash\n# This is a comment\nnpm run test\n```';
      const formatted = formatMarkdownTerminal(codeBlock);
      assert.ok(!formatted.includes('══════════'), 'Should not convert # inside code blocks to header border lines');
      assert.ok(formatted.includes('# This is a comment'), 'Comment inside code block must be preserved');
    });

    it('should preserve math multiplication asterisks without turning into italics', () => {
      const text = 'Calculate result = 2 * 3 * 4 and check value.';
      const formatted = formatMarkdownTerminal(text);
      assert.ok(formatted.includes('2 * 3 * 4'), 'Math multiplication asterisks should not be removed');
    });

    it('should format normal markdown headers, bold, and bullet points properly', () => {
      const md = '# Main Title\n## Section\n- Item 1\n- Item 2\n**Bold Text**';
      const formatted = formatMarkdownTerminal(md);
      const clean = stripAnsiForDisplay(formatted);
      assert.ok(clean.includes('Main Title'));
      assert.ok(clean.includes('Section'));
      assert.ok(clean.includes('• Item 1'));
      assert.ok(clean.includes('• Item 2'));
      assert.ok(clean.includes('Bold Text'));
    });
  });

  describe('4. RealtimeSlashCommandHints Cursor & Prompt Calculation', () => {
    it('should instantiate and update without errors using dynamic prompt width', () => {
      let writtenOutput = '';
      const fakeTerminal = {
        isTTY: true,
        columns: 80,
        write: (chunk: string) => {
          writtenOutput += chunk;
        },
      };

      const promptWidth = getVisibleWidth(CLI.getPromptSymbol());
      assert.strictEqual(promptWidth, 2); // '❯ '

      const hints = new RealtimeSlashCommandHints(
        fakeTerminal,
        undefined,
        () => ({ modelName: 'gemini-3.1-flash-lite-preview', effort: 'medium' }),
        () => promptWidth,
      );

      // Update with slash command -> shows slash command suggestions and cursor restore
      hints.update('/model', 6);
      assert.ok(writtenOutput.includes('/model'));
      assert.ok(writtenOutput.includes('\x1b[2K'));
      assert.ok(writtenOutput.includes('\x1b8') || writtenOutput.includes('\x1b[u'), 'Should use ANSI cursor restore');
      assert.ok(writtenOutput.includes('A'), 'Should move cursor UP to prevent scroll drift');

      // Update with normal text -> clears hints silently without terminal escape spam
      writtenOutput = '';
      hints.update('hello world', 11);
      assert.strictEqual(writtenOutput.includes('/model'), false);

      // Clear hints
      writtenOutput = '';
      hints.clear(2);
      assert.strictEqual(writtenOutput, '');
    });
  });

  describe('5. CLI Components Resilience on Narrow & Wide Terminals', () => {
    it('should render Banner, Help, and Model Selector without throwing on any terminal width', () => {
      assert.doesNotThrow(() => {
        CLI.renderBanner({
          modelName: 'gemini-3.1-flash-lite-preview',
          workspaceRoot: process.cwd(),
          maxSteps: 30,
          tools: ['read_file', 'write_to_file', 'execute_command', 'grep_search', 'list_dir'],
        });
      });

      assert.doesNotThrow(() => {
        CLI.renderModelSelector('gemini-3.1-flash-lite-preview');
      });

      assert.doesNotThrow(() => {
        CLI.renderHelp();
      });
    });
  });

  describe('6. ToolRunner & Schema Validator for Dynamic Dictionary/Map Objects', () => {
    it('should allow dynamic file path keys in expectedFileHashes for apply_patch', () => {
      const sampleArgs = {
        patch: '--- a/src/pages/AdminPage.jsx\n+++ b/src/pages/AdminPage.jsx\n@@ -1,3 +1,3 @@\n-old\n+new\n',
        expectedFileHashes: {
          'src/pages/AdminPage.jsx': 'a1b2c3d4e5f6',
          'src/components/Header.tsx': 'f6e5d4c3b2a1',
        },
      };

      const result = validateSchemaValue(sampleArgs, applyPatchTool.parameters as any, '$', {
        rejectUnknownProperties: true,
      });

      assert.strictEqual(result.valid, true, 'Validation must pass for dynamic file path keys in expectedFileHashes');
      assert.strictEqual(result.errors.length, 0);
    });

    it('should still reject unknown top-level hallucinated parameters', () => {
      const badArgs = {
        patch: 'diff content',
        inventedProperty: true,
      };

      const result = validateSchemaValue(badArgs, applyPatchTool.parameters as any, '$', {
        rejectUnknownProperties: true,
      });

      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some((err: string) => err.includes('$.inventedProperty is not declared')));
    });
  });
});
