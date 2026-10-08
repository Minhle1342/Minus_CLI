import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
export interface EditorTerminal { suspend(): void; resume(): void }
export interface EditorOptions { editor?: string; launch?: (command: string, args: string[]) => Promise<void> }
export function editorArguments(editor: string): string[] {
  const words = editor.match(/"[^"]*"|'[^']*'|[^\s]+/g) || [];
  return words.map(word => /^['"]/.test(word) ? word.slice(1, -1) : word);
}
async function launch(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: false, windowsHide: true });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`Editor exited with ${signal || code}`)));
  });
}
export async function openExternalEditor(value: string, terminal: EditorTerminal, options: EditorOptions = {}): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'minus-compose-'));
  const file = path.join(directory, 'prompt.md');
  try {
    await writeFile(file, value, { encoding: 'utf8', mode: 0o600 });
    const [command, ...args] = editorArguments(options.editor || process.env.VISUAL || process.env.EDITOR || (process.platform === 'win32' ? 'notepad.exe' : 'vi'));
    if (!command) throw new Error('EDITOR is empty');
    terminal.suspend();
    try { await (options.launch || launch)(command, [...args, file]); return await readFile(file, 'utf8'); }
    finally { terminal.resume(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
}
