import { spawn } from 'node:child_process';
import { DockerSandbox } from '../sandbox/docker-sandbox.js';

const COMPOSE_FILE = 'deploy/searxng/compose.yaml';
const DOCKER_START_TIMEOUT_SECONDS = 120;

function runDockerCompose(): Promise<void> {
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

    child.once('error', reject);
    child.once('exit', (code, signal) => {
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
    throw new Error(
      'Docker daemon is unavailable. Start Docker Desktop, wait until it reports that the engine is running, then retry `npm run dev`.',
    );
  }

  await runDockerCompose();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\n[search:up] ${message}`);
  process.exitCode = 1;
});
