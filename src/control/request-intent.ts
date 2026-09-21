/** Scope the user's deliverable separately from verbs mentioned inside the code being discussed. */
export function normalizeRequestIntentText(request: string): string {
  return request
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .trim();
}

export function isReadOnlyRequest(request: string): boolean {
  const text = normalizeRequestIntentText(request);
  if (/\b(?:read[ -]only|chi doc|khong (?:sua|chinh sua|thay doi) (?:code|ma|file)|do not (?:edit|modify|change)|don['’]t (?:edit|modify|change))\b/.test(text)) return true;
  // Bỏ qua các tiền tố slash commands như /bug-hunter, /open-code-review, /code-reviewer
  const stripped = text.replace(/^\s*(?:\/[a-z0-9_-]+\s*)+/i, '');
  const asksExplanation = /^(?:(?:please|can you|could you|hay|ban hay)\s+)?(?:explain|describe|review|compare|analy[sz]e|inspect|investigate|suggest|propose|recommend|how|why|what|where|explore|chan doan|giai thich|mo ta|kiem tra|bao cao|phan tich|danh gia|so sanh|de xuat|goi y|tai sao|vi sao|co che|cach|tim hieu|khao sat|nguyen nhan|ly do|xem xet|xem|cho biet|nghien cuu)\b/.test(stripped);
  if (!asksExplanation) return false;
  // Mixed requests that explicitly ask us to implement the proposal still need mutation evidence.
  return !/\b(?:then|and then|and|sau do|roi|va)\s+(?:(?:please|hay)\s+)?(?:implement|fix|modify|edit|replace|apply|create|delete|refactor|write|patch|trien khai|thuc thi|sua|chinh sua|thay the|ap dung|tao|xoa|viet)\b/.test(stripped);
}

