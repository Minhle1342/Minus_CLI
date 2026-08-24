import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const writeQueues = new Map<string, Promise<void>>();

async function renameWithWindowsRetry(source: string, destination: string): Promise<void> {
  let lastError: unknown;
  for (const delayMs of [0, 10, 30, 75]) {
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    try {
      await fs.rename(source, destination);
      return;
    } catch (error: any) {
      lastError = error;
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error?.code)) throw error;
    }
  }
  throw lastError;
}

/** Serialize snapshot replacement per path and keep the visible file whole. */
export async function writeFileAtomically(filePath: string, content: string): Promise<void> {
  const previous = writeQueues.get(filePath) || Promise.resolve();
  const current = previous.catch(() => {}).then(async () => {
    const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporaryPath, content, 'utf8');
      await renameWithWindowsRetry(temporaryPath, filePath);
    } finally {
      await fs.unlink(temporaryPath).catch(() => {});
    }
  });
  writeQueues.set(filePath, current);
  try {
    await current;
  } finally {
    if (writeQueues.get(filePath) === current) writeQueues.delete(filePath);
  }
}
