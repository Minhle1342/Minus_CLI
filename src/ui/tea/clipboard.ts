import { spawn } from 'node:child_process';

/** Pass clipboard text through stdin so shell syntax in selections stays inert. */
export async function copyToClipboard(text: string): Promise<void> {
  const command = process.platform === 'win32' ? 'powershell.exe' : process.platform === 'darwin' ? 'pbcopy' : 'xclip';
  const args = process.platform === 'win32'
    ? ['-NoProfile', '-NonInteractive', '-STA', '-Command', '[Console]::InputEncoding = [System.Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())']
    : process.platform === 'darwin' ? [] : ['-selection', 'clipboard'];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    let error = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Clipboard operation timed out')); }, 5000);
    child.stderr.on('data', chunk => { error += chunk.toString(); });
    child.once('error', failure => { clearTimeout(timer); reject(failure); });
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(error.trim() || 'Could not copy to clipboard')); });
    child.stdin.on('error', () => {});
    child.stdin.end(text, 'utf8');
  });
}
