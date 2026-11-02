import assert from 'node:assert/strict';
import test from 'node:test';
import { checkPhaseToolEffect } from './phase-tool-effects.js';

test('checkPhaseToolEffect allows database, container, and network commands in explore and plan phases', () => {
  const tool = { name: 'run_command' } as any;
  const ws = process.cwd();

  const allowedCommands = [
    'docker exec -i postgres psql -U postgres -d mydb -c "SELECT 1;"',
    'PGPASSWORD=secret psql -h localhost -U user -d db -c "SELECT 1;"',
    'mysql -h 127.0.0.1 -u root -e "SHOW DATABASES;"',
    'sqlite3 mydb.sqlite ".tables"',
    'mongosh --eval "db.stats()"',
    'redis-cli ping',
    'docker ps',
    'docker logs my-container',
    'curl -s http://localhost:8080/health',
    'node -v',
    'npm -v',
    'git status -s',
  ];

  for (const cmd of allowedCommands) {
    for (const phase of ['explore', 'plan']) {
      const res = checkPhaseToolEffect(tool, { command: cmd }, phase, ws);
      assert.equal(res.allowed, true, `Command "${cmd}" should be allowed in phase "${phase}", but was blocked: ${res.reason}`);
    }
  }
});

test('checkPhaseToolEffect blocks codebase mutation and shell codebase reading in explore and plan phases', () => {
  const tool = { name: 'run_command' } as any;
  const ws = process.cwd();

  const blockedCommands = [
    'echo "dirty" >> README.md',
    'cat package.json',
    'head -n 10 src/index.ts',
    'node write-script.js',
    'rm -rf src/',
  ];

  for (const cmd of blockedCommands) {
    for (const phase of ['explore', 'plan']) {
      const res = checkPhaseToolEffect(tool, { command: cmd }, phase, ws);
      assert.equal(res.allowed, false, `Command "${cmd}" should be blocked in phase "${phase}"`);
    }
  }
});
