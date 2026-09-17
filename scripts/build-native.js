import { spawn } from 'node:child_process';
import { copyFile } from 'node:fs/promises';
import path from 'node:path';

const crateDir = path.resolve('crates', 'minus_core');
const artifactName = process.platform === 'win32'
  ? 'minus_core.dll'
  : process.platform === 'darwin'
    ? 'libminus_core.dylib'
    : 'libminus_core.so';
const source = path.join(crateDir, 'target', 'release', artifactName);
const destination = path.join(crateDir, 'minus_core.node');
const jobs = process.env.CARGO_BUILD_JOBS || '1';

const cargo = spawn('cargo', ['build', '--release', '--jobs', jobs], {
  cwd: crateDir,
  stdio: 'inherit',
});

cargo.once('error', (error) => {
  console.error(`Unable to start Cargo: ${error.message}`);
  process.exitCode = 1;
});

cargo.once('exit', async (code) => {
  if (code !== 0) {
    process.exitCode = code || 1;
    return;
  }
  try {
    await copyFile(source, destination);
    console.log(`Native addon ready: ${destination}`);
  } catch (error) {
    console.error(`Unable to package native addon: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
});
