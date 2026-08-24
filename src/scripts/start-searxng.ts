import { spawn } from 'node:child_process';
import { DockerSandbox } from '../sandbox/docker-sandbox.js';

const COMPOSE_FILE = 'deploy/searxng/compose.yaml';
const DOCKER_START_TIMEOUT_SECONDS = parseInt(process.env.DOCKER_START_TIMEOUT_SECONDS || '20', 10);
const DOCKER_COMPOSE_TIMEOUT_MS = parseInt(process.env.DOCKER_COMPOSE_TIMEOUT_MS || '20000', 10);

function runDockerCompose(timeoutMs: number = DOCKER_COMPOSE_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'docker',
      ['compose', '-f', COMPOSE_FILE, 'up', '-d'],
      {
        cwd: process.cwd(),
        stdio: 'inherit',
        windowsHide: true,
      },
    );

    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {}
      reject(new Error(`docker compose timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }

      const reason = signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`;
      reject(new Error(`docker compose failed with ${reason}.`));
    });
  });
}

async function main(): Promise<void> {
  const docker = new DockerSandbox({ workspacePath: process.cwd() });
  let dockerReady = await docker.isAvailable();

  if (!dockerReady) {
    dockerReady = await docker.startDockerDaemon(DOCKER_START_TIMEOUT_SECONDS);
  }

  if (!dockerReady) {
    console.warn(
      `\n\x1b[33m⚠️  [search:up] Docker daemon không khởi động sau ${DOCKER_START_TIMEOUT_SECONDS}s. Tự động bỏ qua và tiếp tục chạy ứng dụng.\x1b[0m\n`,
    );
    return;
  }

  try {
    await runDockerCompose();
    console.log(`\x1b[32m✔ [search:up] SearXNG container đã khởi chạy thành công.\x1b[0m`);
  } catch (composeError: any) {
    console.warn(
      `\n\x1b[33m⚠️  [search:up] Không thể khởi chạy SearXNG qua docker compose: ${composeError?.message || composeError}. Tự động bỏ qua.\x1b[0m\n`,
    );
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`\n\x1b[33m⚠️  [search:up] ${message}. Tự động bỏ qua.\x1b[0m\n`);
});
