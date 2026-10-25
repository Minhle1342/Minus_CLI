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
