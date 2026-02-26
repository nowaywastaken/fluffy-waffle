/**
 * AI Provider Adapter Interface
 * Standardizes interaction with different AI models (OpenAI, Anthropic, etc.)
 */

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

export interface AIResponse {
  content: string | null;
  tool_calls?: ToolCall[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface AIProviderAdapter {
  name: string;
  
  /**
   * Convert internal tool definitions to provider-specific format
   */
  formatTools(tools: ToolDefinition[]): unknown;

  /**
   * Send a chat completion request
   */
  chat(messages: Message[], tools?: ToolDefinition[]): Promise<AIResponse>;
}
