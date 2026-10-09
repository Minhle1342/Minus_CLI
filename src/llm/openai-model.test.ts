import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createOpenAIClient, isOpenAIModel } from './openai-model.js';

test('direct OpenAI selections use ChatGPT even with an API key, while gateway selections are excluded', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'minus-model-login-'));
  const keys = ['CODEX_HOME', 'CODEX_AUTH_PATH', 'CODEX_ACCESS_TOKEN', 'CODEX_TOKEN', 'CODEX_BASE_URL'];
  const saved = keys.map(key => process.env[key]);
  try {
    keys.forEach(key => delete process.env[key]); process.env.CODEX_HOME = directory;
    for (const model of ['openai/gpt-4.1', 'codex/gpt-5.6-sol', 'gpt-5.6-sol', 'gpt-4.1', 'o3-mini']) assert.equal(isOpenAIModel(model), true);
    for (const model of ['openrouter/openai/gpt-4.1', 'github/gpt-4.1', 'omniroute/gpt-4.1', 'gemini-3.7-flash']) assert.equal(isOpenAIModel(model), false);
    let logins = 0;
    const client = await createOpenAIClient('openai/gpt-4.1', undefined, { interactive: true, apiKey: 'api-key-must-not-win', login: async () => {
      logins++;
      fs.writeFileSync(path.join(directory, 'auth.json'), JSON.stringify({ tokens: { access_token: 'oauth-token', account_id: 'account-id' } }));
    } });
    assert.equal(logins, 1); assert.equal(client.apiKey, 'oauth-token');
    assert.equal(client.modelName, 'gpt-4.1');
    assert.equal(client.baseURL, 'https://chatgpt.com/backend-api/codex');
    assert.equal(client.extraHeaders['chatgpt-account-id'], 'account-id');
    const reused = await createOpenAIClient('codex/gpt-5.6-sol', undefined, { interactive: true, login: async () => { throw new Error('must reuse'); } });
    assert.equal(reused.apiKey, 'oauth-token');
    const apiStartup = await createOpenAIClient('openai/gpt-4.1', undefined, { apiKey: 'startup-api-key' });
    assert.equal(apiStartup.apiKey, 'startup-api-key', 'non-interactive startup retains explicitly configured API authentication');
    fs.rmSync(path.join(directory, 'auth.json'));
    await assert.rejects(createOpenAIClient('openai/gpt-4.1', undefined, { interactive: true, apiKey: 'available', login: async () => { throw new Error('cancelled'); } }), /cancelled/);
    const apiClient = await createOpenAIClient('openai/gpt-4.1', undefined, { apiKey: 'api-key' });
    assert.equal(apiClient.apiKey, 'api-key'); assert.equal(apiClient.baseURL, 'https://api.openai.com/v1');
  } finally {
    keys.forEach((key, index) => saved[index] === undefined ? delete process.env[key] : process.env[key] = saved[index]);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
