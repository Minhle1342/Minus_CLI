import { Type } from '@google/genai';
import { ToolDefinition } from './types.js';

/**
 * Đơn giản hóa HTML thành Markdown súc tích
 */
export function htmlToMarkdown(html: string): string {
  let text = html;

  // Loại bỏ các thẻ script, style, svg, iframe, noscript
  text = text.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  text = text.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');
  text = text.replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, '');
  text = text.replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, '');

  // Tiêu đề
  text = text.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n');
  text = text.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n');
  text = text.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n');
  text = text.replace(/<h[4-6][^>]*>([\s\S]*?)<\/h[4-6]>/gi, '\n#### $1\n');

  // Khối mã và inline code
  text = text.replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, '\n```\n$1\n```\n');
  text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');

  // Danh sách
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n');

  // Đoạn văn và ngắt dòng
  text = text.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '\n$1\n');
  text = text.replace(/<br\s*[\/]?>/gi, '\n');
  text = text.replace(/<hr\s*[\/]?>/gi, '\n---\n');

  // Links: [Text](URL)
  text = text.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');

  // In đậm, in nghiêng
  text = text.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**');
  text = text.replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, '**$1**');
  text = text.replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, '*$1*');
  text = text.replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, '*$1*');

  // Xóa toàn bộ HTML tags còn lại
  text = text.replace(/<[^>]+>/g, '');

  // Decode các HTML entities cơ bản
  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');

  // Thu gọn khoảng trắng thừa
  text = text.replace(/\n\s+\n/g, '\n\n').replace(/\n{3,}/g, '\n\n');

  return text.trim();
}

import { Workspace } from '../workspace/workspace.js';
import { createWebFetchTool } from './web-fetch.js';

/**
 * Tool: read_url_content
 * Chuẩn Google Antigravity CLI: Đọc nội dung từ URL qua HTTP request và chuyển sang markdown.
 * Tái cấu trúc ủy nhiệm sang engine web_fetch với bộ lọc bảo mật prompt injection và code block extraction.
 */
export const readUrlContentTool: ToolDefinition = {
  name: 'read_url_content',
  description: 'Fetch content from a URL via HTTP request. Converts HTML to clean markdown for fast reading without browser overhead. (Delegates to web_fetch).',
  parameters: {
    type: Type.OBJECT,
    properties: {
      Url: {
        type: Type.STRING,
        description: 'The URL to fetch content from (e.g. "https://docs.github.com/en/rest").',
      },
      url: {
        type: Type.STRING,
        description: 'Alias for Url.',
      },
    },
    required: [],
  },
  async execute(args: Record<string, any>, workspace: Workspace = new Workspace()): Promise<Record<string, any>> {
    const targetUrl = String(args.Url || args.url || '').trim();

    if (!targetUrl) {
      return { error: 'Tham số "Url" là bắt buộc.' };
    }

    try {
      const webFetch = createWebFetchTool();
      const res = await webFetch.execute({ url: targetUrl, ...args }, workspace);
      if (res.error) {
        return {
          url: targetUrl,
          error: res.error,
          statusCode: res.statusCode,
          errorCode: res.errorCode,
        };
      }
      return {
        url: targetUrl,
        success: true,
        content: res.content,
        title: res.title,
        length: res.returnedLength || res.content?.length || 0,
        codeBlocksCount: res.codeBlocksCount,
        securityWarnings: res.securityWarnings,
      };
    } catch (err: any) {
      return {
        url: targetUrl,
        error: `Failed to fetch URL content: ${err?.message || String(err)}`,
      };
    }
  },
};
