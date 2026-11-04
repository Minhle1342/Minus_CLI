import assert from 'node:assert/strict';
import test from 'node:test';
import { replaceTextTool } from './replace-text.js';
import { readFileTool } from './read-file.js';

test('replace_text schema requires re-reading and rebuilding an edit after a hash conflict', () => {
  const properties = replaceTextTool.parameters!.properties!;

  assert.match(replaceTextTool.description, /FILE_CONTENT_CHANGED.*re-read the current file/i);
  assert.match(properties.expectedFileHash.description!, /Always pass it/i);
  assert.match(properties.expectedFileHash.description!, /never blindly retry/i);
});

test('read_file schema documents the line-numbered edit contract', () => {
  const properties = readFileTool.parameters!.properties!;

  assert.match(readFileTool.description, /N: .*line-number prefix/i);
  assert.match(readFileTool.description, /contentHash.*expectedFileHash/i);
  assert.match(properties.includeLineNumbers.description!, /auto-strip/i);
});

test('replace_text schema documents line-number tolerance and suggestedOldText recovery', () => {
  const properties = replaceTextTool.parameters!.properties!;

  assert.match(replaceTextTool.description, /line-number prefixes are auto-stripped/i);
  assert.match(replaceTextTool.description, /suggestedOldText/);
  assert.match(properties.oldText.description!, /line-number prefixes/i);
  assert.match(properties.matchMode.description!, /line-number prefixes/i);
});
