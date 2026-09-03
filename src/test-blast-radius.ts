import path from 'node:path';
import fs from 'node:fs/promises';
import { Workspace } from './workspace/workspace.js';
import {
  detectChangedSymbols,
  calculateComprehensiveBlastRadius,
} from './tools/mutation-blast-radius.js';
import { analyzeImpactTool } from './tools/blast-radius.js';
import { replaceTextTool } from './tools/replace-text.js';

async function runTests() {
  console.log('🧪 [TEST] Bắt đầu kiểm thử toàn diện Blast Radius & Mutation Auto-Enrichment...\n');

  const workspace = new Workspace(process.cwd());

  // Test 1: detectChangedSymbols (AST diff)
  console.log('--- TEST 1: detectChangedSymbols (AST-Diff) ---');
  const oldCode = `
export interface User {
  id: string;
  name: string;
}

export function getUser(id: string): User {
  return { id, name: 'Alice' };
}

function internalHelper() {
  return 42;
}
`;

  const newCode = `
export interface User {
  id: string;
  name: string;
  role: string; // signature changed
}

export function getUser(id: string): User {
  // body changed
  console.log('fetching user');
  return { id, name: 'Alice', role: 'admin' };
}

export function newUserFunction(): void {
  // new function
}
`;

  const changedSymbols = detectChangedSymbols('dummy.ts', oldCode, newCode);
  console.log('Changed symbols detected:', changedSymbols.map((s) => `${s.kind} ${s.name} (exported: ${s.isExported})`));
  
  if (!changedSymbols.some((s) => s.name === 'User')) {
    throw new Error('TEST 1 FAILED: Không phát hiện thay đổi trên interface User!');
  }
  if (!changedSymbols.some((s) => s.name === 'getUser')) {
    throw new Error('TEST 1 FAILED: Không phát hiện thay đổi trên function getUser!');
  }
  if (!changedSymbols.some((s) => s.name === 'newUserFunction')) {
    throw new Error('TEST 1 FAILED: Không phát hiện function mới newUserFunction!');
  }
  if (!changedSymbols.some((s) => s.name === 'internalHelper')) {
    throw new Error('TEST 1 FAILED: Không phát hiện xóa bỏ internalHelper!');
  }
  console.log('✅ TEST 1 PASSED: AST-Diff phát hiện chính xác tất cả các symbol bị sửa đổi, thêm mới và xóa bỏ.\n');

  // Test 2: calculateComprehensiveBlastRadius (Multi-hop Reverse Dependency)
  console.log('--- TEST 2: calculateComprehensiveBlastRadius (Multi-hop Graph) ---');
  const targetFile = 'src/tools/types.ts';
  const blastDepth1 = calculateComprehensiveBlastRadius({
    workspace,
    filePath: targetFile,
    depth: 1,
  });
  const blastDepth2 = calculateComprehensiveBlastRadius({
    workspace,
    filePath: targetFile,
    depth: 2,
  });

  console.log(`Target: ${targetFile}`);
  console.log(`Direct Consumers (Depth 1): ${blastDepth1.directConsumers.length} files`);
  console.log(`Transitive Reachable (Depth 2): ${blastDepth2.transitiveFiles.length} files`);
  console.log(`Impacted Test Suites: ${blastDepth2.impactedTestSuites.length}`);
  console.log(`Risk Level: ${blastDepth2.risk} (Score: ${blastDepth2.score})`);

  if (blastDepth1.directConsumers.length === 0) {
    throw new Error('TEST 2 FAILED: directConsumers của src/tools/types.ts không được là 0!');
  }
  if (blastDepth2.transitiveFiles.length < blastDepth1.directConsumers.length) {
    throw new Error('TEST 2 FAILED: Transitive graph ở depth 2 phải lớn hơn hoặc bằng depth 1!');
  }
  if (blastDepth2.risk !== 'HIGH' && blastDepth2.risk !== 'CRITICAL') {
    throw new Error(`TEST 2 FAILED: Rủi ro của src/tools/types.ts phải là HIGH hoặc CRITICAL, nhưng nhận được: ${blastDepth2.risk}`);
  }
  console.log('✅ TEST 2 PASSED: Multi-hop Reverse Dependency duyệt chính xác direct và transitive consumers.\n');

  // Test 3: analyzeImpactTool (Tool analyze_impact)
  console.log('--- TEST 3: Tool analyze_impact (Không có symbol - Toàn bộ file) ---');
  const toolResultWholeFile = await analyzeImpactTool.execute(
    { path: 'src/tools/registry.ts', depth: 2 },
    workspace,
  );
  console.log('analyze_impact (file-level) output:', {
    risk: toolResultWholeFile.risk,
    directConsumers: toolResultWholeFile.directConsumers?.length,
    transitiveFiles: toolResultWholeFile.transitiveFiles?.length,
    impactedTestSuites: toolResultWholeFile.impactedTestSuites?.length,
  });

  if (!toolResultWholeFile.directConsumers || toolResultWholeFile.directConsumers.length === 0) {
    throw new Error('TEST 3 FAILED: analyze_impact không tìm thấy directConsumers cho registry.ts!');
  }
  console.log('✅ TEST 3 PASSED: analyze_impact xử lý hoàn hảo trường hợp không có symbol.\n');

  // Test 4: Tool analyze_impact với symbol cụ thể
  console.log('--- TEST 4: Tool analyze_impact (Với symbol cụ thể) ---');
  const toolResultSymbol = await analyzeImpactTool.execute(
    { path: 'src/tools/registry.ts', symbol: 'ToolRegistry' },
    workspace,
  );
  console.log('analyze_impact (symbol-level) output:', {
    symbol: toolResultSymbol.symbol,
    callers: toolResultSymbol.callers,
    risk: toolResultSymbol.risk,
  });
  if (toolResultSymbol.callers === 0) {
    throw new Error('TEST 4 FAILED: analyze_impact không tìm thấy callers cho ToolRegistry!');
  }
  console.log('✅ TEST 4 PASSED: analyze_impact truy vết callers cho symbol chính xác.\n');

  // Test 5: Auto-Enrich Blast Radius trong replace_text
  console.log('--- TEST 5: Auto-Enrich Blast Radius trong replace_text ---');
  const tempTestFile = 'src/__test_blast_radius_temp__.ts';
  const initialContent = `
export function computeTempMetric(val: number): number {
  return val * 2;
}
`;
  await fs.writeFile(path.join(process.cwd(), tempTestFile), initialContent, 'utf-8');

  try {
    const replaceRes = await replaceTextTool.execute(
      {
        path: tempTestFile,
        oldText: 'return val * 2;',
        newText: 'return val * 10;',
      },
      workspace,
    );

    console.log('replace_text result keys:', Object.keys(replaceRes));
    console.log('replace_text blastRadius:', replaceRes.blastRadius);

    if (!replaceRes.blastRadius) {
      throw new Error('TEST 5 FAILED: replace_text không tự động đính kèm blastRadius!');
    }
    if (!replaceRes.blastRadius.risk) {
      throw new Error('TEST 5 FAILED: blastRadius trong replace_text thiếu trường risk!');
    }
    if (!Array.isArray(replaceRes.blastRadius.modifiedSymbols)) {
      throw new Error('TEST 5 FAILED: blastRadius.modifiedSymbols không phải là mảng!');
    }
    if (!replaceRes.blastRadius.modifiedSymbols.includes('computeTempMetric')) {
      throw new Error('TEST 5 FAILED: blastRadius không phát hiện symbol computeTempMetric vừa bị sửa!');
    }
    console.log('✅ TEST 5 PASSED: replace_text tự động làm giàu (Auto-Enrich) Blast Radius và bắt được chính xác symbol bị sửa!\n');
  } finally {
    await fs.unlink(path.join(process.cwd(), tempTestFile)).catch(() => {});
  }

  console.log('🎉 TẤT CẢ 5 BÀI KIỂM THỬ ĐÃ PASS 100%! HỆ THỐNG ĐẠT CHUẨN CÔNG NGHIỆP.');
}

runTests().catch((err) => {
  console.error('❌ LỖI KIỂM THỬ:', err);
  process.exit(1);
});
