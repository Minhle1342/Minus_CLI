import assert from 'node:assert/strict';
import test from 'node:test';
import { replaceTextTool } from './replace-text.js';
import { createRunCommandTool } from './run-command.js';

test('run_command directs workspace moves to move_file instead of shell mv', () => {
  const tool = createRunCommandTool();
  const commandDescription = tool.parameters!.properties!.command.description!;

  assert.match(tool.description, /move_file.*sourcePath.*targetPath/i);
  assert.match(commandDescription, /never use shell `mv`/i);
});

test('replace_text schema requires re-reading and rebuilding an edit after a hash conflict', () => {
  const properties = replaceTextTool.parameters!.properties!;

  assert.match(replaceTextTool.description, /FILE_CONTENT_CHANGED.*re-read the current file/i);
  assert.match(properties.expectedFileHash.description!, /Always pass it/i);
  assert.match(properties.expectedFileHash.description!, /never blindly retry/i);
});
