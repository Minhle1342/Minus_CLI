import assert from 'node:assert/strict';
import test from 'node:test';
import { SandboxPolicyEngine } from './sandbox-policy.js';

const engine = new SandboxPolicyEngine(process.cwd(), 'strict');
const risk = (command: string) => engine.evaluateCommand(command).riskLevel;

test('read-only command chains stay read-only', () => {
  for (const command of [
    'git status && git log --oneline',
    'git diff; git status',
    'git status\ngit log --oneline',
    'cat package.json | head -n 5',
  ]) {
    assert.equal(risk(command), 'SAFE_READ_ONLY', command);
  }
});

test('a chain with a mutating command is not read-only', () => {
  assert.notEqual(risk('cat package.json && rm -rf src'), 'SAFE_READ_ONLY');
});

test('fd redirects are read-only but writing to a file named like an fd is not', () => {
  assert.equal(risk('cat package.json 2>&1'), 'SAFE_READ_ONLY');
  assert.equal(risk('cat package.json 2>/dev/null'), 'SAFE_READ_ONLY');
  assert.notEqual(risk('cat package.json > 1'), 'SAFE_READ_ONLY');
  assert.notEqual(risk('cat package.json >> 2'), 'SAFE_READ_ONLY');
});

test('only read-only codegraph subcommands are sandbox-safe', () => {
  assert.equal(risk('codegraph explore AgentLoop'), 'SAFE_READ_ONLY');
  assert.equal(risk('codegraph impact AgentLoop'), 'SAFE_READ_ONLY');
  assert.equal(risk('codegraph status'), 'SAFE_READ_ONLY');
  assert.notEqual(risk('codegraph init'), 'SAFE_READ_ONLY');
  assert.notEqual(risk('codegraph sync'), 'SAFE_READ_ONLY');
});

test('dangerous environment assignments are not read-only', () => {
  assert.notEqual(risk('LD_PRELOAD=/tmp/evil.so cat package.json'), 'SAFE_READ_ONLY');
  assert.notEqual(risk('NODE_OPTIONS=--require=./evil.js node -v'), 'SAFE_READ_ONLY');
  assert.notEqual(risk('DYLD_INSERT_LIBRARIES=/tmp/evil.dylib ls'), 'SAFE_READ_ONLY');
  // Unrelated inline assignments stay read-only.
  assert.equal(risk('PGPASSWORD=secret psql -h localhost -d db -c "SELECT 1"'), 'SAFE_READ_ONLY');
});

test('database CLIs are read-only only for read-only statements', () => {
  assert.equal(risk('psql -h localhost -U user -d db -c "SELECT 1"'), 'SAFE_READ_ONLY');
  assert.equal(risk('psql -c "SHOW TABLES"'), 'SAFE_READ_ONLY');
  assert.notEqual(risk('psql -c "DROP TABLE users"'), 'SAFE_READ_ONLY');
  assert.notEqual(risk('psql -f migrate.sql'), 'SAFE_READ_ONLY');
  assert.notEqual(risk('psql -d db'), 'SAFE_READ_ONLY');

  assert.equal(risk('mysql -u user db -e "SHOW TABLES"'), 'SAFE_READ_ONLY');
  assert.notEqual(risk('mysql -u user db -e "DELETE FROM users"'), 'SAFE_READ_ONLY');

  assert.equal(risk('sqlite3 db.sqlite ".tables"'), 'SAFE_READ_ONLY');
  assert.equal(risk('sqlite3 db.sqlite "SELECT * FROM users"'), 'SAFE_READ_ONLY');
  assert.notEqual(risk('sqlite3 db.sqlite "DROP TABLE users"'), 'SAFE_READ_ONLY');

  assert.equal(risk('redis-cli -h localhost -p 6379 ping'), 'SAFE_READ_ONLY');
  assert.equal(risk('redis-cli get session:1'), 'SAFE_READ_ONLY');
  assert.notEqual(risk('redis-cli FLUSHALL'), 'SAFE_READ_ONLY');
  assert.notEqual(risk('redis-cli SET session:1 hacked'), 'SAFE_READ_ONLY');

  assert.equal(risk('mongosh --eval "db.stats()"'), 'SAFE_READ_ONLY');
  assert.notEqual(risk('mongosh --eval "db.dropDatabase()"'), 'SAFE_READ_ONLY');
});

test('container and network CLIs are read-only only for inspection commands', () => {
  assert.equal(risk('docker ps'), 'SAFE_READ_ONLY');
  assert.equal(risk('docker images'), 'SAFE_READ_ONLY');
  assert.equal(risk('docker compose -f docker-compose.yml logs'), 'SAFE_READ_ONLY');
  assert.notEqual(risk('docker system prune -af'), 'SAFE_READ_ONLY');
  assert.notEqual(risk('docker rm -f web'), 'SAFE_READ_ONLY');
  assert.notEqual(risk('docker run --rm alpine sh'), 'SAFE_READ_ONLY');
  assert.equal(risk('docker exec -i postgres psql -U user -d db -c "SELECT 1"'), 'SAFE_READ_ONLY');
  assert.notEqual(risk('docker exec -i postgres psql -c "DROP TABLE users"'), 'SAFE_READ_ONLY');

  assert.equal(risk('curl -s https://example.com'), 'SAFE_READ_ONLY');
  assert.notEqual(risk('curl -o out.html https://example.com'), 'SAFE_READ_ONLY');
  assert.notEqual(risk('curl -X POST https://example.com/api'), 'SAFE_READ_ONLY');
  assert.notEqual(risk('curl -d "a=1" https://example.com'), 'SAFE_READ_ONLY');
  assert.notEqual(risk('wget https://example.com/file.zip'), 'SAFE_READ_ONLY');
  assert.equal(risk('wget -qO- https://example.com'), 'SAFE_READ_ONLY');
  assert.notEqual(risk('nc -l 4444'), 'SAFE_READ_ONLY');
});

test('dump and in-place editing commands that write files are not read-only', () => {
  assert.equal(risk('pg_dump -h localhost -U user -d db'), 'SAFE_READ_ONLY');
  assert.notEqual(risk('pg_dump -f backup.sql db'), 'SAFE_READ_ONLY');
  assert.equal(risk('mysqldump -u user db'), 'SAFE_READ_ONLY');
  assert.notEqual(risk('mysqldump --result-file=backup.sql db'), 'SAFE_READ_ONLY');
  assert.notEqual(risk('mongodump'), 'SAFE_READ_ONLY');
  assert.notEqual(risk('sed -i "s/a/b/" file.txt'), 'SAFE_READ_ONLY');
  assert.equal(risk('sed -n "1,5p" file.txt'), 'SAFE_READ_ONLY');
  assert.notEqual(risk('sort -o sorted.txt input.txt'), 'SAFE_READ_ONLY');
  assert.notEqual(risk('uniq input.txt output.txt'), 'SAFE_READ_ONLY');
  assert.notEqual(risk('fd -x rm {}'), 'SAFE_READ_ONLY');
});
