// Shared network-intent signal: one place decides when web_search/web_fetch become visible.
const URL_PATTERN = /(https?:\/\/[^\s]+|www\.[^\s]+\.[a-z]{2,}[^\s]*|\b[a-z0-9-]+\.(com|org|net|io|dev|vn|edu|gov)(\/[^\s]*)?)/i;
// Note: bare "current" excluded — "current implementation" is local, not web.
const WEB_SIGNAL = /\b(web|internet|online|browse|research|latest|news|url|website|citation|external|documentation|docs|link|github\.com|stackoverflow)\b|trực tuyến|mới nhất|hiện tại|tài liệu|trang web|đường link|liên kết|tìm trên mạng|tìm kiếm web|tra cứu|search web|fetch.*url|đọc.*link|mở.*link/i;

export function hasNetworkIntent(text: string | undefined | null): boolean {
  if (!text) return false;
  return URL_PATTERN.test(text) || WEB_SIGNAL.test(text);
}
