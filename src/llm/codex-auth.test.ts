import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as auth from './codex-auth.js';

function jwt(exp: number): string {
  return `header.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.signature`;
}

test('ChatGPT login reuses valid credentials, replaces expired tokens and propagates cancellation', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'minus-codex-auth-'));
  const keys = ['CODEX_AUTH_PATH', 'CODEX_HOME', 'CODEX_ACCESS_TOKEN', 'CODEX_TOKEN', 'CODEX_ACCOUNT_ID'];
  const saved = keys.map(key => process.env[key]);
  const ensure = (auth as any).ensureCodexAuthenticated;
  try {
    assert.equal(typeof ensure, 'function', 'model selection needs an automatic ChatGPT login flow');
    keys.forEach(key => delete process.env[key]);
    process.env.CODEX_HOME = directory;
    assert.equal(auth.getCodexAuthFilePath(), path.join(directory, 'auth.json'));
    const valid = jwt(Math.floor(Date.now() / 1000) + 3600);
    fs.writeFileSync(path.join(directory, 'auth.json'), JSON.stringify({ tokens: { access_token: valid, account_id: 'account-test' } }));
    const statuses: string[] = [];
    const credentials = await ensure({ onStatus: (message: string) => statuses.push(message), login: async () => { throw new Error('valid sessions must not reopen login'); } });
    assert.equal(credentials.accessToken, valid);
    assert.equal(credentials.accountId, 'account-test');
    assert.match(statuses.join('\n'), /existing ChatGPT/i);
    assert.ok(!statuses.join('\n').includes(valid), 'status must not disclose credentials');

    process.env.CODEX_ACCESS_TOKEN = jwt(1);
    fs.writeFileSync(path.join(directory, 'auth.json'), JSON.stringify({ tokens: { access_token: jwt(1) } }));
    let logins = 0;
    const renewed = await ensure({ login: async () => {
      logins++;
      fs.writeFileSync(path.join(directory, 'auth.json'), JSON.stringify({ tokens: { access_token: valid, account_id: 'new-account' } }));
    } });
    assert.equal(logins, 1);
    assert.equal(renewed.accessToken, valid, 'expired environment token must not mask a fresh login');
    assert.equal(renewed.accountId, 'new-account');

    fs.rmSync(path.join(directory, 'auth.json'));
    await assert.rejects(ensure({ login: async () => { throw new Error('Login cancelled'); } }), /cancelled/);
    await assert.rejects(ensure({ login: async () => {} }), /token/i, 'successful process exit without credentials is not a login');
    const controller = new AbortController(); controller.abort();
    await assert.rejects(ensure({ signal: controller.signal, login: async () => { throw new Error('must not start'); } }), { name: 'AbortError' });
  } finally {
    keys.forEach((key, index) => saved[index] === undefined ? delete process.env[key] : process.env[key] = saved[index]);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('official login runs without a shell, writes the configured auth file and supports process cancellation', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'minus-login-process-'));
  const keys = ['PATH', 'CODEX_AUTH_PATH', 'CODEX_HOME']; const saved = keys.map(key => process.env[key]);
  const script = path.join(directory, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  try {
    // Exercise the installed npm CLI boundary without opening a browser or using account credentials.
    if (process.platform !== 'win32') return;
    fs.mkdirSync(path.dirname(script), { recursive: true });
    process.env.PATH = directory; process.env.CODEX_AUTH_PATH = path.join(directory, 'custom-auth.json');
    fs.writeFileSync(script, `import fs from 'node:fs'; import path from 'node:path';
      console.log('Open https://auth.openai.com/test-login');
      const args = process.argv.slice(2);
      if (!args.includes('cli_auth_credentials_store="file"') || !args.includes('forced_login_method="chatgpt"') || args.at(-1) !== 'login') process.exit(2);
      fs.writeFileSync(path.join(process.env.CODEX_HOME, 'auth.json'), JSON.stringify({tokens:{access_token:'test-oauth',account_id:'test-account'}}));`);
    const output: string[] = [];
    await (auth.runCodexLogin as any)(undefined, (message: string) => output.push(message));
    assert.match(output.join('\n'), /https:\/\/auth.openai.com\/test-login/);
    assert.equal(auth.getCodexCredentials({ ignoreEnv: true })?.accessToken, 'test-oauth');
    assert.equal(auth.getCodexCredentials({ ignoreEnv: true })?.accountId, 'test-account');
    fs.writeFileSync(script, 'process.exit(1);');
    await assert.rejects(auth.runCodexLogin(), /failed|cancelled/);
    const marker = path.join(directory, 'started');
    fs.writeFileSync(script, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000);`);
    const controller = new AbortController();
    const running = auth.runCodexLogin(controller.signal);
    const rejection = assert.rejects(running, { name: 'AbortError' });
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(marker) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    controller.abort(); await rejection;
    assert.ok(fs.existsSync(marker), 'login process must start before testing cancellation');
    const pid = Number(fs.readFileSync(marker, 'utf8'));
    let stopped = false;
    while (Date.now() < deadline) {
      try { process.kill(pid, 0); } catch { stopped = true; break; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(stopped, 'cancellation must terminate the login process');
  } finally {
    keys.forEach((key, index) => saved[index] === undefined ? delete process.env[key] : process.env[key] = saved[index]);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
