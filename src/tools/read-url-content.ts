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

/**
 * Tool: read_url_content
 * Chuẩn Google Antigravity CLI: Đọc nội dung từ URL qua HTTP request và chuyển sang markdown.
 */
export const readUrlContentTool: ToolDefinition = {
  name: 'read_url_content',
  description: 'Fetch content from a URL via HTTP request. Converts HTML to clean markdown for fast reading without browser overhead.',
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
  async execute(args: Record<string, any>): Promise<Record<string, any>> {
    const targetUrl = String(args.Url || args.url || '').trim();

    if (!targetUrl) {
      return { error: 'Tham số "Url" là bắt buộc.' };
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 12000);

      const res = await fetch(targetUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7',
        },
      });
      clearTimeout(timeoutId);

      if (!res.ok) {
        return {
          url: targetUrl,
          error: `HTTP request failed with status: ${res.status} ${res.statusText}`,
          statusCode: res.status,
        };
      }

      const rawHtml = await res.text();
      const markdown = htmlToMarkdown(rawHtml);

      // Cắt bớt nếu quá 40,000 ký tự
      const maxLength = 40000;
      const truncated = markdown.length > maxLength
        ? markdown.slice(0, maxLength) + `\n\n[... Truncated ${markdown.length - maxLength} characters ...]`
        : markdown;

      return {
        url: targetUrl,
        success: true,
        content: truncated,
        length: truncated.length,
      };
    } catch (err: any) {
      return {
        url: targetUrl,
        error: `Failed to fetch URL content: ${err.message}`,
      };
    }
  },
};
