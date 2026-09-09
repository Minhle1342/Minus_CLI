/** Scope the user's deliverable separately from verbs mentioned inside the code being discussed. */
export function isReadOnlyRequest(request: string): boolean {
  const text = request.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toLowerCase().trim();
  if (/\b(?:read[ -]only|chi doc|khong (?:sua|chinh sua|thay doi) (?:code|ma|file)|do not (?:edit|modify|change)|don['’]t (?:edit|modify|change))\b/.test(text)) return true;
  const asksExplanation = /^(?:(?:please|can you|could you|hay|ban hay)\s+)?(?:explain|describe|review|compare|analy[sz]e|inspect|investigate|suggest|propose|recommend|how|why|what|where|giai thich|mo ta|phan tich|danh gia|so sanh|de xuat|goi y|tai sao|vi sao|co che|cach|tim hieu|khao sat)\b/.test(text);
  if (!asksExplanation) return false;
  // Mixed requests that explicitly ask us to implement the proposal still need mutation evidence.
  return !/\b(?:then|and then|and|sau do|roi|va)\s+(?:(?:please|hay)\s+)?(?:implement|fix|modify|edit|apply|create|delete|refactor|write|patch|trien khai|thuc thi|sua|chinh sua|ap dung|tao|xoa|viet)\b/.test(text);
}
