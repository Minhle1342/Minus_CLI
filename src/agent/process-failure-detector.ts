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
  type: 'RELEVANCE_DRIFT' | 'LOCALIZATION_FAILURE_BACKTRACK' | 'PREMATURE_MUTATION';
  message: string;
  suggestedAction: string;
  phase: DevelopmentPhase;
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

  constructor(taskDescription?: string) {
    if (taskDescription) {
      this.initTaskKeywords(taskDescription);
    }
  }

  public initTaskKeywords(taskDescription: string): void {
    // Tách các từ khóa có nghĩa (file names, class names, function names, error keywords)
    const matches = taskDescription.match(/[\w\-./\\]+\.[a-zA-Z0-9]+/g) || [];
    const words = taskDescription
      .toLowerCase()
      .split(/[^a-zA-Z0-9_\-]/)
      .filter((w) => w.length >= 4 && !['this', 'that', 'from', 'with', 'have', 'were', 'will', 'then'].includes(w));

    const combined = new Set([...matches.map((m) => m.toLowerCase()), ...words]);
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

      const isRelevant = this.taskKeywords.length === 0 || this.taskKeywords.some((kw) => inspectedTarget.includes(kw));

      if (!isRelevant) {
        this.consecutiveDriftingSteps++;
        if (this.consecutiveDriftingSteps >= 4) {
          return {
            type: 'RELEVANCE_DRIFT',
            phase: this.currentPhase,
            message: `[PROCESS-LEVEL FAILURE: RELEVANCE DRIFT] Hệ thống phát hiện bạn đã gọi 4 thao tác khảo sát liên tiếp trên các file nằm ngoài phạm vi cốt lõi của bài toán.`,
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

    return null;
  }

  public reset(): void {
    this.currentPhase = 'EXPLORATION';
    this.consecutiveDriftingSteps = 0;
    this.postMutationTestFailures = 0;
    this.hasMutatedCode = false;
    this.candidateHypotheses = [];
    this.activeHypothesisIndex = 0;
    this.inspectedFiles = [];
  }
}
