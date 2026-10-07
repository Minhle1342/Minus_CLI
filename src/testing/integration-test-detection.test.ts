import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  detectWorkspaceIntegrationTestCommand,
  touchesIntegrationLayer,
} from './test-engineering-harness.js';

describe('Integration Test Detection & Prompt Gating', () => {
  it('detects package.json test:integration and test:e2e scripts', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-int-test-'));
    try {
      // 1. test:integration
      await fs.writeFile(
        path.join(tempDir, 'package.json'),
        JSON.stringify({
          name: 'test-app',
          scripts: {
            test: 'vitest run',
            'test:integration': 'vitest run tests/integration',
          },
        }),
        'utf-8',
      );
      const cmd = await detectWorkspaceIntegrationTestCommand(tempDir);
      assert.equal(cmd, 'npm run test:integration');

      // 2. test:e2e
      await fs.writeFile(
        path.join(tempDir, 'package.json'),
        JSON.stringify({
          name: 'test-app',
          scripts: {
            test: 'vitest run',
            'test:e2e': 'playwright test',
          },
        }),
        'utf-8',
      );
      const e2eCmd = await detectWorkspaceIntegrationTestCommand(tempDir);
      assert.equal(e2eCmd, 'npm run test:e2e');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('detects python tests/integration directory', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-py-int-'));
    try {
      await fs.mkdir(path.join(tempDir, 'tests', 'integration'), { recursive: true });
      const cmd = await detectWorkspaceIntegrationTestCommand(tempDir);
      assert.equal(cmd, 'pytest tests/integration');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('detects go test/integration directory', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-go-int-'));
    try {
      await fs.writeFile(path.join(tempDir, 'go.mod'), 'module example.com/app\n', 'utf-8');
      await fs.mkdir(path.join(tempDir, 'test', 'integration'), { recursive: true });
      const cmd = await detectWorkspaceIntegrationTestCommand(tempDir);
      assert.equal(cmd, 'go test ./test/integration/...');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('respects MINUS_INTEGRATION_TEST_COMMAND environment override', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-env-int-'));
    const oldEnv = process.env.MINUS_INTEGRATION_TEST_COMMAND;
    try {
      process.env.MINUS_INTEGRATION_TEST_COMMAND = 'custom-runner test:int';
      const cmd = await detectWorkspaceIntegrationTestCommand(tempDir);
      assert.equal(cmd, 'custom-runner test:int');
    } finally {
      if (oldEnv === undefined) {
        delete process.env.MINUS_INTEGRATION_TEST_COMMAND;
      } else {
        process.env.MINUS_INTEGRATION_TEST_COMMAND = oldEnv;
      }
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('returns undefined when no integration tests are present', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minus-plain-'));
    try {
      await fs.writeFile(
        path.join(tempDir, 'package.json'),
        JSON.stringify({
          name: 'plain-app',
          scripts: { test: 'vitest run' },
        }),
        'utf-8',
      );
      const cmd = await detectWorkspaceIntegrationTestCommand(tempDir);
      assert.equal(cmd, undefined);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('touchesIntegrationLayer correctly identifies integration components', () => {
    // True cases
    assert.equal(touchesIntegrationLayer(['src/api/routes.ts']), true);
    assert.equal(touchesIntegrationLayer(['src/controllers/user.controller.ts']), true);
    assert.equal(touchesIntegrationLayer(['src/services/billing.service.ts']), true);
    assert.equal(touchesIntegrationLayer(['src/server.ts']), true);
    assert.equal(touchesIntegrationLayer(['src/db/connection.ts']), true);
    assert.equal(touchesIntegrationLayer(['src/middleware/auth.ts']), true);
    assert.equal(touchesIntegrationLayer(['src/handlers/order.go']), true);
    assert.equal(touchesIntegrationLayer(['src/endpoints/user.py']), true);

    // False cases
    assert.equal(touchesIntegrationLayer(['src/utils/math.ts']), false);
    assert.equal(touchesIntegrationLayer(['src/components/button.tsx']), false);
    assert.equal(touchesIntegrationLayer(['README.md']), false);
    assert.equal(touchesIntegrationLayer(['package.json']), false);
  });
});
