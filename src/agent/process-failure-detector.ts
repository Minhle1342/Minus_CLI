/**
 * Process-Level Failure Detection & Process-Based Search Harness
 * Dựa trên bài báo nghiên cứu: "Thinking Longer, Not Larger: Enhancing Software Engineering Agents via Scaling Test-Time Compute" (arXiv:2503.23803)
 *
 * Các thành phần chính:
 * 1. Milestone Phase Transition: EXPLORATION -> FAULT_LOCALIZATION -> PATCH_GENERATION_AND_VERIFY
 * 2. Relevance Drift Detection: Cắt tỉa khi Agent khảo sát lạc đề >= 4 bước
 * 3. Multi-Hypothesis Fault Localization & PRM Scorer: Đánh giá giả thuyết bằng Process Reward Model Heuristic
 * 4. Trajectory Backtracking: Nhận diện lỗi định vị sai khi test fail >= 3 lần sau mutation và kích hoạt quay đầu
 */

import { isVerificationCommand } from './completion-evidence.js';

export type DevelopmentPhase = 'EXPLORATION' | 'FAULT_LOCALIZATION' | 'PATCH_GENERATION_AND_VERIFY';

export interface FaultHypothesis {
  id: string;
  targetFile: string;
  symbolOrLine?: string;
  description: string;
  rationale?: string;
  callGraphRelevance?: boolean;
  hasReproTest?: boolean;
  hasRecentDiff?: boolean;
  confidenceScore?: number; // 0 -> 100
}

export interface PRMEvaluationContext {
  taskKeywords: string[];
  stackTraceFiles?: string[];
  activeReproFiles?: string[];
}

export interface PRMScoreResult {
  hypothesisId: string;
  score: number; // 0 -> 100
  breakdown: {
    callGraphScore: number;
    reproTestScore: number;
    keywordMatchScore: number;
    specificityScore: number;
  };
  verdict: 'STRONG_CANDIDATE' | 'MODERATE_CANDIDATE' | 'LOW_CONFIDENCE';
}

export interface ProcessFailureIntervention {
  type: 'RELEVANCE_DRIFT' | 'LOCALIZATION_FAILURE_BACKTRACK' | 'PREMATURE_MUTATION' | 'SEMANTIC_LOOP';
  message: string;
  suggestedAction: string;
  phase: DevelopmentPhase;
  similarity?: number;
}

export interface FailedMutationAttempt {
  toolName: string;
  targetFile?: string;
  contentSnippet: string;
  timestamp: number;
}

const MUTATION_TOOLS = new Set([
  'write_file',
  'replace_text',
  'apply_patch',
  'create_file',
  'delete_file',
  'move_file',
  'write_to_file',
  'replace_file_content',
  'multi_replace_file_content',
]);

const INSPECTION_TOOLS = new Set([
  'view_file',
  'read_file',
  'grep_search',
  'search_text',
  'search_codebase_fast',
  'list_files',
  'read_url_content',
  'inspect_symbol',
  'find_references',
]);

export class ProcessFailureDetector {
  private currentPhase: DevelopmentPhase = 'EXPLORATION';
  private consecutiveDriftingSteps = 0;
  private postMutationTestFailures = 0;
  private hasMutatedCode = false;
  private taskKeywords: string[] = [];
  private candidateHypotheses: FaultHypothesis[] = [];
  private activeHypothesisIndex = 0;
  private inspectedFiles: string[] = [];
  private failedMutationHistory: FailedMutationAttempt[] = [];

  constructor(taskDescription?: string) {
    if (taskDescription) {
      this.initTaskKeywords(taskDescription);
    }
  }

  public initTaskKeywords(taskDescription: string): void {
    // Tách các từ khóa có nghĩa (file names, class names, function names, error keywords)
    const matches = taskDescription.match(/[\w\-./\\]+\.[a-zA-Z0-9]+/g) || [];
    const stopwords = new Set([
      'this', 'that', 'from', 'with', 'have', 'were', 'will', 'then', 'about', 'some', 'what', 'when',
      'cho', 'cua', 'trong', 'bang', 'theo', 'duoc', 'nhung', 'nhu', 'cac', 'nay', 'do', 'hay', 'giup', 'toi', 'ban',
    ]);
    const rawWords = taskDescription
      .toLowerCase()
      .split(/[^a-zA-Z0-9_\-\u00C0-\u1EF9]/)
      .filter((w) => w.length >= 2 && !stopwords.has(w));

    // Thêm các biến thể không dấu tiếng Việt
    const unaccentedWords = taskDescription
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .split(/[^a-z0-9_\-]/)
      .filter((w) => w.length >= 2 && !stopwords.has(w));

    const combined = new Set([...matches.map((m) => m.toLowerCase()), ...rawWords, ...unaccentedWords]);
    this.taskKeywords = Array.from(combined);
  }

  public getCurrentPhase(): DevelopmentPhase {
    return this.currentPhase;
  }

  public setPhase(phase: DevelopmentPhase): void {
    this.currentPhase = phase;
  }

  public registerHypothesis(hypothesis: Omit<FaultHypothesis, 'id'>): FaultHypothesis {
    const newHypo: FaultHypothesis = {
      ...hypothesis,
      id: `hypo-${this.candidateHypotheses.length + 1}`,
    };
    this.candidateHypotheses.push(newHypo);
    if (this.currentPhase === 'EXPLORATION') {
      this.currentPhase = 'FAULT_LOCALIZATION';
    }
    return newHypo;
  }

  public getHypotheses(): FaultHypothesis[] {
    return [...this.candidateHypotheses];
  }

  public getActiveHypothesis(): FaultHypothesis | undefined {
    return this.candidateHypotheses[this.activeHypothesisIndex];
  }

  /**
   * Chấm điểm và xếp hạng danh sách giả thuyết bằng Process Reward Model Heuristic
   */
  public rankHypotheses(context: PRMEvaluationContext): PRMScoreResult[] {
    const results = this.candidateHypotheses.map((hypo) => {
      let callGraphScore = 0;
      let reproTestScore = 0;
      let keywordMatchScore = 0;
      let specificityScore = 0;

      // 1. Khớp Call Graph / Stack trace (+35 điểm)
      if (hypo.callGraphRelevance || (context.stackTraceFiles && context.stackTraceFiles.some((f) => hypo.targetFile.includes(f)))) {
        callGraphScore = 35;
      }

      // 2. Có test tái hiện chứng minh (+35 điểm)
      if (hypo.hasReproTest || (context.activeReproFiles && context.activeReproFiles.length > 0)) {
        reproTestScore = 35;
      }

      // 3. Khớp từ khóa tác vụ (+20 điểm)
      const targetLower = hypo.targetFile.toLowerCase();
      const descLower = (hypo.description || '').toLowerCase();
      const matchCount = context.taskKeywords.filter((k) => targetLower.includes(k) || descLower.includes(k)).length;
      if (matchCount >= 2) {
        keywordMatchScore = 20;
      } else if (matchCount === 1) {
        keywordMatchScore = 10;
      }

      // 4. Độ cụ thể của giả thuyết (+10 điểm)
      if (hypo.symbolOrLine && hypo.symbolOrLine.trim().length > 0) {
        specificityScore = 10;
      }

      const totalScore = callGraphScore + reproTestScore + keywordMatchScore + specificityScore;
      hypo.confidenceScore = totalScore;

      let verdict: 'STRONG_CANDIDATE' | 'MODERATE_CANDIDATE' | 'LOW_CONFIDENCE' = 'LOW_CONFIDENCE';
      if (totalScore >= 70) verdict = 'STRONG_CANDIDATE';
      else if (totalScore >= 40) verdict = 'MODERATE_CANDIDATE';

      return {
        hypothesisId: hypo.id,
        score: totalScore,
        breakdown: {
          callGraphScore,
          reproTestScore,
          keywordMatchScore,
          specificityScore,
        },
        verdict,
      };
    });

    // Sắp xếp giảm dần theo điểm PRM
    results.sort((a, b) => b.score - a.score);
    this.candidateHypotheses.sort((a, b) => (b.confidenceScore || 0) - (a.confidenceScore || 0));
    this.activeHypothesisIndex = 0;

    return results;
  }

  /**
   * Quan sát bước đi của Agent và phát hiện các thất bại cấp quy trình
   */
  public observe(observation: {
    toolName: string;
    args: Record<string, any>;
    result: Record<string, any>;
  }): ProcessFailureIntervention | null {
    const { toolName, args, result } = observation;

    // 1. Nhận diện chuyển phase sang Mutation
    if (MUTATION_TOOLS.has(toolName)) {
      this.hasMutatedCode = true;
      this.currentPhase = 'PATCH_GENERATION_AND_VERIFY';
      this.consecutiveDriftingSteps = 0; // Reset drift khi đã bắt đầu sửa code
    }

    // 2. Kiểm tra Relevance Drift ở giai đoạn Exploration / Localization
    if (INSPECTION_TOOLS.has(toolName)) {
      const inspectedTarget = (args.TargetFile || args.AbsolutePath || args.path || args.Query || args.query || '').toString().toLowerCase();
      if (inspectedTarget) {
        this.inspectedFiles.push(inspectedTarget);
      }

      const unaccentedTarget = inspectedTarget.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const isRelevant = this.taskKeywords.length < 3 || this.taskKeywords.some((kw) => inspectedTarget.includes(kw) || unaccentedTarget.includes(kw));

      if (!isRelevant) {
        this.consecutiveDriftingSteps++;
        if (this.consecutiveDriftingSteps >= 6) {
          return {
            type: 'RELEVANCE_DRIFT',
            phase: this.currentPhase,
            message: `[PROCESS-LEVEL FAILURE: RELEVANCE DRIFT] Hệ thống phát hiện bạn đã gọi 6 thao tác khảo sát liên tiếp trên các file nằm ngoài phạm vi cốt lõi của bài toán.`,
            suggestedAction: `Dừng việc khảo sát dàn trải. Hãy dùng GitNexus đồ thị gọi hàm (Call Graph) hoặc grep chính xác các symbols của lỗi để định vị đúng module cần can thiệp.`,
          };
        }
      } else {
        this.consecutiveDriftingSteps = 0;
      }
    }

    // 3. Kiểm tra Trajectory Backtracking sau Mutation (Fault Localization Failure)
    if (this.hasMutatedCode && (toolName === 'run_command' || toolName === 'execute_command')) {
      const cmd = (args.CommandLine || args.command || '').toString();
      if (isVerificationCommand(cmd)) {
        const exitCode = result.exitCode ?? (result.success === false ? 1 : 0);
        if (exitCode !== 0) {
          this.postMutationTestFailures++;
          if (this.postMutationTestFailures >= 3) {
            // Chuyển sang giả thuyết tiếp theo nếu có
            if (this.candidateHypotheses.length > this.activeHypothesisIndex + 1) {
              this.activeHypothesisIndex++;
            }
            const nextHypo = this.getActiveHypothesis();

            return {
              type: 'LOCALIZATION_FAILURE_BACKTRACK',
              phase: this.currentPhase,
              message: `[PROCESS-LEVEL FAILURE: LOCALIZATION FAILURE DETECTED] Bạn đã sửa code nhưng test vẫn thất bại ${this.postMutationTestFailures} lần liên tiếp. Theo nghiên cứu SWE-Reasoner (arXiv:2503.23803), đây là dấu hiệu của việc định vị sai nguyên nhân gốc (Fault Localization Failure), không phải lỗi cú pháp đơn thuần.`,
              suggestedAction: nextHypo
                ? `Cắt tỉa nhánh hiện tại (Pruning) và quay đầu (Backtracking). Hãy chuyển sang giả thuyết tiếp theo: '${nextHypo.targetFile}' (${nextHypo.description}).`
                : `Dừng việc sửa file hiện tại. Hãy hoàn nguyên mã chưa kiểm chứng và lập lại bài test tái hiện cô lập trong scratch/ để xác định lại root cause.`,
            };
          }
        } else {
          // Test passed thành công!
          this.postMutationTestFailures = 0;
        }
      }
    }

    // 4. Kiểm tra Fuzzy Semantic Failure Loop (Kẹt vòng lặp sửa sai mù quáng)
    if (MUTATION_TOOLS.has(toolName)) {
      const isMutationFailure = result.error !== undefined || result.success === false || result.status === 'error';
      const targetFile = (args.TargetFile || args.path || args.filePath || args.targetFile || '').toString();
      const contentSnippet = (
        args.TargetContent ||
        args.ReplacementContent ||
        args.newText ||
        args.CodeContent ||
        args.code ||
        args.patch ||
        ''
      ).toString().trim();

      if (isMutationFailure && contentSnippet.length > 0) {
        // So khớp với các nỗ lực sửa đổi thất bại trước đó
        for (const prev of this.failedMutationHistory.slice(-4)) {
          const sim = this.calculateTokenSimilarity(contentSnippet, prev.contentSnippet);
          const sameTarget = Boolean(targetFile && prev.targetFile && targetFile.toLowerCase() === prev.targetFile.toLowerCase());
          const isHighSim = sim >= 0.70 || (sameTarget && sim >= 0.55);

          if (isHighSim) {
            return {
              type: 'SEMANTIC_LOOP',
              phase: this.currentPhase,
              similarity: sim,
              message: `[PROCESS-LEVEL FAILURE: SEMANTIC FAILURE LOOP DETECTED] Hệ thống phát hiện các lần can thiệp gần nhất có độ tương đồng ngữ nghĩa cao (${Math.round(sim * 100)}%) nhưng đều thất bại. Bạn đang bị kẹt trong vòng lặp sửa đổi vi mô (Micro-patching Loop).`,
              suggestedAction: `Dừng việc thử nghiệm các biến thể cú pháp tương tự trên file '${targetFile || 'hiện tại'}'. Hãy Hoàn nguyên (Rollback) và Chuyển hướng Chiến lược (Strategy Pivot) sang phương án cấu trúc khác hoặc viết test tái hiện cô lập trong scratch/.`,
            };
          }
        }

        this.failedMutationHistory.push({
          toolName,
          targetFile,
          contentSnippet,
          timestamp: Date.now(),
        });
        if (this.failedMutationHistory.length > 10) {
          this.failedMutationHistory.shift();
        }
      }
    }

    return null;
  }

  /**
   * Tính toán độ tương đồng ngữ nghĩa bằng Token Jaccard Similarity
   */
  public calculateTokenSimilarity(strA: string, strB: string): number {
    if (!strA || !strB) return 0;
    if (strA.trim() === strB.trim()) return 1.0;

    const tokenize = (text: string): Set<string> => {
      const tokens = text
        .toLowerCase()
        .replace(/[\r\n\t]/g, ' ')
        .split(/[^a-zA-Z0-9_$]+/)
        .filter((t) => t.length > 1);
      return new Set(tokens);
    };

    const tokensA = tokenize(strA);
    const tokensB = tokenize(strB);

    if (tokensA.size === 0 || tokensB.size === 0) return 0;

    let intersectionCount = 0;
    for (const t of tokensA) {
      if (tokensB.has(t)) {
        intersectionCount++;
      }
    }

    const unionCount = new Set([...tokensA, ...tokensB]).size;
    return unionCount === 0 ? 0 : intersectionCount / unionCount;
  }

  public reset(): void {
    this.currentPhase = 'EXPLORATION';
    this.consecutiveDriftingSteps = 0;
    this.postMutationTestFailures = 0;
    this.hasMutatedCode = false;
    this.candidateHypotheses = [];
    this.activeHypothesisIndex = 0;
    this.inspectedFiles = [];
    this.failedMutationHistory = [];
  }
}
