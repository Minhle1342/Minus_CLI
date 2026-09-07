import dotenv from 'dotenv';
import { BenchmarkRunner } from './benchmark-runner.js';
import { ReplayEvaluator } from './replay-evaluator.js';
import { BENCHMARK_TASKS } from './benchmark-tasks.js';
import { colors as c } from '../ui/cli-ui.js';

dotenv.config();

function parseArgs() {
  const args = process.argv.slice(2);
  const options: {
    tasks?: string;
    model?: string;
    mock?: boolean;
    sandbox?: 'local' | 'docker';
    keepWorkspace?: boolean;
    output?: string;
    replay?: string;
    list?: boolean;
  } = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--mock') {
      options.mock = true;
    } else if (arg === '--list') {
      options.list = true;
    } else if (arg === '--keep-workspace') {
      options.keepWorkspace = true;
    } else if (arg === '--tasks' && args[i + 1]) {
      options.tasks = args[++i];
    } else if (arg === '--model' && args[i + 1]) {
      options.model = args[++i];
    } else if (arg === '--sandbox' && args[i + 1]) {
      options.sandbox = args[++i] as any;
    } else if (arg === '--output' && args[i + 1]) {
      options.output = args[++i];
    } else if (arg === '--replay' && args[i + 1]) {
      options.replay = args[++i];
    }
  }

  return options;
}

async function main() {
  const options = parseArgs();

  // 1. Liệt kê danh sách tasks
  if (options.list) {
    console.log(`\n${c.bold}📋 DANH SÁCH BÀI TOÁN BENCHMARK (${BENCHMARK_TASKS.length} tasks):${c.reset}\n`);
    for (const task of BENCHMARK_TASKS) {
      console.log(`• ${c.cyan}${c.bold}${task.id.padEnd(32)}${c.reset} [${task.category.toUpperCase()}] (${task.difficulty})`);
      console.log(`  ${c.dim}${task.title}${c.reset}`);
    }
    console.log('');
    return;
  }

  // 2. Chế độ Replay Trajectory (Zero-API cost)
  if (options.replay) {
    console.log(`\n${c.bold}🔍 ĐANG THẨM ĐỊNH TRAJECTORY: ${options.replay}${c.reset}\n`);
    try {
      const result = ReplayEvaluator.evaluateSessionFile(options.replay);
      console.log(`• Session ID: ${c.bold}${result.sessionId}${c.reset}`);
      console.log(`• Điểm chất lượng: ${result.score >= 80 ? c.green : c.yellow}${c.bold}${result.score}/100${c.reset}`);
      console.log(`• Hoàn thành mục tiêu: ${result.hasCompletedGoal ? c.green + 'Có (Đã submit)' : c.red + 'Chưa'}${c.reset}`);
      console.log(`• Số bước: ${result.totalSteps} steps | Lượt gọi tool: ${result.toolUsageCount}`);
      console.log(`• Guardian can thiệp: ${result.guardianBlocksCount} lần | Tool trùng lặp: ${result.duplicateToolCallsCount}`);
      if (result.recommendations.length > 0) {
        console.log(`\n${c.yellow}Khuyến nghị cải thiện:${c.reset}`);
        for (const rec of result.recommendations) {
          console.log(`  - ${rec}`);
        }
      }
      console.log('');
      return;
    } catch (err: any) {
      console.error(`❌ Lỗi khi đọc file replay: ${err.message}`);
      process.exit(1);
    }
  }

  // 3. Chạy Benchmark Runner Suite
  const runner = new BenchmarkRunner({
    taskFilter: options.tasks,
    modelName: options.model,
    mockMode: options.mock,
    sandboxMode: options.sandbox || 'local',
    keepWorkspaces: options.keepWorkspace,
    outputPath: options.output,
  });

  try {
    const report = await runner.runSuite();
    if (report.failedTasks > 0 || report.errorTasks > 0) {
      process.exitCode = 1;
    }
  } catch (err: any) {
    console.error(`\n❌ Benchmark Runner gặp sự cố:`, err);
    process.exit(1);
  }
}

main().catch(console.error);
