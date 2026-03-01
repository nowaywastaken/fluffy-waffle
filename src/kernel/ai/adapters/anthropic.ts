import Anthropic from '@anthropic-ai/sdk';
import type { AIProviderAdapter, ToolDefinition, Message, AIResponse, ToolCall } from '../adapter.js';

export class AnthropicAdapter implements AIProviderAdapter {
  name = 'anthropic';
  private client: Anthropic;
  private model: string;

  constructor(apiKey: string, model: string = 'claude-3-opus-20240229', client?: Anthropic) {
    this.model = model;
    this.client = client ?? new Anthropic({ apiKey });
  }

  formatTools(tools: ToolDefinition[]): Anthropic.Tool[] {
    return tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters as Anthropic.Tool.InputSchema
    }));
  }

  async chat(messages: Message[], tools?: ToolDefinition[]): Promise<AIResponse> {
    const anthropicTools = tools ? this.formatTools(tools) : undefined;

    // Convert internal Message format to Anthropic format
    const systemMessage = messages.find(m => m.role === 'system');
    const conversationMessages = messages.filter(m => m.role !== 'system');

    const anthropicMessages: Anthropic.MessageParam[] = conversationMessages.map(msg => {
      if (msg.role === 'tool') {
        return {
          role: 'user', // Anthropic treats tool results as user messages block
          content: [
            {
              type: 'tool_result',
              tool_use_id: msg.tool_call_id!,
              content: msg.content || ''
            }
          ]
        };
      }
      if (msg.role === 'assistant') {
        const content: Anthropic.ContentBlockParam[] = [];
        if (msg.content) {
          content.push({ type: 'text', text: msg.content });
        }
        if (msg.tool_calls) {
          msg.tool_calls.forEach(call => {
            content.push({
              type: 'tool_use',
              id: call.id,
              name: call.function.name,
              input: JSON.parse(call.function.arguments)
            });
          });
        }
        return {
          role: 'assistant',
          content: content
        };
      }
      // User message
      return {
        role: 'user',
        content: msg.content || ''
      };
    });

    const request: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.model,
      messages: anthropicMessages,
      max_tokens: 4096
    };
    if (systemMessage?.content) {
      request.system = systemMessage.content;
    }
    if (anthropicTools && anthropicTools.length > 0) {
      request.tools = anthropicTools;
    }
    const response = await this.client.messages.create(request);

    // Parse response
    let content: string | null = null;
    const toolCalls: ToolCall[] = [];

    for (const block of response.content) {
      if (block.type === 'text') {
        content = (content || '') + block.text;
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input)
          }
        });
      }
    }

    const result: AIResponse = {
      content,
      usage: {
        prompt_tokens: response.usage.input_tokens,
        completion_tokens: response.usage.output_tokens,
        total_tokens: response.usage.input_tokens + response.usage.output_tokens
      }
    };
    if (toolCalls.length > 0) {
      result.tool_calls = toolCalls;
    }
    return result;
  }
}
