import fs from 'node:fs/promises';
import path from 'node:path';
import { IExecutionSubstrate } from '../execution/types.js';
import { LocalExecutionSubstrate } from '../execution/local-substrate.js';
import { EphemeralScratchWorkspace } from '../sandbox/scratch-workspace.js';
import { StructuredTestReport, TestHarnessOptions } from './types.js';
import { TestOutputParser } from './test-output-parser.js';
import type { HypothesisTracker } from '../agent/hypothesis-tracker.js';
import type { HypothesisRollbackOrchestrator } from '../agent/hypothesis-rollback-orchestrator.js';
import type { CompletionEvidenceGate } from '../agent/completion-evidence.js';
import type { CriticGate } from '../agent/critic-gate.js';

export interface TestEngineeringHarnessConfig {
  workspaceRoot: string;
  substrate?: IExecutionSubstrate;
  hypothesisTracker?: HypothesisTracker;
  rollbackOrchestrator?: HypothesisRollbackOrchestrator;
  completionEvidenceGate?: CompletionEvidenceGate;
  criticGate?: CriticGate;
}

/**
 * TestEngineeringHarness - Bộ Khung Kỹ nghệ Kiểm thử Tự động (Codex Standard Test Harness)
 * 
 * Tích hợp chặt chẽ:
 * 1. Execution Substrate (Local / Sandboxed Compute Plane).
 * 2. Point-in-time Ephemeral Scratch Sandbox (Kiểm thử suy đoán phân lập).
 * 3. Hypothesis System (Tự động Validate khi pass, Falsify và Rollback khi fail).
 * 4. Completion Evidence Gate (Ghi nhận bằng chứng kiểm thử thực nghiệm để nghiệm thu CriticGate).
 */
export class TestEngineeringHarness {
  private workspaceRoot: string;
  private substrate: IExecutionSubstrate;
  private hypothesisTracker?: HypothesisTracker;
  private rollbackOrchestrator?: HypothesisRollbackOrchestrator;
  private completionEvidenceGate?: CompletionEvidenceGate;
  private criticGate?: CriticGate;
  private reproManager = new ReproductionVerificationManager();

  constructor(config: TestEngineeringHarnessConfig) {
    this.workspaceRoot = path.resolve(config.workspaceRoot);
    this.substrate = config.substrate || new LocalExecutionSubstrate({ defaultCwd: this.workspaceRoot });
    this.hypothesisTracker = config.hypothesisTracker;
    this.rollbackOrchestrator = config.rollbackOrchestrator;
    this.completionEvidenceGate = config.completionEvidenceGate;
    this.criticGate = config.criticGate;
  }

  setHypothesisTracker(tracker: HypothesisTracker): void {
    this.hypothesisTracker = tracker;
  }

  setRollbackOrchestrator(orchestrator: HypothesisRollbackOrchestrator): void {
    this.rollbackOrchestrator = orchestrator;
  }

  setCompletionEvidenceGate(gate: CompletionEvidenceGate): void {
    this.completionEvidenceGate = gate;
  }

  setCriticGate(gate: CriticGate): void {
    this.criticGate = gate;
  }

  /**
   * Tự động phát hiện lệnh chạy test phù hợp nhất cho Repository đa ngôn ngữ và đa package manager.
   */
  async detectTestCommand(): Promise<string> {
    const detected = await detectWorkspaceTestCommand(this.workspaceRoot);
    return detected || 'npm test';
  }

  /**
   * Thực thi bộ kiểm thử (Test Suite) với phân tích dữ liệu có cấu trúc và liên kết bằng chứng
   */
  async runTests(options: TestHarnessOptions = {}): Promise<StructuredTestReport> {
    const testCommand = options.testCommand || await this.detectTestCommand();
    const timeoutMs = options.timeoutMs || 120000; // 2 phút mặc định cho test
    const startTime = Date.now();

    let rawStdout = '';
    let rawStderr = '';
    let exitCode = 0;
    let durationMs = 0;

    // 1. Thực thi trên Scratch Workspace hoặc Trực tiếp trên Substrate
    if (options.useScratchWorkspace) {
      const scratch = new EphemeralScratchWorkspace({
        sourceWorkspaceRoot: this.workspaceRoot,
        substrate: this.substrate,
      });

      try {
        await scratch.create();
        const execRes = await scratch.exec(testCommand, timeoutMs);
        rawStdout = execRes.stdout;
        rawStderr = execRes.stderr;
        exitCode = execRes.exitCode;
        durationMs = execRes.durationMs;
      } finally {
        await scratch.dispose();
      }
    } else {
      const execRes = await this.substrate.exec(testCommand, {
        cwd: this.workspaceRoot,
        timeoutMs,
        signal: options.signal,
      });
      rawStdout = execRes.stdout;
      rawStderr = execRes.stderr;
      exitCode = execRes.exitCode;
      durationMs = execRes.durationMs;
    }

    const fullOutput = rawStdout + (rawStderr ? `\n${rawStderr}` : '');
    const report = TestOutputParser.parse(fullOutput, exitCode, durationMs, testCommand);

    // 2. Tích hợp với Hypothesis System (Codex Scientific Loop)
    const activeHypothesisId = options.hypothesisId || this.hypothesisTracker?.getActiveHypothesis()?.id;
    if (activeHypothesisId && this.hypothesisTracker) {
      if (report.isPassed) {
        this.hypothesisTracker.markValidated(
          activeHypothesisId,
          `Xác minh thực nghiệm thành công: ${report.summaryText}`
        );
      } else {
        this.hypothesisTracker.markFalsified(
          activeHypothesisId,
          `Phản nghiệm thất bại: ${report.summaryText}`
        );

        // Kích hoạt tự động Rollback về trạng thái sạch nếu có Rollback Orchestrator
        if (this.rollbackOrchestrator) {
          await this.rollbackOrchestrator.rollbackOnFalsifiedHypothesis(
            activeHypothesisId,
            this.hypothesisTracker
          ).catch((err) => {
            console.warn(`[TestEngineeringHarness] Rollback error: ${err.message}`);
          });
        }
      }
    }

    return report;
  }

  getReproductionManager(): ReproductionVerificationManager {
    return this.reproManager;
  }

  /**
   * Chạy bài test tái hiện (Reproduction Test) và cập nhật trạng thái kiểm chứng cho chu trình sửa lỗi.
   */
  async runReproductionTest(options: {
    command: string;
    isPostFix?: boolean;
    useScratchWorkspace?: boolean;
    timeoutMs?: number;
  }): Promise<{ report: StructuredTestReport; reproStatus: ReproductionStatus }> {
    const report = await this.runTests({
      testCommand: options.command,
      useScratchWorkspace: options.useScratchWorkspace,
      timeoutMs: options.timeoutMs,
    });
    this.reproManager.recordAttempt(
      options.command,
      report.exitCode,
      report.summaryText,
      options.isPostFix
    );
    return {
      report,
      reproStatus: this.reproManager.getStatus(),
    };
  }

  /**
   * SWE-Reasoner Multi-Patch Sandbox Reranker (Phase 3):
   * Thử nghiệm phân lập các bản vá (patch candidates) trên Sandbox,
   * chạy bài kiểm thử tái hiện và bộ hồi quy, sau đó xếp hạng dựa trên tín hiệu thực thi.
   */
  async evaluateAndRerankPatches(
    candidates: PatchCandidate[],
    options: {
      reproCommand: string;
      regressionCommand?: string;
      timeoutMs?: number;
    }
  ): Promise<RankedPatchReport> {
    const rankings: RankedPatchEvaluation[] = [];
    const timeoutMs = options.timeoutMs || 60000;

    for (const candidate of candidates) {
      const scratch = new EphemeralScratchWorkspace({
        sourceWorkspaceRoot: this.workspaceRoot,
        substrate: this.substrate,
      });

      let reproPassed = false;
      let regressionPassed = true;
      let feedback = '';

      try {
        await scratch.create();
        const scratchTarget = path.join(scratch.scratchPath, candidate.targetFile);

        // Áp dụng bản vá vào sandbox workspace
        await fs.mkdir(path.dirname(scratchTarget), { recursive: true });
        await fs.writeFile(scratchTarget, candidate.content, 'utf-8');

        // 1. Chạy reproduction command
        const reproExec = await scratch.exec(options.reproCommand, timeoutMs);
        reproPassed = reproExec.exitCode === 0;

        // 2. Chạy regression test (nếu có)
        if (options.regressionCommand) {
          const regExec = await scratch.exec(options.regressionCommand, timeoutMs);
          regressionPassed = regExec.exitCode === 0;
        }

        // 3. Tính điểm chất lượng dựa trên execution feedback theo chuẩn SWE-Reasoner (arXiv:2503.23803):
        // Bắt buộc phải vượt qua bài test tái hiện (Reproduction Test) mới có điểm.
        const diffSizeChars = candidate.content.length;
        let score = 0;
        if (reproPassed) {
          score = 50 + (regressionPassed ? 30 : 0);
          // Điểm độ tinh gọn: tối đa 20 điểm nếu code không phình to bất thường (< 5000 ký tự)
          const sizeBonus = Math.max(0, Math.min(20, Math.round(20 * (1 - Math.min(diffSizeChars, 5000) / 5000))));
          score += sizeBonus;
        }

        feedback = reproPassed && regressionPassed
          ? `Bản vá hoàn hảo: Vượt qua Repro Test và bảo toàn Regression Suite (Điểm: ${score}/100)`
          : !reproPassed
            ? `Bản vá thất bại: Chưa vượt qua bài test tái hiện (ExitCode ${reproExec.exitCode})`
            : `Bản vá gây lỗi hồi quy (Regression Test ExitCode != 0)`;

        rankings.push({
          candidateId: candidate.id,
          description: candidate.description,
          reproPassed,
          regressionPassed,
          diffSizeChars,
          score,
          feedback,
        });
      } catch (err: any) {
        rankings.push({
          candidateId: candidate.id,
          description: candidate.description,
          reproPassed: false,
          regressionPassed: false,
          diffSizeChars: candidate.content.length,
          score: 0,
          feedback: `Lỗi trong quá trình thử nghiệm sandbox: ${err.message}`,
        });
      } finally {
        await scratch.dispose();
      }
    }

    // Sắp xếp các ứng viên điểm cao nhất lên đầu
    rankings.sort((a, b) => b.score - a.score);

    return {
      evaluatedCount: candidates.length,
      bestCandidate: rankings[0],
      rankings,
    };
  }

  async dispose(): Promise<void> {
    await this.substrate.dispose();
  }
}

export interface ReproductionAttemptRecord {
  id: string;
  timestamp: number;
  command: string;
  exitCode: number;
  output: string;
  phase: 'pre-fix' | 'post-fix';
  isPassed: boolean;
}

export interface ReproductionStatus {
  hasPreFixRepro: boolean;
  hasPostFixPass: boolean;
  isVerified: boolean;
  attemptsCount: number;
  lastAttempt?: ReproductionAttemptRecord;
  details: string;
}

/**
 * Quản lý chu trình kiểm thử tái hiện lỗi (Automated Reproduction Code & Verification Gating)
 * Theo nghiên cứu SWE-Reasoner (arXiv:2503.23803)
 */
export class ReproductionVerificationManager {
  private attempts: ReproductionAttemptRecord[] = [];

  recordAttempt(command: string, exitCode: number, output: string, isPostFix?: boolean): ReproductionAttemptRecord {
    const isPassed = exitCode === 0;
    const phase: 'pre-fix' | 'post-fix' = isPostFix ? 'post-fix' : 'pre-fix';
    const record: ReproductionAttemptRecord = {
      id: `repro-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: Date.now(),
      command,
      exitCode,
      output,
      phase,
      isPassed,
    };
    this.attempts.push(record);
    return record;
  }

  getAttempts(): ReproductionAttemptRecord[] {
    return [...this.attempts];
  }

  hasVerifiedFix(): boolean {
    const hasPreFail = this.attempts.some((a) => a.phase === 'pre-fix' && !a.isPassed);
    const hasPostPass = this.attempts.some((a) => a.phase === 'post-fix' && a.isPassed);
    return hasPreFail && hasPostPass;
  }

  getStatus(): ReproductionStatus {
    const hasPreFail = this.attempts.some((a) => a.phase === 'pre-fix' && !a.isPassed);
    const hasPostPass = this.attempts.some((a) => a.phase === 'post-fix' && a.isPassed);
    const lastAttempt = this.attempts[this.attempts.length - 1];

    let details = 'Chưa có bài kiểm thử tái hiện nào được ghi nhận.';
    if (hasPreFail && hasPostPass) {
      details = 'Đã xác minh đầy đủ: Lỗi được tái hiện thành công (pre-fix FAIL) và bản sửa đổi vượt qua kiểm thử (post-fix PASS).';
    } else if (hasPreFail && !hasPostPass) {
      details = 'Đã tái hiện lỗi thành công (pre-fix FAIL), đang chờ lượt kiểm thử xác nhận vượt qua sau khi sửa (post-fix PASS).';
    } else if (!hasPreFail && hasPostPass) {
      details = 'Đã kiểm thử thành công sau sửa nhưng thiếu bước chứng minh lỗi ban đầu (pre-fix FAIL).';
    }

    return {
      hasPreFixRepro: hasPreFail,
      hasPostFixPass: hasPostPass,
      isVerified: hasPreFail && hasPostPass,
      attemptsCount: this.attempts.length,
      lastAttempt,
      details,
    };
  }
}

export interface PatchCandidate {
  id: string;
  description?: string;
  targetFile: string;
  content: string;
}

export interface RankedPatchEvaluation {
  candidateId: string;
  description?: string;
  reproPassed: boolean;
  regressionPassed: boolean;
  diffSizeChars: number;
  score: number;
  feedback: string;
}

export interface RankedPatchReport {
  evaluatedCount: number;
  bestCandidate?: RankedPatchEvaluation;
  rankings: RankedPatchEvaluation[];
}

/**
 * Tự động phát hiện lệnh test phù hợp nhất cho bất kỳ thư mục dự án nào (đa package manager & đa ngôn ngữ).
 * Trả về undefined nếu không tìm thấy cấu hình test nào trong workspace.
 */
export async function detectWorkspaceTestCommand(workspaceRoot: string): Promise<string | undefined> {
  // 0. Biến môi trường ghi đè cao nhất
  if (process.env.MINUS_TEST_COMMAND?.trim()) {
    return process.env.MINUS_TEST_COMMAND.trim();
  }

  const root = path.resolve(workspaceRoot);

  // 1. Kiểm tra Node.js (pnpm, yarn, bun, npm) & Monorepo
  try {
    let pm = 'npm';
    const [hasPnpmLock, hasYarnLock, hasBunLock] = await Promise.all([
      fs.stat(path.join(root, 'pnpm-lock.yaml')).catch(() => null),
      fs.stat(path.join(root, 'yarn.lock')).catch(() => null),
      fs.stat(path.join(root, 'bun.lockb')).catch(() => null) || fs.stat(path.join(root, 'bun.lock')).catch(() => null),
    ]);

    if (hasPnpmLock) pm = 'pnpm';
    else if (hasBunLock) pm = 'bun';
    else if (hasYarnLock) pm = 'yarn';

    const pkgPath = path.join(root, 'package.json');
    const pkgContent = await fs.readFile(pkgPath, 'utf-8').catch(() => null);
    if (pkgContent) {
      let pkg: any = {};
      try { pkg = JSON.parse(pkgContent); } catch {}

      if (typeof pkg.packageManager === 'string') {
        if (pkg.packageManager.startsWith('pnpm')) pm = 'pnpm';
        else if (pkg.packageManager.startsWith('yarn')) pm = 'yarn';
        else if (pkg.packageManager.startsWith('bun')) pm = 'bun';
      }

      // Root scripts
      if (pkg.scripts) {
        if (pkg.scripts.test && !/no test specified/i.test(pkg.scripts.test)) {
          return pm === 'bun' ? 'bun test' : `${pm} test`;
        }
        if (pkg.scripts['test:unit']) return `${pm} run test:unit`;
        if (pkg.scripts['test:all']) return `${pm} run test:all`;
      }
    }

    // Quét Monorepo workspaces (apps, packages, services, modules, libs, crates, projects)
    const workspaceDirs = ['apps', 'packages', 'services', 'modules', 'libs', 'projects', 'crates'];
    for (const parentDir of workspaceDirs) {
      try {
        const parentPath = path.join(root, parentDir);
        const entries = await fs.readdir(parentPath, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const subPkgPath = path.join(parentPath, entry.name, 'package.json');
            const subPkgContent = await fs.readFile(subPkgPath, 'utf-8').catch(() => null);
            if (subPkgContent) {
              const subPkg = JSON.parse(subPkgContent);
              if (subPkg.scripts && (subPkg.scripts.test || subPkg.scripts['test:unit'])) {
                if (pm === 'pnpm') {
                  return `pnpm --filter ${subPkg.name || entry.name} test`;
                }
                if (pm === 'yarn') {
                  return `yarn workspace ${subPkg.name || entry.name} test`;
                }
                if (pm === 'bun') {
                  return `bun --filter ${subPkg.name || entry.name} test`;
                }
                return `npm test --workspace=${parentDir}/${entry.name}`;
              }
            }
          }
        }
      } catch {}
    }

    // Nếu có package.json và scripts.test (dù có no test specified nhưng là node project)
    if (pkgContent) {
      let pkg: any = {};
      try { pkg = JSON.parse(pkgContent); } catch {}
      if (pkg.scripts?.test) {
        return `${pm} test`;
      }
    }
  } catch {}

  // 2. Kiểm tra .NET (C# / F#)
  try {
    const rootFiles = await fs.readdir(root).catch(() => []);
    const hasDotnet = rootFiles.some((f) => f.endsWith('.sln') || f.endsWith('.csproj') || f.endsWith('.fsproj'));
    if (hasDotnet) {
      return 'dotnet test';
    }
  } catch {}

  // 3. Kiểm tra Rust Cargo
  try {
    const hasCargo = await fs.stat(path.join(root, 'Cargo.toml')).catch(() => null);
    if (hasCargo) {
      return 'cargo test';
    }
  } catch {}

  // 4. Kiểm tra Go
  try {
    const hasGo = await fs.stat(path.join(root, 'go.mod')).catch(() => null);
    if (hasGo) {
      return 'go test ./...';
    }
  } catch {}

  // 5. Kiểm tra Java / Kotlin (Maven / Gradle)
  try {
    const hasPom = await fs.stat(path.join(root, 'pom.xml')).catch(() => null);
    if (hasPom) {
      return 'mvn test';
    }
    const hasGradle = await fs.stat(path.join(root, 'build.gradle')).catch(() => null)
      || await fs.stat(path.join(root, 'build.gradle.kts')).catch(() => null);
    if (hasGradle) {
      const hasGradlew = await fs.stat(path.join(root, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew')).catch(() => null);
      return hasGradlew ? './gradlew test' : 'gradle test';
    }
  } catch {}

  // 6. Kiểm tra C / C++ (CMake / Make)
  try {
    const hasCmake = await fs.stat(path.join(root, 'CMakeLists.txt')).catch(() => null);
    if (hasCmake) {
      return 'ctest';
    }
    const makefilePath = path.join(root, 'Makefile');
    const hasMakefile = await fs.readFile(makefilePath, 'utf-8').catch(() => null);
    if (hasMakefile && /^\s*test\s*:/m.test(hasMakefile)) {
      return 'make test';
    }
  } catch {}

  // 7. Kiểm tra Python
  try {
    const [hasPyproject, hasPipfile, hasPytestIni, hasTestsDir, hasManagePy] = await Promise.all([
      fs.readFile(path.join(root, 'pyproject.toml'), 'utf-8').catch(() => null),
      fs.stat(path.join(root, 'Pipfile')).catch(() => null),
      fs.stat(path.join(root, 'pytest.ini')).catch(() => null) || fs.stat(path.join(root, 'setup.cfg')).catch(() => null) || fs.stat(path.join(root, 'tox.ini')).catch(() => null),
      fs.stat(path.join(root, 'tests')).catch(() => null) || fs.stat(path.join(root, 'test')).catch(() => null),
      fs.stat(path.join(root, 'manage.py')).catch(() => null),
    ]);

    if (hasPyproject && hasPyproject.includes('[tool.poetry]')) {
      return 'poetry run pytest';
    }
    if (hasPipfile) {
      return 'pipenv run pytest';
    }
    if (hasPytestIni || hasTestsDir) {
      return 'pytest';
    }
    if (hasManagePy) {
      return 'python manage.py test';
    }
  } catch {}

  // 8. Kiểm tra PHP (Composer / PHPUnit)
  try {
    const [hasComposer, hasPhpunit] = await Promise.all([
      fs.stat(path.join(root, 'composer.json')).catch(() => null),
      fs.stat(path.join(root, 'phpunit.xml')).catch(() => null),
    ]);
    if (hasComposer || hasPhpunit) {
      return 'composer test';
    }
  } catch {}

  // 9. Kiểm tra Ruby (RSpec / Bundler)
  try {
    const [hasGemfile, hasRspec] = await Promise.all([
      fs.stat(path.join(root, 'Gemfile')).catch(() => null),
      fs.stat(path.join(root, '.rspec')).catch(() => null),
    ]);
    if (hasGemfile || hasRspec) {
      return 'bundle exec rspec';
    }
  } catch {}

  return undefined;
}

