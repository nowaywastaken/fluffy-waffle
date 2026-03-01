import OpenAI from 'openai';
import type { AIProviderAdapter, ToolDefinition, Message, AIResponse, ToolCall } from '../adapter.js';

export class OpenAIAdapter implements AIProviderAdapter {
  name = 'openai';
  private client: OpenAI;

  constructor(apiKey: string, private model: string = 'gpt-4o') {
    this.client = new OpenAI({ apiKey });
  }

  formatTools(tools: ToolDefinition[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
    return tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters as Record<string, unknown>
      }
    }));
  }

  async chat(messages: Message[], tools?: ToolDefinition[]): Promise<AIResponse> {
    const openaiTools = tools ? this.formatTools(tools) : undefined;
    
    // Convert internal Message format to OpenAI format
    const openaiMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = messages.map(msg => {
      if (msg.role === 'tool') {
        return {
          role: 'tool',
          content: msg.content || '',
          tool_call_id: msg.tool_call_id!
        };
      }
      if (msg.role === 'assistant') {
        const assistantMessage: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam = {
          role: 'assistant',
          content: msg.content
        };
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          assistantMessage.tool_calls = msg.tool_calls as OpenAI.Chat.Completions.ChatCompletionMessageToolCall[];
        }
        return assistantMessage;
      }
      return {
        role: msg.role as 'user' | 'system',
        content: msg.content || ''
      };
    });

    const request: OpenAI.Chat.Completions.ChatCompletionCreateParams = {
      model: this.model,
      messages: openaiMessages
    };
    if (openaiTools && openaiTools.length > 0) {
      request.tools = openaiTools;
      request.tool_choice = 'auto';
    }

    const completion = await this.client.chat.completions.create(request);

    const choice = completion.choices[0];
    if (!choice) {
      throw new Error('OpenAI response contained no choices');
    }
    const message = choice.message;

    const response: AIResponse = {
      content: message.content
    };
    if (message.tool_calls && message.tool_calls.length > 0) {
      response.tool_calls = message.tool_calls as ToolCall[];
    }
    if (completion.usage) {
      response.usage = {
        prompt_tokens: completion.usage.prompt_tokens,
        completion_tokens: completion.usage.completion_tokens,
        total_tokens: completion.usage.total_tokens
      };
    }

    return response;
  }
}
