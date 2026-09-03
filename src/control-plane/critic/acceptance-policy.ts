import type { DiagnosticSnapshot, ChangedFileState } from '../control-plane-state.js';

const OPTIONAL_OFFER_PATTERN = /(?:if you (?:want|would like)|if needed|neu ban (?:muon|can)|neu can)[^.!?\n]{0,180}/g;

const DEFERRED_WORK_PATTERNS = [
  // 1. English: Subject + future modal + verbs
  /\b(?:i|we|agent|assistant)\s+(?:will|shall|am going to|are going to|plan to|aim to|need to|intend to|am about to|will now|shall now|will proceed to|will start to|will begin to|will move on to|will go ahead and|will next|am ready to)\s+(?:now\s+)?(?:continue|proceed|retry|try|run|execute|test|benchmark|measure|inspect|investigate|switch|use|fix|check|analy[sz]e|work|implement|develop|create|write|code|design|redesign|refactor|modify|update|edit|change|patch|build|construct|generate|add|remove|delete|setup|configure|install)\b/i,

  // 2. English contractions (I'll, We'll, I'm going to)
  /\b(?:i'll|we'll|i'm going to|we're going to|i'm about to)\s+(?:now\s+)?(?:continue|proceed|retry|try|run|execute|test|benchmark|measure|inspect|investigate|switch|use|fix|check|analy[sz]e|work|implement|develop|create|write|code|design|redesign|refactor|modify|update|edit|change|patch|build|construct|generate|add|remove|delete|setup|configure|install)\b/i,

  // 3. English temporal sequence transitions ("Now I will...", "Next, I will...")
  /\b(?:now|next|then|in the next step|moving forward|going forward)\s*,?\s*(?:i|we|agent)?\s*(?:will|shall|am going to|plan to|proceed to|start to|begin to)\s+(?:continue|proceed|retry|try|run|execute|test|benchmark|measure|inspect|investigate|switch|use|fix|check|analy[sz]e|work|implement|develop|create|write|code|design|redesign|refactor|modify|update|edit|change|patch|build|construct|generate|add|remove|delete|setup|configure|install)\b/i,

  // 4. Vietnamese subject + future modal + verbs
  /\b(?:toi|chung toi|minh|em|agent)\s+(?:se|can phai|can|du dinh|chuan bi|dang chuan bi|du kien|len ke hoach|se tien hanh|se bat dau|se bat tay vao|se di vao)\s+(?:ngay\s+)?(?:tiep tuc|thu|chay|thuc hien|kiem thu|test|do|benchmark|kiem tra|dieu tra|chuyen|su dung|sua|phan tich|lam|tien hanh|thiet ke|thiet ke lai|trien khai|viet|code|tao|xay dung|chinh sua|sua doi|cap nhat|thay the|them|xoa|cai dat|cau hinh|refactor|tai cau truc|implement|debug|chuan doan)\b/i,

  // 5. Vietnamese temporal sequence transitions ("Bây giờ tôi sẽ...", "Tiếp theo tôi sẽ...")
  /\b(?:bay gio|gio|luc nay|hien tai|tiep theo|ke tiep|buoc tiep theo|sau day|sau do)\s*,?\s*(?:toi|chung toi|minh|em|agent)?\s*(?:se|can|chuan bi|du dinh|tien hanh|bat dau)\s+(?:tiep tuc|thu|chay|thuc hien|kiem thu|test|do|benchmark|kiem tra|dieu tra|chuyen|su dung|sua|phan tich|lam|tien hanh|thiet ke|thiet ke lai|trien khai|viet|code|tao|xay dung|chinh sua|sua doi|cap nhat|thay the|them|xoa|cai dat|cau hinh|refactor|tai cau truc|implement|debug|chuan doan)\b/i,

  // 6. Vietnamese explicit action intention without subject
  /\b(?:se|chuan bi|du dinh)\s+(?:tien hanh|bat dau|trien khai|thuc hien|bat tay vao)\s+(?:thiet ke|thiet ke lai|viet|code|tao|xay dung|chinh sua|sua|cap nhat|thay the|them|xoa|cai dat|cau hinh|refactor|kiem thu|test|chay|khao sat|kiem tra|doc)\b/i,

  // 7. General promise to execute
  /\b(?:se|can)\s+tiep tuc\s+(?:bang cach|xu ly|thuc hien|chay|kiem tra|dieu tra|sua|test|do|trien khai|thiet ke|viet|code)\b/i,
];

const FULFILLED_INTRO_PATTERN = /^\s*(?:toi|chung toi|minh|em|i|we|agent)?\s*(?:se|will|shall|am going to|plan to)?[^\n]{0,140}?(?:duoi day la|ket qua|here is|here are|below is|results?:)[^\n]*/i;

function removeAccents(str: string): string {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');
}

export class AcceptancePolicy {
  /**
   * Evaluates hard safety invariants.
   * Returns any fatal violations that immediately force score = 0 and reject candidate.
   */
  static checkHardInvariants(params: {
    diagnostics: DiagnosticSnapshot;
    changedFiles: ChangedFileState[];
    registeredFiles?: string[];
    finalAnswerText?: string;
  }): { passed: boolean; violations: string[] } {
    const violations: string[] = [];

    // 1. Anti-Hallucination & Anti-Deferred Work checks on Final Answer
    if (params.finalAnswerText !== undefined) {
      const trimmed = params.finalAnswerText.trim();
      if (!trimmed) {
        violations.push('Empty final response received. Must execute a tool or provide substantive explanation.');
      } else {
        const normalized = removeAccents(trimmed).replace(OPTIONAL_OFFER_PATTERN, '');
        const remainingText = normalized.replace(FULFILLED_INTRO_PATTERN, '').trim();
        const hasDeferred = DEFERRED_WORK_PATTERNS.some((p) => p.test(remainingText));
        if (hasDeferred) {
          violations.push(
            'Deferred action promise detected in response ("I will modify/Tôi sẽ tiến hành..."). You must execute the necessary tool immediately rather than promising to do it later.',
          );
        }
      }
    }

    // 2. Unresolved compiler/syntax errors
    if (params.diagnostics.errors.length > 0) {
      violations.push(
        `Found ${params.diagnostics.errors.length} unresolved compiler error(s).`,
      );
    }
    if (params.diagnostics.syntaxErrors.length > 0) {
      violations.push(
        `Found ${params.diagnostics.syntaxErrors.length} syntax error(s).`,
      );
    }
    if (params.diagnostics.unresolvedImports.length > 0) {
      violations.push(
        `Found ${params.diagnostics.unresolvedImports.length} missing import / undefined name error(s).`,
      );
    }

    // 3. Unregistered files in restricted scopes
    if (params.registeredFiles && params.registeredFiles.length > 0) {
      const unregistered = params.changedFiles.filter(
        (f) =>
          !params.registeredFiles!.some(
            (reg) => f.path === reg || f.path.startsWith(`${reg.replace(/\/$/, '')}/`),
          ),
      );
      if (unregistered.length > 0) {
        violations.push(
          `Mutated files outside registered scope: ${unregistered.map((u) => u.path).join(', ')}`,
        );
      }
    }

    return {
      passed: violations.length === 0,
      violations,
    };
  }
}
