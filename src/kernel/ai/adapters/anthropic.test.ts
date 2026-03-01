import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import { AnthropicAdapter } from './anthropic.ts';
import type { Message, ToolDefinition } from '../adapter.ts';

describe('AnthropicAdapter', () => {
  it('formats tools into Anthropic schema', () => {
    const adapter = new AnthropicAdapter('test-key', 'claude-test', {
      messages: { create: async () => ({ content: [], usage: { input_tokens: 0, output_tokens: 0 } }) },
    } as unknown as Anthropic);

    const tools: ToolDefinition[] = [
      {
        name: 'search_glob',
        description: 'Search files',
        parameters: {
          type: 'object',
          properties: { pattern: { type: 'string' } },
        },
      },
    ];

    const formatted = adapter.formatTools(tools);
    assert.equal(formatted.length, 1);
    assert.equal(formatted[0]?.name, 'search_glob');
    assert.deepEqual(formatted[0]?.input_schema, tools[0]?.parameters);
  });

  it('maps messages and parses text/tool_use response blocks', async () => {
    let capturedRequest: unknown;
    const client = {
      messages: {
        create: async (request: unknown) => {
          capturedRequest = request;
          return {
            content: [
              { type: 'text', text: 'answer' },
              { type: 'tool_use', id: 'tool-1', name: 'search_glob', input: { pattern: '*.ts' } },
            ],
            usage: {
              input_tokens: 21,
              output_tokens: 7,
            },
          };
        },
      },
    } as unknown as Anthropic;

    const adapter = new AnthropicAdapter('test-key', 'claude-test', client);

    const messages: Message[] = [
      { role: 'system', content: 'system policy' },
      { role: 'user', content: 'find files' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'tool-0',
            type: 'function',
            function: { name: 'fs_list', arguments: '{"path":"src"}' },
          },
        ],
      },
      { role: 'tool', content: '{"files":[]}', tool_call_id: 'tool-0' },
    ];

    const tools: ToolDefinition[] = [
      {
        name: 'search_glob',
        description: 'Search files',
        parameters: { type: 'object', properties: { pattern: { type: 'string' } } },
      },
    ];

    const result = await adapter.chat(messages, tools);

    const request = capturedRequest as {
      model: string;
      max_tokens: number;
      system?: string;
      tools?: unknown[];
      messages: Array<{ role: string }>;
    };

    assert.equal(request.model, 'claude-test');
    assert.equal(request.max_tokens, 4096);
    assert.equal(request.system, 'system policy');
    assert.equal(Array.isArray(request.tools), true);
    assert.equal(request.messages.length, 3);

    assert.equal(result.content, 'answer');
    assert.equal(result.tool_calls?.[0]?.function.name, 'search_glob');
    assert.equal(result.tool_calls?.[0]?.function.arguments, '{"pattern":"*.ts"}');
    assert.deepEqual(result.usage, {
      prompt_tokens: 21,
      completion_tokens: 7,
      total_tokens: 28,
    });
  });

  it('returns null content when Anthropic has only tool_use blocks', async () => {
    const adapter = new AnthropicAdapter('test-key', 'claude-test', {
      messages: {
        create: async () => ({
          content: [{ type: 'tool_use', id: 'x', name: 'fs_read', input: { path: 'a.ts' } }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      },
    } as unknown as Anthropic);

    const result = await adapter.chat([{ role: 'user', content: 'x' }]);
    assert.equal(result.content, null);
    assert.equal(result.tool_calls?.[0]?.function.name, 'fs_read');
  });
});
