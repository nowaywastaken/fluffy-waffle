import OpenAI from 'openai';
import { AIProviderAdapter, ToolDefinition, Message, AIResponse, ToolCall } from '../adapter.js';

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
        return {
          role: 'assistant',
          content: msg.content,
          tool_calls: msg.tool_calls as OpenAI.Chat.Completions.ChatCompletionMessageToolCall[]
        };
      }
      return {
        role: msg.role as 'user' | 'system',
        content: msg.content || ''
      };
    });

    const completion = await this.client.chat.completions.create({
      model: this.model,
      messages: openaiMessages,
      tools: openaiTools,
      tool_choice: openaiTools ? 'auto' : undefined
    });

    const choice = completion.choices[0];
    const message = choice.message;

    return {
      content: message.content,
      tool_calls: message.tool_calls as ToolCall[],
      usage: completion.usage ? {
        prompt_tokens: completion.usage.prompt_tokens,
        completion_tokens: completion.usage.completion_tokens,
        total_tokens: completion.usage.total_tokens
      } : undefined
    };
  }
}
