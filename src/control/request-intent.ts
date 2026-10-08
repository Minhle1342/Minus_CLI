/** Scope the user's deliverable separately from verbs mentioned inside the code being discussed. */
export function normalizeRequestIntentText(request: string): string {
  return request
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .trim();
}

/** Shared action vocabulary for classification and mixed read/action requests. */
export const MUTATION_INTENT = /\b(?:implement|fix|change|modify|update|replace|create|delete|rename|refactor|migrate|upgrade|add|remove|write|patch|build|develop|scaffold|sua|trien khai|thuc hien|thuc thi|cap nhat|thay the|tao|xoa|doi ten|tich hop|bo sung|them|cai tien|ap dung|viet code|viet|lap trinh|xay dung|thiet ke|dung trang|lam web|tao file|viet script)\b/i;

export function isReadOnlyRequest(request: string): boolean {
  const text = normalizeRequestIntentText(request);
  if (/\b(?:read[ -]only|chi doc|khong (?:sua|chinh sua|thay doi) (?:code|ma|file)|do not (?:edit|modify|change)|don['’]t (?:edit|modify|change))\b/.test(text)) return true;
  // Bỏ qua các tiền tố slash commands như /bug-hunter, /open-code-review, /code-reviewer
  const stripped = text.replace(/^\s*(?:\/[a-z0-9_-]+\s*)+/i, '');
  const asksExplanation = /^(?:(?:please|can you|could you|hay|ban hay)\s+)?(?:explain|describe|review|compare|analy[sz]e|inspect|investigate|suggest|propose|recommend|how|why|what|where|explore|chan doan|giai thich|mo ta|kiem tra|bao cao|phan tich|danh gia|so sanh|de xuat|goi y|tai sao|vi sao|co che|cach|tim hieu|khao sat|nguyen nhan|ly do|xem xet|xem|cho biet|nghien cuu)\b/.test(stripped);
  if (!asksExplanation) return false;
  // Mixed requests that explicitly ask us to implement the proposal still need mutation evidence.
  const continuations = stripped.split(/\b(?:and then|then|and|sau do|roi|va)\b/).slice(1);
  return !continuations.some((part) => MUTATION_INTENT.test(part.replace(/^\s*(?:please|hay)\s+/, '')));
}

