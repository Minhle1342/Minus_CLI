import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  checkWorkspaceChanges,
  findCliRoot,
  parseGitPorcelain,
  resolveUpdateSource,
  shortRepoLabel,
  updateCli,
  type ExecRunner,
} from './cli-updater.js';

function makeTempCli(files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-updater-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'mini-agent-loop', version: '1.0.0' }));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

function fakeRunner(handlers: Record<string, string | Error>): ExecRunner {
  return async (cmd: string, args: string[]) => {
    const key = `${cmd} ${args.join(' ')}`;
    const outcome = handlers[key];
    if (outcome instanceof Error) throw outcome;
    if (outcome === undefined) throw new Error(`unexpected command: ${key}`);
    return { stdout: outcome, stderr: '' };
  };
}

const CLEAN_GIT: Record<string, string> = {
  'git rev-parse --is-inside-work-tree': 'true\n',
  'git rev-parse --abbrev-ref HEAD': 'develop\n',
  'git rev-parse HEAD': 'aaa111\n',
  'git status --porcelain': '',
  'git rev-parse --abbrev-ref --symbolic-full-name @{u}': 'origin/develop\n',
  'git rev-list --left-right --count HEAD...@{u}': '0\t0\n',
};

test('parseGitPorcelain handles renames, quotes, and statuses', () => {
  const entries = parseGitPorcelain(' M src/index.ts\n?? new file.txt\nR  old.ts -> "new dir/new.ts"\nA  added.ts\n');
  assert.deepEqual(entries, [
    { status: ' M', path: 'src/index.ts' },
    { status: '??', path: 'new file.txt' },
    { status: 'R ', path: 'new dir/new.ts' },
    { status: 'A ', path: 'added.ts' },
  ]);
  assert.deepEqual(parseGitPorcelain(''), []);
});

test('findCliRoot locates the mini-agent-loop package upward', () => {
  const dir = makeTempCli();
  try {
    const nested = path.join(dir, 'src', 'tools');
    fs.mkdirSync(nested, { recursive: true });
    assert.equal(findCliRoot(nested), dir);
    const foreign = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-updater-foreign-'));
    try {
      assert.equal(findCliRoot(foreign), undefined);
    } finally {
      fs.rmSync(foreign, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('checkWorkspaceChanges reports a clean, up-to-date tree', async () => {
  const dir = makeTempCli();
  try {
    const check = await checkWorkspaceChanges(dir, fakeRunner(CLEAN_GIT));
    assert.equal(check.isGitRepo, true);
    assert.equal(check.gitAvailable, true);
    assert.equal(check.branch, 'develop');
    assert.equal(check.head, 'aaa111');
    assert.equal(check.upstream, 'origin/develop');
    assert.equal(check.dirty, false);
    assert.equal(check.behind, 0);
    assert.equal(check.version, '1.0.0');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('checkWorkspaceChanges reports dirty files and behind counts', async () => {
  const dir = makeTempCli();
  try {
    const check = await checkWorkspaceChanges(
      dir,
      fakeRunner({
        ...CLEAN_GIT,
        'git status --porcelain': ' M src/index.ts\n?? scratch.txt\n',
        'git rev-list --left-right --count HEAD...@{u}': '1\t3\n',
      }),
    );
    assert.equal(check.dirty, true);
    assert.equal(check.changes.length, 2);
    assert.equal(check.ahead, 1);
    assert.equal(check.behind, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('checkWorkspaceChanges degrades when git is missing or there is no repo', async () => {
  const dir = makeTempCli();
  try {
    const noGit = await checkWorkspaceChanges(dir, async () => {
      throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
    });
    assert.equal(noGit.gitAvailable, false);
    assert.equal(noGit.isGitRepo, false);

    const noRepo = await checkWorkspaceChanges(
      dir,
      fakeRunner({ 'git rev-parse --is-inside-work-tree': 'false\n' }),
    );
    assert.equal(noRepo.isGitRepo, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('updateCli refuses to pull over uncommitted changes', async () => {
  const dir = makeTempCli();
  try {
    const calls: string[] = [];
    const result = await updateCli(
      dir,
      {},
      async (cmd: string, args: string[]) => {
        calls.push(`${cmd} ${args.join(' ')}`);
        const key = `${cmd} ${args.join(' ')}`;
        const table: Record<string, string> = {
          ...CLEAN_GIT,
          'git status --porcelain': ' M src/index.ts\n',
        };
        if (!(key in table)) throw new Error(`unexpected command: ${key}`);
        return { stdout: table[key], stderr: '' };
      },
    );
    assert.equal(result.ok, false);
    assert.match(result.message, /uncommitted change/);
    assert.ok(!calls.some((c) => c.startsWith('git pull')), 'must not pull over a dirty tree');
    assert.ok(!calls.some((c) => c.includes('npm')), 'must not install/build after refusing');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveUpdateSource defaults to the owner develop branch', () => {
  delete process.env.MINUS_UPDATE_REPO_URL;
  delete process.env.MINUS_UPDATE_BRANCH;
  assert.deepEqual(resolveUpdateSource(), {
    repoUrl: 'https://github.com/Minhle1342/Minus_CLI.git',
    branch: 'develop',
  });
  assert.equal(shortRepoLabel('https://github.com/Minhle1342/Minus_CLI.git'), 'Minhle1342/Minus_CLI');
  assert.deepEqual(resolveUpdateSource({ branch: 'main' }).branch, 'main');
  process.env.MINUS_UPDATE_BRANCH = 'release';
  try {
    assert.equal(resolveUpdateSource().branch, 'release');
  } finally {
    delete process.env.MINUS_UPDATE_BRANCH;
  }
});

test('updateCli fast-forwards to the canonical develop and rebuilds', async () => {
  const dir = makeTempCli();
  const calls: string[] = [];
  let head = 'aaa111';
  const canonicalFetch = 'git fetch https://github.com/Minhle1342/Minus_CLI.git develop';
  const result = await updateCli(
    dir,
    {},
    async (cmd: string, args: string[]) => {
      const key = `${cmd} ${args.join(' ')}`;
      calls.push(key);
      switch (key) {
        case 'git rev-parse --is-inside-work-tree':
          return { stdout: 'true\n', stderr: '' };
        case 'git rev-parse --abbrev-ref HEAD':
          return { stdout: 'develop\n', stderr: '' };
        case 'git rev-parse HEAD':
          return { stdout: `${head}\n`, stderr: '' };
        case 'git status --porcelain':
          return { stdout: '', stderr: '' };
        case 'git rev-parse --abbrev-ref --symbolic-full-name @{u}':
          return { stdout: 'origin/develop\n', stderr: '' };
        case 'git rev-list --left-right --count HEAD...@{u}':
          return { stdout: '0\t0\n', stderr: '' };
        case 'git rev-parse FETCH_HEAD':
          return { stdout: 'bbb222\n', stderr: '' };
        case 'git merge-base --is-ancestor HEAD FETCH_HEAD':
          return { stdout: '', stderr: '' };
        case 'git merge --ff-only FETCH_HEAD':
          head = 'bbb222';
          return { stdout: 'Fast-forwarded\n', stderr: '' };
        case 'git diff --name-only aaa111 bbb222':
          return { stdout: 'package.json\nsrc/index.ts\n', stderr: '' };
        case 'npm install':
        case 'npm.cmd install':
          return { stdout: 'installed\n', stderr: '' };
        case 'npm run build':
        case 'npm.cmd run build':
          return { stdout: 'built\n', stderr: '' };
        default:
          if (key === canonicalFetch) return { stdout: '', stderr: '' };
          throw new Error(`unexpected command: ${key}`);
      }
    },
  );
  try {
    assert.equal(result.ok, true);
    assert.equal(result.pulled, true);
    assert.equal(result.installed, true);
    assert.equal(result.built, true);
    assert.equal(result.headAfter, 'bbb222');
    assert.match(result.message, /Minhle1342\/Minus_CLI#develop/);
    const fetchIndex = calls.indexOf(canonicalFetch);
    const ffIndex = calls.indexOf('git merge --ff-only FETCH_HEAD');
    const installIndex = calls.findIndex((c) => c.endsWith(' install'));
    const buildIndex = calls.findIndex((c) => c.endsWith('run build'));
    assert.ok(fetchIndex >= 0 && ffIndex > fetchIndex && installIndex > ffIndex && buildIndex > installIndex, 'order: fetch, ff-merge, install, build');
    assert.ok(!calls.some((c) => c.startsWith('git pull')), 'must not use branch-upstream pull');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('updateCli refuses when not on the tracked branch', async () => {
  const dir = makeTempCli();
  try {
    const calls: string[] = [];
    const result = await updateCli(
      dir,
      {},
      async (cmd: string, args: string[]) => {
        const key = `${cmd} ${args.join(' ')}`;
        calls.push(key);
        if (key === 'git rev-parse --abbrev-ref HEAD') return { stdout: 'feature-x\n', stderr: '' };
        const table = CLEAN_GIT as Record<string, string>;
        if (!(key in table)) throw new Error(`unexpected command: ${key}`);
        return { stdout: table[key], stderr: '' };
      },
    );
    assert.equal(result.ok, false);
    assert.match(result.message, /not on the tracked branch/);
    assert.ok(!calls.some((c) => c.startsWith('git fetch')), 'must not fetch when refusing');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('updateCli refuses when local history diverged from canonical develop', async () => {
  const dir = makeTempCli();
  try {
    const result = await updateCli(
      dir,
      {},
      async (cmd: string, args: string[]) => {
        const key = `${cmd} ${args.join(' ')}`;
        if (key === 'git rev-parse --abbrev-ref HEAD') return { stdout: 'develop\n', stderr: '' };
        if (key === 'git rev-parse FETCH_HEAD') return { stdout: 'bbb222\n', stderr: '' };
        if (key === 'git merge-base --is-ancestor HEAD FETCH_HEAD') throw new Error('exit 1');
        if (key === 'git fetch https://github.com/Minhle1342/Minus_CLI.git develop') return { stdout: '', stderr: '' };
        const table = CLEAN_GIT as Record<string, string>;
        if (!(key in table)) throw new Error(`unexpected command: ${key}`);
        return { stdout: table[key], stderr: '' };
      },
    );
    assert.equal(result.ok, false);
    assert.match(result.message, /diverged/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('updateCli rebuilds without pulling when already latest', async () => {
  const dir = makeTempCli();
  try {
    const calls: string[] = [];
    const result = await updateCli(
      dir,
      {},
      async (cmd: string, args: string[]) => {
        const key = `${cmd} ${args.join(' ')}`;
        calls.push(key);
        if (key === 'git fetch https://github.com/Minhle1342/Minus_CLI.git develop') return { stdout: '', stderr: '' };
        if (key === 'git rev-parse FETCH_HEAD') return { stdout: 'aaa111\n', stderr: '' };
        if (key === 'git rev-parse --abbrev-ref HEAD') return { stdout: 'develop\n', stderr: '' };
        if (key.endsWith('run build')) return { stdout: 'built\n', stderr: '' };
        const table = CLEAN_GIT as Record<string, string>;
        if (!(key in table)) throw new Error(`unexpected command: ${key}`);
        return { stdout: table[key], stderr: '' };
      },
    );
    assert.equal(result.ok, true);
    assert.equal(result.pulled, false);
    assert.equal(result.built, true);
    assert.match(result.message, /latest/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('updateCli buildOnly rebuilds without touching git history', async () => {
  const dir = makeTempCli();
  try {
    const calls: string[] = [];
    const result = await updateCli(
      dir,
      { buildOnly: true },
      async (cmd: string, args: string[]) => {
        calls.push(`${cmd} ${args.join(' ')}`);
        return { stdout: 'built\n', stderr: '' };
      },
    );
    assert.equal(result.ok, true);
    assert.equal(result.built, true);
    assert.ok(!calls.some((c) => c.startsWith('git ')), 'build-only must not run git commands');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
