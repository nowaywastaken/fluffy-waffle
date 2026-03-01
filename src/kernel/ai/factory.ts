import type { AIProviderAdapter } from './adapter.js';
import { OpenAIAdapter } from './adapters/openai.js';
import { AnthropicAdapter } from './adapters/anthropic.js';

export interface ProviderConfig {
  provider: 'openai' | 'anthropic';
  apiKey: string;
  model?: string;
}

export class AIProviderFactory {
  static create(config: ProviderConfig): AIProviderAdapter {
    switch (config.provider) {
      case 'openai':
        return new OpenAIAdapter(config.apiKey, config.model);
      case 'anthropic':
        return new AnthropicAdapter(config.apiKey, config.model);
      default:
        throw new Error(`Unsupported AI provider: ${(config as any).provider}`);
    }
  }

  static createFromEnv(): AIProviderAdapter {
    if (process.env.OPENAI_API_KEY) {
      return new OpenAIAdapter(process.env.OPENAI_API_KEY, process.env.OPENAI_MODEL);
    }
    if (process.env.ANTHROPIC_API_KEY) {
      return new AnthropicAdapter(process.env.ANTHROPIC_API_KEY, process.env.ANTHROPIC_MODEL);
    }
    throw new Error('No AI provider API key found in environment variables (OPENAI_API_KEY or ANTHROPIC_API_KEY)');
  }
}
