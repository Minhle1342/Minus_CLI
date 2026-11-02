import path from 'node:path';
import { parseShellAst } from '../security/shell-ast-parser.js';
import { classifyGitCommand } from '../tools/git-command-policy.js';
import { CLOSED_GATES, type GateReader } from '../security/full-access-gates.js';

export type SandboxPolicyMode = 'strict' | 'workspace-write' | 'ephemeral-scratch' | 'unrestricted';

export type CommandRiskLevel = 'SAFE_READ_ONLY' | 'WORKSPACE_MUTATION' | 'SYSTEM_RISK' | 'UNAUTHORIZED_ESCAPE';

export interface CommandPolicyEvaluation {
  allowed: boolean;
  riskLevel: CommandRiskLevel;
  reason?: string;
  sanitizedCommand?: string;
  violations?: string[];
}

// Danh sách các mẫu lệnh hủy diệt hệ thống / nguy hiểm cực cao
const SYSTEM_DESTRUCTIVE_PATTERNS: RegExp[] = [
  /rm\s+(-[a-zA-Z]*r[a-zA-Z]*f*|-f[a-zA-Z]*r[a-zA-Z]*)\s+[\/\\]/i, // rm -rf /
  /rmdir\s+\/s\s+\/q\s+[c-zC-Z]:\\/i,                               // rmdir /s /q C:\
  /format\s+[c-zC-Z]:/i,                                             // format C:
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,                       // Bash fork bomb
  />\s*[\/\\]dev[\/\\]sd[a-z]/i,                                     // overwrite block devices
  /mkfs\./i,                                                         // format filesystems
  /dd\s+if=.*of=[\/\\]dev/i,                                         // dd to raw device
  /nc\s+-e\s+/i,                                                     // netcat reverse shell
  /bash\s+-i\s+>&/i,                                                 // interactive reverse shell
];

// Danh sách các file cấu hình và chứng chỉ nhạy cảm không được phép rò rỉ hoặc ghi đè mù
const SENSITIVE_FILE_PATTERNS: RegExp[] = [
  /\.env(\..+)?$/i,
  /\.gitconfig$/i,
  /\.ssh[\/\\]/i,
  /id_rsa/i,
  /id_ed25519/i,
  /\.aws[\/\\]credentials/i,
  /\.npmrc/i,
];

const SAFE_NULL_OR_STREAM_TARGETS = new Set([
  '/dev/null',
  'nul',
  'con',
  '/dev/stdout',
  '/dev/stderr',
]);

function isSafeReadOnlyRedirect(redirect: { type: string; target: string; fd?: number }): boolean {
  const target = (redirect.target || '').trim().toLowerCase();
  if (SAFE_NULL_OR_STREAM_TARGETS.has(target)) return true;
  // Bare digits are fds only for `2>&1`-style redirects. `cmd > 1` creates a file named "1".
  if (['>&', '<&'].includes(redirect.type) && /^&?[0-2]$/.test(target)) return true;
  return false;
}
// Các lệnh đọc an toàn khi bản thân executable không có khả năng ghi.
// Lệnh mà hiệu ứng phụ thuộc argument (psql, docker, curl, ...) được xử lý
// riêng bên dưới: chỉ khớp tên executable sẽ phân loại nhầm lệnh phá hoại
// (ví dụ `psql -c "DROP TABLE"`, `docker system prune`, `curl -o file`).
const SAFE_READ_ONLY_PREFIXES = [
  'cat', 'head', 'tail', 'less', 'more', 'type', 'Get-Content', 'gc',
  'ls', 'dir', 'tree', 'Get-ChildItem', 'gci',
  'grep', 'rg', 'ripgrep', 'findstr', 'Select-String', 'sls', 'find', 'fd',
  'wc', 'which', 'where', 'pwd', 'echo', 'printf', 'jq',
  'sort', 'uniq', 'cut', 'tr', 'sed', 'awk',
  'git status', 'git log', 'git diff', 'git show', 'git branch',
  // Network & system diagnostics (read-only by themselves)
  'ping', 'netstat', 'ss', 'lsof', 'nslookup', 'dig',
  'uname', 'whoami', 'id', 'hostname', 'uptime', 'df', 'du', 'free', 'ps', 'top',
];

/** Env assignments that alter how the child resolves code; must never be read-only. */
const DANGEROUS_ENV_ASSIGNMENTS = /^(?:LD_PRELOAD|LD_LIBRARY_PATH|DYLD_INSERT_LIBRARIES|NODE_OPTIONS)$/i;

const SAFE_FIND_EXEC_COMMANDS = new Set([
  'wc', 'cat', 'head', 'tail', 'file', 'stat', 'sha256sum', 'md5sum', 'grep', 'sort', 'uniq', 'cut'
]);

function isSafeFindCommand(args: string[]): boolean {
  if (args.some(arg => /^-(?:delete|execdir|ok|okdir|fprint|fprint0|fprintf)$/.test(arg))) {
    return false;
  }
  const execIdx = args.findIndex(arg => arg === '-exec');
  if (execIdx === -1) {
    return true;
  }
  const subCmd = args[execIdx + 1]?.toLowerCase();
  if (!subCmd || !SAFE_FIND_EXEC_COMMANDS.has(subCmd)) {
    return false;
  }
  // Check that the rest of exec args don't contain redirections or shell escape operators
  const execArgs = args.slice(execIdx + 1);
  return !execArgs.some(arg => /[><|;&`$]/.test(arg));
}

// ---------------------------------------------------------------------------
// Argument-aware read-only classification.
//
// Matching a bare executable name is not enough for CLIs whose effect depends
// on their arguments. These helpers return true only when every detectable
// effect is a read, and fail closed on anything they cannot inspect.
// ---------------------------------------------------------------------------

const SQL_READ_ONLY_START = /^\s*(?:select|show|describe|desc|explain|pragma|values|with)\b/i;
const SQL_MUTATING_KEYWORD = /\b(?:insert|update|delete|drop|alter|create|truncate|grant|revoke|merge|replace|vacuum|attach|detach|copy|call|do|set|reset|use|rename|lock|listen|notify|discard|reindex|cluster|comment|security|import|load|install|flushall|flushdb|config|shutdown|script|migrate|restore|backup|del|unlink|hset|hmset|lpush|rpush|sadd|zadd|zrem|expire|persist|publish|eval|exec|multi|slaveof|replicaof|bgsave|swapdb)\b/i;

function isReadOnlySql(sql: string): boolean {
  return SQL_READ_ONLY_START.test(sql) && !SQL_MUTATING_KEYWORD.test(sql);
}

function hasAnyFlag(args: string[], names: string[]): boolean {
  return args.some(arg => names.includes(arg.split('=')[0]));
}

function collectOptionValues(args: string[], names: string[]): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    for (const name of names) {
      if (arg === name) {
        if (i + 1 < args.length) values.push(args[i + 1]);
      } else if (arg.startsWith(`${name}=`)) {
        values.push(arg.slice(name.length + 1));
      }
    }
  }
  return values;
}

function positionalArgs(args: string[], valueFlags: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (valueFlags.includes(arg)) {
      i += 1;
      continue;
    }
    if (arg.startsWith('-')) continue;
    out.push(arg);
  }
  return out;
}

/** `psql -c "SELECT 1"`: -f/-o run or write things we cannot inspect. */
function isPostgresReadOnly(args: string[]): boolean {
  if (hasAnyFlag(args, ['-f', '--file', '-o', '--output'])) return false;
  const commands = collectOptionValues(args, ['-c', '--command']);
  if (commands.length === 0) return false; // interactive REPL / script file
  return commands.every(isReadOnlySql);
}

/** `mysql -e "SHOW TABLES"`. */
function isMysqlReadOnly(args: string[]): boolean {
  const commands = collectOptionValues(args, ['-e', '--execute']);
  if (commands.length === 0) return false;
  return commands.every(isReadOnlySql);
}

const SQLITE_READ_ONLY_META = /^\.(?:tables|schema|indexes|databases|fullschema|dump|headers|mode|nullvalue|timeout|print|help)\b/i;

function isSqliteReadOnly(args: string[]): boolean {
  // -cmd/-init/--append run statements or open files we cannot inspect.
  if (hasAnyFlag(args, ['-cmd', '--cmd', '-init', '-A', '--append'])) return false;
  const positional = positionalArgs(args, ['-separator']);
  const statements = positional.slice(1); // positional[0] is the database file
  if (statements.length === 0) return false;
  return statements.every(statement => SQLITE_READ_ONLY_META.test(statement) || isReadOnlySql(statement));
}

const MONGO_READ_HINT = /\b(?:find|findOne|stats|getCollectionNames|getCollectionInfos|count|countDocuments|estimatedDocumentCount|distinct|aggregate|explain|listCollections|listDatabases|version|serverStatus|buildInfo|getIndexes|dbStats|collStats|isMaster|hello|show)\b/i;
const MONGO_MUTATING_METHOD = /\b(?:insert|insertOne|insertMany|update|updateOne|updateMany|replaceOne|deleteOne|deleteMany|drop|dropDatabase|dropCollection|create|createIndex|createUser|renameCollection|bulkWrite|findOneAndUpdate|findOneAndDelete|findOneAndReplace|save|remove|runCommand|mapReduce|kill|shutdown|setProfilingLevel|addUser|grantRolesToUser)\b/i;

function isMongoReadOnly(args: string[]): boolean {
  if (hasAnyFlag(args, ['--file', '-f'])) return false;
  const scripts = collectOptionValues(args, ['--eval', '-e']);
  if (scripts.length === 0) return false; // interactive shell
  return scripts.every(script => !MONGO_MUTATING_METHOD.test(script) && MONGO_READ_HINT.test(script));
}

const REDIS_READ_COMMANDS = new Set([
  'ping', 'info', 'get', 'mget', 'strlen', 'exists', 'type', 'ttl', 'pttl', 'keys', 'scan',
  'dbsize', 'llen', 'lrange', 'lindex', 'smembers', 'scard', 'sismember', 'zrange', 'zcard',
  'zscore', 'hget', 'hgetall', 'hmget', 'hkeys', 'hvals', 'hlen', 'hexists', 'xinfo', 'xlen',
  'xrange', 'latency', 'time', 'lastsave', 'role', 'echo',
]);

function isRedisReadOnly(args: string[]): boolean {
  const valueFlags = ['-h', '-p', '-a', '-u', '-s', '-n', '--user', '--pass', '--tls-cacert', '--tls-cert', '--tls-key', '--tls-sni', '--uri'];
  const [command, subcommand] = positionalArgs(args, valueFlags).map(token => token.toLowerCase());
  if (!command) return false;
  if (command === 'config') return subcommand === 'get';
  if (command === 'client') return ['list', 'info', 'getname'].includes(subcommand || '');
  if (command === 'slowlog') return ['get', 'len'].includes(subcommand || '');
  if (command === 'command') return ['info', 'count', 'docs'].includes(subcommand || '');
  if (command === 'cluster') return ['info', 'nodes', 'slots'].includes(subcommand || '');
  if (command === 'pubsub') return ['channels', 'numsub', 'numpat'].includes(subcommand || '');
  if (command === 'memory') return ['usage', 'stats', 'doctor'].includes(subcommand || '');
  return REDIS_READ_COMMANDS.has(command);
}

const DOCKER_READ_ONLY_LEAF = new Set([  'ps', 'images', 'inspect', 'logs', 'version', 'info', 'stats', 'top', 'port', 'diff', 'history', 'events', 'search',
]);
const DOCKER_READ_ONLY_GROUPS: Record<string, Set<string>> = {
  image: new Set(['ls', 'list', 'inspect', 'history']),
  container: new Set(['ls', 'list', 'inspect', 'logs', 'stats', 'top', 'port', 'diff']),
  volume: new Set(['ls', 'list', 'inspect']),
  network: new Set(['ls', 'list', 'inspect']),
  compose: new Set(['ps', 'logs', 'config', 'images', 'top', 'version']),
  system: new Set(['df', 'info', 'events']),
  context: new Set(['ls', 'inspect', 'show']),
  node: new Set(['ls', 'inspect', 'ps']),
  service: new Set(['ls', 'inspect', 'ps', 'logs']),
};
const DOCKER_VALUE_FLAGS = new Set(['-f', '--file', '--profile', '-p', '--project-name', '--env-file', '-H', '--host', '--context', '--log-level', '--format']);
const DOCKER_EXEC_VALUE_FLAGS = new Set(['-e', '--env', '--env-file', '-u', '--user', '-w', '--workdir', '--detach-keys']);

function skipFlags(args: string[], start: number, valueFlags: Set<string>): number {
  let i = start;
  while (i < args.length && args[i].startsWith('-')) {
    if (args[i] === '--') return i + 1;
    i += valueFlags.has(args[i]) ? 2 : 1;
  }
  return i;
}

function isComposeReadOnly(args: string[]): boolean {
  const idx = skipFlags(args, 0, DOCKER_VALUE_FLAGS);
  const verb = args[idx]?.toLowerCase();
  return Boolean(verb && DOCKER_READ_ONLY_GROUPS.compose.has(verb));
}

function isDockerExecReadOnly(args: string[]): boolean {
  // docker exec [OPTIONS] CONTAINER COMMAND [ARG...]
  const containerIdx = skipFlags(args, 1, DOCKER_EXEC_VALUE_FLAGS);
  const nested = args.slice(containerIdx + 1);
  if (nested.length === 0) return false;
  const executable = nested[0].toLowerCase().replace(/\.exe$/, '');
  const nestedArgs = nested.slice(1);
  switch (executable) {
    case 'psql': return isPostgresReadOnly(nestedArgs);
    case 'mysql': return isMysqlReadOnly(nestedArgs);
    case 'sqlite3': return isSqliteReadOnly(nestedArgs);
    case 'mongosh': case 'mongo': return isMongoReadOnly(nestedArgs);
    case 'redis-cli': return isRedisReadOnly(nestedArgs);
    default: return false;
  }
}

function isDockerReadOnly(args: string[]): boolean {
  const sub = args[0]?.toLowerCase();
  if (!sub) return false;
  if (sub === 'exec') return isDockerExecReadOnly(args);
  if (DOCKER_READ_ONLY_LEAF.has(sub)) return true;
  const group = DOCKER_READ_ONLY_GROUPS[sub];
  if (!group) return false;
  const idx = skipFlags(args, 1, DOCKER_VALUE_FLAGS);
  const verb = args[idx]?.toLowerCase();
  return Boolean(verb && group.has(verb));
}

function isPgDumpReadOnly(args: string[]): boolean {
  return !hasAnyFlag(args, ['-f', '--file']);
}

function isMysqlDumpReadOnly(args: string[]): boolean {
  return !hasAnyFlag(args, ['-r', '--result-file', '--tab']);
}

function isMongoDumpReadOnly(args: string[]): boolean {
  // Without --archive mongodump writes ./dump by default; --out picks a directory.
  return hasAnyFlag(args, ['--archive']) && !hasAnyFlag(args, ['-o', '--out']);
}

const CURL_LONG_WRITE_FLAGS = new Set([
  '--output', '--remote-name', '--remote-name-all', '--remote-header-name', '--data', '--data-raw',
  '--data-binary', '--data-urlencode', '--json', '--form', '--form-string', '--upload-file',
  '--request', '--config', '--trace', '--trace-ascii', '--stderr', '--dump-header', '--cookie-jar',
  '--libcurl', '--output-dir', '--create-dirs', '--etag-save', '--etag-compare',
]);
const CURL_SHORT_WRITE_CHARS = new Set(['o', 'O', 'J', 'd', 'F', 'T', 'X', 'K', 'D', 'c']);

function isCurlReadOnly(args: string[]): boolean {
  for (const arg of args) {
    if (CURL_LONG_WRITE_FLAGS.has(arg.split('=')[0])) return false;
    if (/^-[A-Za-z]+$/.test(arg)) {
      for (const ch of arg.slice(1)) {
        if (CURL_SHORT_WRITE_CHARS.has(ch)) return false;
      }
    }
  }
  return true;
}

function isWgetReadOnly(args: string[]): boolean {
  // wget writes a file unless explicitly streaming to stdout.
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '-O' || arg === '--output-document') return args[i + 1] === '-';
    if (arg.startsWith('--output-document=')) return arg.slice('--output-document='.length) === '-';
    if (/-O-/.test(arg) || /O-$/.test(arg)) return true;
  }
  return false;
}

function isSedReadOnly(args: string[]): boolean {
  return !args.some(arg => /^-[A-Za-z]*i/.test(arg) || /^--in-place(?:=|$)/.test(arg));
}

function isSortReadOnly(args: string[]): boolean {
  return !args.some(arg => arg === '-o' || /^--output(?:=|$)/.test(arg) || /^--compress-program(?:=|$)/.test(arg));
}

function isUniqReadOnly(args: string[]): boolean {
  // `uniq input output` writes to output; two positionals mean a write target.
  return positionalArgs(args, ['-f', '--skip-fields', '-s', '--skip-chars', '-w', '--check-chars']).length < 2;
}

function isAwkReadOnly(args: string[]): boolean {
  // The program is opaque: `print > "file"` writes. Fail closed on redirects.
  return !args.some(arg => /[>|]/.test(arg));
}

function isFdReadOnly(args: string[]): boolean {
  // -x/--exec runs arbitrary commands for every match.
  return !args.some(arg => ['-x', '--exec', '-X', '--exec-batch'].includes(arg));
}


/**
 * SandboxPolicyEngine - Bộ Thực thi Quy tắc Bảo mật & Giới hạn Ranh giới Workspace (Codex Standard)
 */
export class SandboxPolicyEngine {
  private mode: SandboxPolicyMode;
  private workspaceRoot: string;
  private allowedPaths: Set<string> = new Set();
  /** Reader gate full access; mặc định đóng ⇒ hành vi y hệt trước khi có mode mới. */
  private gates: GateReader = CLOSED_GATES;

  constructor(workspaceRoot: string, mode: SandboxPolicyMode = 'workspace-write', gates?: GateReader) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.mode = mode;
    if (gates) this.gates = gates;
    this.allowedPaths.add(this.workspaceRoot);
  }

  getMode(): SandboxPolicyMode {
    return this.mode;
  }

  setMode(mode: SandboxPolicyMode): void {
    this.mode = mode;
  }

  /**
   * Kiểm tra xem đường dẫn tệp tin có nằm hoàn toàn bên trong ranh giới Sandbox Workspace không
   */
  isPathContained(targetPath: string, customRoot?: string): boolean {
    // Gate 3 (workspace_boundary): full access xóa ranh giới, mọi path đều "contained".
    if (this.gates('workspace_boundary')) return true;
    const root = customRoot ? path.resolve(customRoot) : this.workspaceRoot;
    const resolved = path.resolve(root, targetPath);
    const relative = path.relative(root, resolved);
    return !relative.startsWith('..') && !path.isAbsolute(relative);
  }

  /**
   * Kiểm tra xem tệp tin có thuộc diện nhạy cảm / chứa secrets không
   */
  isSensitiveFile(filePath: string): boolean {
    const normalized = filePath.replace(/\\/g, '/');
    return SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(normalized));
  }

  /**
   * Đánh giá rủi ro và phê duyệt lệnh shell trước khi cho phép thực thi
   */
  evaluateCommand(command: string, cwd?: string): CommandPolicyEvaluation {
    if (!command || !command.trim()) {
      return { allowed: false, riskLevel: 'SAFE_READ_ONLY', reason: 'Empty command.' };
    }

    const trimmed = command.trim();

    // 1. Chặn các lệnh hủy diệt hệ điều hành nghiêm trọng (gate 2 — mở khi full access)
    if (!this.gates('host_system_risk')) {
      for (const pattern of SYSTEM_DESTRUCTIVE_PATTERNS) {
        if (pattern.test(trimmed)) {
          return {
            allowed: false,
            riskLevel: 'SYSTEM_RISK',
            reason: `Command rejected by Sandbox Policy Engine: detected dangerous system-destructive command pattern (${pattern}).`,
          };
        }
      }
    }

    // 2. Kiểm tra chế độ Unrestricted
    if (this.mode === 'unrestricted') {
      return { allowed: true, riskLevel: 'WORKSPACE_MUTATION', sanitizedCommand: trimmed };
    }

    // Containment applies to reads as well as writes, before any early admission.
    if (cwd && !this.isPathContained(path.resolve(this.workspaceRoot, cwd))) {
      return { allowed: false, riskLevel: 'UNAUTHORIZED_ESCAPE', reason: `Working directory "${cwd}" is outside the workspace.` };
    }

    const analysis = parseShellAst(trimmed);
    const SAFE_READ_ONLY_OPERATORS = new Set(['|', '&&', '||', ';', 'newline']);
    const hasSafeOperators = analysis.operators.length === 0 || analysis.operators.every(op => SAFE_READ_ONLY_OPERATORS.has(op));
    const isObfuscationSafe = !analysis.hasObfuscation || (
      analysis.obfuscationReasons.length === 1 &&
      analysis.obfuscationReasons[0] === 'Dynamic shell eval/exec detected.' &&
      analysis.commands.some(c => c.executable.toLowerCase() === 'find')
    );
    const isReadOnly = !analysis.error && !analysis.hasSubshell && hasSafeOperators && isObfuscationSafe && analysis.commands.length > 0
      && analysis.commands.every((command) => {
        if (command.assignments.some(assign => DANGEROUS_ENV_ASSIGNMENTS.test(assign.key))) {
          return false;
        }
        if (command.redirects.length && !command.redirects.every(isSafeReadOnlyRedirect)) return false;
        const executable = command.executable.toLowerCase();
        const baseExecutable = executable.replace(/\.exe$/, '');
        const args = command.args;
        if (executable === 'git' || executable === 'git.exe') {
          // Global config, external diff drivers and output files can change effects.
          if (!args.length || args[0].startsWith('-') || args.some(arg => /^--(?:output|ext-diff|textconv|exec-path)(?:=|$)/i.test(arg))) return false;
          return classifyGitCommand(args[0], args.slice(1)).risk === 'read';
        }
        if (executable === 'codegraph' || executable === 'codegraph.exe') {
          return args.length > 0
            && ['explore', 'node', 'search', 'callers', 'callees', 'impact', 'status'].includes(args[0].toLowerCase());
        }
        if (baseExecutable === 'env' || baseExecutable === 'printenv') return args.length === 0;
        if (baseExecutable === 'find') {
          return isSafeFindCommand(args);
        }
        if (['rg', 'ripgrep'].includes(baseExecutable) && args.some(arg => /^--pre(?:=|$)/.test(arg))) return false;
        // CLIs whose safety depends on arguments: never trust the executable name alone.
        if (baseExecutable === 'psql') return isPostgresReadOnly(args);
        if (baseExecutable === 'mysql') return isMysqlReadOnly(args);
        if (baseExecutable === 'sqlite3') return isSqliteReadOnly(args);
        if (baseExecutable === 'mongosh' || baseExecutable === 'mongo') return isMongoReadOnly(args);
        if (baseExecutable === 'redis-cli') return isRedisReadOnly(args);
        if (baseExecutable === 'pg_dump') return isPgDumpReadOnly(args);
        if (baseExecutable === 'mysqldump') return isMysqlDumpReadOnly(args);
        if (baseExecutable === 'mongodump') return isMongoDumpReadOnly(args);
        if (baseExecutable === 'docker' || baseExecutable === 'podman') return isDockerReadOnly(args);
        if (baseExecutable === 'docker-compose' || baseExecutable === 'podman-compose') return isComposeReadOnly(args);
        if (baseExecutable === 'curl') return isCurlReadOnly(args);
        if (baseExecutable === 'wget') return isWgetReadOnly(args);
        if (baseExecutable === 'sed') return isSedReadOnly(args);
        if (baseExecutable === 'sort') return isSortReadOnly(args);
        if (baseExecutable === 'uniq') return isUniqReadOnly(args);
        if (baseExecutable === 'awk' || baseExecutable === 'gawk') return isAwkReadOnly(args);
        if (baseExecutable === 'tree') return !args.some(arg => arg === '-o' || /^--output(?:=|$)/.test(arg));
        if (baseExecutable === 'fd') return isFdReadOnly(args);
        // Exclude script interpreters and executable lookup wrappers.
        if (executable === 'node' || executable === 'node.exe') {
          return args.length === 1 && ['-v', '--version'].includes(args[0]);
        }
        if (['python', 'python3', 'npm', 'npx', 'bun', 'cargo', 'go', 'dotnet'].includes(baseExecutable)) {
          if (args.length === 1 && ['-v', '--version', '-V', 'version'].includes(args[0])) return true;
        }
        return SAFE_READ_ONLY_PREFIXES.some(prefix => !prefix.includes(' ') && prefix.toLowerCase() === executable);
      });

    if (isReadOnly) {
      return { allowed: true, riskLevel: 'SAFE_READ_ONLY', sanitizedCommand: trimmed };
    }

    // 4. Nếu ở chế độ strict (chỉ đọc), từ chối các lệnh thay đổi dữ liệu
    if (this.mode === 'strict') {
      return {
        allowed: false,
        riskLevel: 'WORKSPACE_MUTATION',
        reason: `Sandbox is running in strict (read-only) mode. State-modifying command "${trimmed}" is blocked.`,
      };
    }

    // 5. Kiểm tra CWD có nằm trong workspace không nếu có truyền vào
    if (cwd) {
      const resolvedCwd = path.resolve(this.workspaceRoot, cwd);
      if (!this.isPathContained(resolvedCwd)) {
        return {
          allowed: false,
          riskLevel: 'UNAUTHORIZED_ESCAPE',
          reason: `Execution denied: working directory "${cwd}" is outside the allowed Sandbox Workspace boundary (${this.workspaceRoot}).`,
        };
      }
    }

    return {
      allowed: true,
      riskLevel: 'WORKSPACE_MUTATION',
      sanitizedCommand: trimmed,
    };
  }

  /**
   * Lọc và làm sạch biến môi trường, loại bỏ các secret hoặc biến nguy hiểm
   */
  sanitizeEnvironment(rawEnv: Record<string, string | undefined>): Record<string, string> {
    const sanitized: Record<string, string> = {};
    // Gate 7 (child_env_scrub): full access giữ lại token host cho process con.
    const blockedKeys = this.gates('child_env_scrub')
      ? new Set<string>()
      : new Set([
        'NODE_OPTIONS',
        'LD_PRELOAD',
        'LD_LIBRARY_PATH',
        'DYLD_INSERT_LIBRARIES',
        'AWS_SECRET_ACCESS_KEY',
        'GITHUB_TOKEN',
      ]);

    for (const [key, value] of Object.entries(rawEnv)) {
      if (value !== undefined && !blockedKeys.has(key.toUpperCase())) {
        sanitized[key] = value;
      }
    }

    return sanitized;
  }
}
