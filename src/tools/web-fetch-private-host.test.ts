import assert from 'node:assert/strict';
import test from 'node:test';
import { webFetchTool } from './web-fetch.js';
import { Workspace } from '../workspace/workspace.js';

test('web_fetch refuses loopback and private targets', async () => {
  const previous = process.env.MINUS_ALLOW_PRIVATE_FETCH;
  delete process.env.MINUS_ALLOW_PRIVATE_FETCH;
  try {
    for (const url of [
      'http://127.0.0.1:3000/admin',
      'http://localhost/',
      'http://[::1]/',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.2/',
      'http://192.168.1.1/',
      'http://172.16.0.1/',
    ]) {
      const result = await webFetchTool.execute({ url }, new Workspace(process.cwd()));
      assert.equal(result.errorCode, 'PRIVATE_HOST_BLOCKED', url);
    }
  } finally {
    if (previous === undefined) delete process.env.MINUS_ALLOW_PRIVATE_FETCH;
    else process.env.MINUS_ALLOW_PRIVATE_FETCH = previous;
  }
});
