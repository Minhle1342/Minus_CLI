import assert from 'node:assert/strict';
import test from 'node:test';
import { moveFileTool } from './move-file.js';
import { replaceTextTool } from './replace-text.js';
import { createRunCommandTool } from './run-command.js';

test('run_command directs workspace moves to move_file instead of shell mv', () => {
  const tool = createRunCommandTool();
  const commandDescription = tool.parameters!.properties!.command.description!;

  assert.match(tool.description, /move_file.*sourcePath.*targetPath/i);
  assert.match(commandDescription, /never use shell `mv`/i);
});

test('move_file schema uses required sourcePath and targetPath, not destinationPath', () => {
  const parameters = moveFileTool.parameters!;
  const properties = parameters.properties!;

  assert.deepEqual(parameters.required, ['sourcePath', 'targetPath']);
  assert.match(moveFileTool.description, /Do not use `destinationPath`/i);
  assert.match(properties.targetPath.description!, /do not send destinationPath/i);
  assert.equal(properties.destinationPath, undefined);
});

test('replace_text schema requires re-reading and rebuilding an edit after a hash conflict', () => {
  const properties = replaceTextTool.parameters!.properties!;

  assert.match(replaceTextTool.description, /FILE_CONTENT_CHANGED.*re-read the current file/i);
  assert.match(properties.expectedFileHash.description!, /Always pass it/i);
  assert.match(properties.expectedFileHash.description!, /never blindly retry/i);
});
