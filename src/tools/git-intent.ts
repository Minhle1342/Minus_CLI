export type GitMutationOperation = 'stage' | 'commit' | 'push';

export interface GitMutationIntent {
  stage: boolean;
  commit: boolean;
  push: boolean;
}

const EMPTY_INTENT: GitMutationIntent = {
  stage: false,
  commit: false,
  push: false,
};

/**
 * Detects an explicit request to mutate Git state. Merely discussing whether
 * the agent supports Git must not grant execution permission.
 */
export function detectExplicitGitMutationIntent(userRequest?: string): GitMutationIntent {
  const normalized = normalizeIntentText(userRequest || '');
  if (!normalized) return { ...EMPTY_INTENT };

  const mentionsCommit = /\bcommit(?:ting|ted)?\b|\btao\s+commit\b/.test(normalized);
  const mentionsPush = /\bpush(?:ing|ed)?\b|\bday(?:\s+code)?\s+len\b|\bdua(?:\s+code)?\s+len\s+(?:repo|repository|remote|github|gitlab)\b/.test(normalized);
  const mentionsStage = /\bstage(?:d|ing)?\b|\bgit\s+add\b/.test(normalized);
  if (!mentionsCommit && !mentionsPush && !mentionsStage) return { ...EMPTY_INTENT };

  const isDirectRequest =
    /^(?:please\s+)?(?:git\s+)?(?:add|stage|commit|push)\b/.test(normalized)
    || /^(?:hay|vui long)\b/.test(normalized)
    || /\b(?:please|hay|vui long|giup toi|thuc hien)\s+(?:git\s+)?(?:add|stage|commit|push|day|dua)\b/.test(normalized)
    || /\b(?:commit|push)\b[^.!?]{0,80}\b(?:code|changes?|thay doi|nhanh|branch|repo|repository)\b/.test(normalized);

  const isCapabilityDiscussion = /\b(?:co quyen|co the tu|kha nang|ho tro|enable|allow|permission|permissions|them tool|nang cap|tai sao|why|whether)\b/.test(normalized);
  if (!isDirectRequest || (isCapabilityDiscussion && !/^(?:please|hay|vui long|commit|push|stage|git add)\b/.test(normalized))) {
    return { ...EMPTY_INTENT };
  }

  const commitNegated = /\b(?:do not|dont|without|khong|dung)\s+(?:git\s+)?commit\b/.test(normalized);
  const pushNegated = /\b(?:do not|dont|without|khong|dung)\s+(?:git\s+)?push\b/.test(normalized);
  const stageNegated = /\b(?:do not|dont|without|khong|dung)\s+(?:git\s+)?(?:add|stage)\b/.test(normalized);
  const commit = mentionsCommit && !commitNegated;

  return {
    stage: (mentionsStage && !stageNegated) || commit,
    commit,
    push: mentionsPush && !pushNegated,
  };
}

export function isGitMutationAuthorized(
  userRequest: string | undefined,
  operation: GitMutationOperation,
): boolean {
  return detectExplicitGitMutationIntent(userRequest)[operation];
}

export function isForcePushAuthorized(userRequest?: string): boolean {
  const normalized = normalizeIntentText(userRequest || '');
  return detectExplicitGitMutationIntent(userRequest).push
    && /\b(?:force(?:-with-lease)?\s+push|push\s+(?:voi\s+)?force|ep\s+push)\b/.test(normalized);
}

export function extractRequestedGitBranch(userRequest?: string): string | undefined {
  const normalized = normalizeIntentText(userRequest || '');
  if (!detectExplicitGitMutationIntent(userRequest).push) return undefined;
  const match = normalized.match(/\b(?:branch|nhanh)\s+["']?([a-z0-9._/-]+)/i);
  return match?.[1];
}

export function normalizeIntentText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
