/**
 * A URL is an observable fact, not an inferred intent. This is the only signal
 * the harness uses to surface network capability; whether a question needs the
 * web is the model's decision.
 */
const URL_PATTERN = /(https?:\/\/[^\s]+|www\.[^\s]+\.[a-z]{2,}[^\s]*|\b[a-z0-9-]+\.(com|org|net|io|dev|vn|edu|gov)(\/[^\s]*)?)/i;

export function hasNetworkIntent(text: string | undefined | null): boolean {
  if (!text) return false;
  return URL_PATTERN.test(text);
}

/**
 * Explicit request to consult the internet ("search the web", "tra cứu mạng",
 * "latest docs online"). A URL is handled by hasNetworkIntent; this regex only
 * recognizes literal web/lookup wording so offline code tasks stay local.
 */
const WEB_INTENT_PATTERN = /\b(?:web\s*(?:search|lookup|research|browse)|search\s+(?:the\s+)?(?:web|internet|online)|(?:browse|research|look\s*up)\s+(?:the\s+)?(?:web|internet|online)|online\s+(?:docs?|documentation|article|resource|search)|internet\s+(?:search|access)|google\s+(?:for|it|this)|latest\s+(?:docs?|documentation|version)\s+online|scrape\s+(?:the\s+)?(?:web|url|site))\b|(?:tra\s+cuu|tim\s+(?:kiem\s+)?)(?:[\s-]+(?:tren|qua))?[\s-]+(?:mang|internet|web)|(?:len|truy\s+cap)\s+mang|tai\s+lieu\s+(?:tren\s+)?mang/i;

export function hasWebIntent(text: string | undefined | null): boolean {
  if (!text) return false;
  const normalized = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase();
  return WEB_INTENT_PATTERN.test(normalized);
}
