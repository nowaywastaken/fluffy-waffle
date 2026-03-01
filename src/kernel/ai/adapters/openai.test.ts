import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import OpenAI from 'openai';
import { OpenAIAdapter } from './openai.ts';
import type { Message, ToolDefinition } from '../adapter.ts';

describe('OpenAIAdapter', () => {
  it('formats tools into OpenAI function schema', () => {
    const adapter = new OpenAIAdapter('test-key', 'gpt-test', {
      chat: { completions: { create: async () => ({ choices: [] }) } },
    } as unknown as OpenAI);

    const tools: ToolDefinition[] = [
      {
        name: 'fs_read',
        description: 'Read file',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
        },
      },
    ];

    const formatted = adapter.formatTools(tools);
    assert.equal(formatted.length, 1);
    assert.deepEqual(formatted[0]?.function.name, 'fs_read');
    assert.deepEqual(formatted[0]?.function.parameters, tools[0]?.parameters);
  });

  it('maps message/tool payloads and parses OpenAI response', async () => {
    let capturedRequest: unknown;
    const client = {
      chat: {
        completions: {
          create: async (request: unknown) => {
            capturedRequest = request;
            return {
              choices: [
                {
                  message: {
                    content: 'assistant reply',
                    tool_calls: [
                      {
                        id: 'call-1',
                        type: 'function',
                        function: { name: 'fs_read', arguments: '{"path":"a.ts"}' },
                      },
                    ],
                  },
                },
              ],
              usage: {
                prompt_tokens: 10,
                completion_tokens: 3,
                total_tokens: 13,
              },
            };
          },
        },
      },
    } as unknown as OpenAI;

    const adapter = new OpenAIAdapter('test-key', 'gpt-test', client);

    const messages: Message[] = [
      { role: 'system', content: 'be strict' },
      { role: 'user', content: 'read file' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call-0',
            type: 'function',
            function: { name: 'fs_list', arguments: '{}' },
          },
        ],
      },
      { role: 'tool', content: '{"ok":true}', tool_call_id: 'call-0' },
    ];

    const tools: ToolDefinition[] = [
      {
        name: 'fs_read',
        description: 'Read file',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
      },
    ];

    const response = await adapter.chat(messages, tools);

    const req = capturedRequest as { model: string; messages: Array<{ role: string }>; tools?: unknown[]; tool_choice?: string };
    assert.equal(req.model, 'gpt-test');
    assert.equal(req.messages.length, 4);
    assert.equal(req.messages[3]?.role, 'tool');
    assert.equal(req.tool_choice, 'auto');
    assert.equal(Array.isArray(req.tools), true);

    assert.equal(response.content, 'assistant reply');
    assert.equal(response.tool_calls?.[0]?.function.name, 'fs_read');
    assert.deepEqual(response.usage, {
      prompt_tokens: 10,
      completion_tokens: 3,
      total_tokens: 13,
    });
  });

  it('throws when OpenAI response has no choices', async () => {
    const adapter = new OpenAIAdapter('test-key', 'gpt-test', {
      chat: {
        completions: {
          create: async () => ({ choices: [] }),
        },
      },
    } as unknown as OpenAI);

    await assert.rejects(
      () => adapter.chat([{ role: 'user', content: 'x' }]),
      /no choices/i,
    );
  });
});
