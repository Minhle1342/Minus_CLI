import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createGenerateImageTool, IMAGE_GENERATION_MODEL, type ImageGenClient } from './generate-image.js';
import { Workspace } from '../workspace/workspace.js';
import { Session } from '../session/session.js';

function mockClient(base64 = Buffer.from('fake-png-bytes').toString('base64')): ImageGenClient {
  return {
    models: {
      generateContent: async () => ({
        candidates: [
          {
            content: {
              parts: [{ inlineData: { mimeType: 'image/png', data: base64 } }],
            },
          },
        ],
      }),
    },
  };
}

function failingClient(message: string): ImageGenClient {
  return {
    models: {
      generateContent: async () => {
        throw new Error(message);
      },
    },
  };
}

async function makeTempWorkspace(): Promise<Workspace> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'generate-image-test-'));
  return new Workspace(dir);
}

describe('generate_image tool', () => {
  it('requires a prompt', async () => {
    const tool = createGenerateImageTool(undefined, { client: mockClient(), apiKey: 'test-key' });
    const result = await tool.execute({}, new Workspace(os.tmpdir()));
    assert.equal(result.success, false);
    assert.equal(result.errorCode, 'INVALID_ARGS');
  });

  it('rejects an unsupported aspect ratio', async () => {
    const tool = createGenerateImageTool(undefined, { client: mockClient(), apiKey: 'test-key' });
    const result = await tool.execute({ prompt: 'a cat', aspectRatio: '99:1' }, new Workspace(os.tmpdir()));
    assert.equal(result.success, false);
    assert.equal(result.errorCode, 'INVALID_ARGS');
  });

  it('fails cleanly when GEMINI_API_KEY is not configured', async () => {
    const tool = createGenerateImageTool();
    const result = await tool.execute({ prompt: 'a cat' }, new Workspace(os.tmpdir()));
    assert.equal(result.success, false);
    assert.equal(result.errorCode, 'EXECUTION_ERROR');
    assert.match(result.error, /GEMINI_API_KEY/);
  });

  it('saves the generated image inside the workspace and reports metadata', async () => {
    const workspace = await makeTempWorkspace();
    const tool = createGenerateImageTool(undefined, { client: mockClient(), apiKey: 'test-key' });
    const result = await tool.execute(
      { prompt: 'a minimal banner for a CLI tool', outputPath: 'assets/banner.png' },
      workspace,
    );

    assert.equal(result.success, true);
    assert.equal(result.filePath, 'assets/banner.png');
    assert.equal(result.mimeType, 'image/png');
    assert.equal(result.model, IMAGE_GENERATION_MODEL);
    assert.ok(result.fileSizeBytes > 0);

    const onDisk = await fs.readFile(path.join(workspace.rootDir, 'assets', 'banner.png'));
    assert.equal(onDisk.toString(), 'fake-png-bytes');
  });

  it('defaults the output path to assets/generated/<slug>-<timestamp>.png', async () => {
    const workspace = await makeTempWorkspace();
    const tool = createGenerateImageTool(undefined, { client: mockClient(), apiKey: 'test-key' });
    const result = await tool.execute({ prompt: 'diagram of a rocket' }, workspace);

    assert.equal(result.success, true);
    assert.match(result.filePath, /^assets\/generated\/diagram-of-a-rocket-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.png$/);
    assert.ok((await fs.stat(path.join(workspace.rootDir, result.filePath))).isFile());
  });

  it('rejects output paths that escape the workspace', async () => {
    const workspace = await makeTempWorkspace();
    const tool = createGenerateImageTool(undefined, { client: mockClient(), apiKey: 'test-key' });
    const result = await tool.execute({ prompt: 'a cat', outputPath: '../evil.png' }, workspace);

    assert.equal(result.success, false);
    assert.equal(result.errorCode, 'SECURITY_VIOLATION');
    assert.equal(await fs.readdir(path.join(path.dirname(workspace.rootDir))).then((entries) => entries.includes('evil.png')), false);
  });

  it('attaches the generated image to the session multimodal context', async () => {
    const workspace = await makeTempWorkspace();
    const session = new Session('generate-image-test-session');
    const tool = createGenerateImageTool(() => session, { client: mockClient(), apiKey: 'test-key' });
    const result = await tool.execute(
      { prompt: 'an icon of a lightning bolt', outputPath: 'icon.png' },
      workspace,
    );

    assert.equal(result.success, true);
    assert.equal(result.attachedToMultimodalContext, true);

    const events = session.getEvents().filter((event) => event.type === 'user/message');
    const last = events.at(-1);
    assert.ok(last, 'session received an injected multimodal message');
    assert.equal((last as any).data.source, 'injected');
    const parts = (last as any).data.content.parts;
    assert.ok(parts.some((part: any) => part.inlineData?.mimeType === 'image/png'));
  });

  it('maps model errors to EXECUTION_ERROR', async () => {
    const workspace = await makeTempWorkspace();
    const tool = createGenerateImageTool(undefined, { client: failingClient('quota exceeded'), apiKey: 'test-key' });
    const result = await tool.execute({ prompt: 'a cat' }, workspace);

    assert.equal(result.success, false);
    assert.equal(result.errorCode, 'EXECUTION_ERROR');
    assert.match(result.error, /quota exceeded/);
  });

  it('reports when the model returns no image data', async () => {
    const workspace = await makeTempWorkspace();
    const emptyClient: ImageGenClient = {
      models: {
        generateContent: async () => ({ candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }] }),
      },
    };
    const tool = createGenerateImageTool(undefined, { client: emptyClient, apiKey: 'test-key' });
    const result = await tool.execute({ prompt: 'a cat' }, workspace);

    assert.equal(result.success, false);
    assert.equal(result.errorCode, 'EXECUTION_ERROR');
    assert.match(result.error, /no image data/);
  });
});
