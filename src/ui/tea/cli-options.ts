export interface TeaCliOptions { headless: boolean; plan?: boolean; prompt?: string; cliWorkspace?: string; cliModel?: string; cliSandbox?: string }
export function parseTeaCommandLine(args = process.argv.slice(2)): TeaCliOptions {
  const result: TeaCliOptions = { headless: false };
  const positional: string[] = [];
  let commandConsumed = false;
  for (let i = 0; i < args.length; i++) {
    const value = args[i];
    if (value === '--headless') { result.headless = true; continue; }
    if (value === '--plan') { result.plan = true; continue; }
    if (value === '--docker' || value === '--local') { result.cliSandbox = value === '--docker' ? 'docker' : 'local'; continue; }
    if (value === 'run' && positional.length === 0 && !commandConsumed) { result.headless = true; commandConsumed = true; continue; }
    const match = value.match(/^--(workspace|model|sandbox)(?:=(.*))?$/);
    if (match) {
      const argument = match[2] ?? args[++i];
      if (!argument || argument.startsWith('--')) throw new Error(`Missing value for --${match[1]}`);
      if (match[1] === 'workspace') result.cliWorkspace = argument;
      else if (match[1] === 'model') result.cliModel = argument;
      else result.cliSandbox = argument;
      continue;
    }
    if (value.startsWith('--')) throw new Error(`Unknown option: ${value}`);
    positional.push(value);
  }
  if (result.headless && positional.length) result.prompt = positional.join(' ');
  else if (!result.headless && positional.length) result.cliWorkspace ||= positional[0];
  return result;
}
