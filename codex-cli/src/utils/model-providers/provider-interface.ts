/**
 * Provider interface for using multiple LLM APIs in Codex CLI
 * This module provides a unified interface for multiple models
 */

import type { AppConfig } from "../config.js";
import type { ResponseInputItem, ResponseItem } from "openai/resources/responses/responses.mjs";

import { log, isLoggingEnabled } from "../agent/log.js";
import { globalRateLimiter, executeWithRateLimiting, TimeWindow } from "../rate-limiter.js";

// Shared types across providers
export enum ModelProvider {
  OPENAI = "openai",
  ANTHROPIC = "anthropic",
  // Add new providers here
}

export type ProviderOptions = {
  apiKey: string;
  baseUrl?: string;
  model: string;
  // Additional provider-specific options
  [key: string]: string | undefined;
};

export interface ModelProviderInterface {
  provider: ModelProvider;
  sendMessage(
    input: Array<ResponseInputItem>,
    options: {
      reasoning?: unknown;
      system?: string;
      temperature?: number;
      previousResponseId?: string;
      conversationId?: string;
    }
  ): Promise<{
    items: Array<ResponseItem>;
    response_id: string;
  }>;
}

// Registry to manage provider implementations
export class ProviderRegistry {
  private static instance: ProviderRegistry;
  private providers: Map<ModelProvider, (options: ProviderOptions) => Promise<ModelProviderInterface>>;
  private modelPatterns: Map<ModelProvider, RegExp[]>;

  private constructor() {
    this.providers = new Map();
    this.modelPatterns = new Map();
  }

  public static getInstance(): ProviderRegistry {
    if (!ProviderRegistry.instance) {
      ProviderRegistry.instance = new ProviderRegistry();
    }
    return ProviderRegistry.instance;
  }

  // Register a provider implementation with model name patterns
  public registerProvider(
    provider: ModelProvider,
    factory: (options: ProviderOptions) => Promise<ModelProviderInterface>,
    modelPatterns: RegExp[]
  ): void {
    this.providers.set(provider, factory);
    this.modelPatterns.set(provider, modelPatterns);
  }

  // Detect provider from model name
  public detectProviderFromModel(model: string): ModelProvider {
    const lowerModel = model.toLowerCase();
    
    for (const [provider, patterns] of this.modelPatterns.entries()) {
      for (const pattern of patterns) {
        if (pattern.test(lowerModel)) {
          return provider;
        }
      }
    }
    
    // Default to OpenAI if no match found
    if (isLoggingEnabled()) {
      log(`No provider match found for model ${model}, defaulting to OpenAI`);
    }
    return ModelProvider.OPENAI;
  }

  // Create provider instance based on model name
  public async createProvider(options: ProviderOptions): Promise<ModelProviderInterface> {
    const provider = this.detectProviderFromModel(options.model);
    const factory = this.providers.get(provider);
    
    if (!factory) {
      throw new Error(`No provider implementation found for ${provider}`);
    }
    
    return factory(options);
  }

  // Create provider from app config
  public async createProviderFromConfig(config: AppConfig): Promise<ModelProviderInterface> {
    const model = config.model;
    const provider = this.detectProviderFromModel(model);
    
    // Determine the API key based on provider
    let apiKey: string;
    let baseUrl: string | undefined;
    
    if (provider === ModelProvider.ANTHROPIC) {
      apiKey = config.anthropicApiKey || process.env.ANTHROPIC_API_KEY || "";
      baseUrl = config.anthropicBaseUrl || process.env.ANTHROPIC_BASE_URL;
      
      if (!apiKey) {
        throw new Error(
          "Anthropic API key is required for Claude models. Set ANTHROPIC_API_KEY environment variable."
        );
      }
    } else if (provider === ModelProvider.OPENAI) {
      apiKey = config.apiKey || process.env.OPENAI_API_KEY || "";
      baseUrl = config.openaiBaseUrl || process.env.OPENAI_BASE_URL;
      
      if (!apiKey) {
        throw new Error(
          "OpenAI API key is required. Set OPENAI_API_KEY environment variable."
        );
      }
    } else {
      throw new Error(`Provider ${provider} is not configured to load API keys`);
    }
    
    return this.createProvider({
      apiKey,
      baseUrl,
      model,
    });
  }
}

// Export a singleton instance of the registry
export const providerRegistry = ProviderRegistry.getInstance();

/**
 * Track token usage from any provider in the rate limiter
 * This function should be used by all providers when token usage data is available
 * 
 * @param provider The provider name (e.g., "openai", "anthropic")
 * @param inputTokens Input tokens used
 * @param outputTokens Output tokens used
 */
export function trackProviderTokenUsage(
  provider: string,
  inputTokens: number,
  outputTokens: number
): void {
  try {
    const totalTokens = inputTokens + outputTokens;
    
    // Log token usage if debug mode enabled
    if (isLoggingEnabled()) {
      log(`Provider token usage (${provider}): input=${inputTokens}, output=${outputTokens}, total=${totalTokens}`);
    }
    
    // Update the rate limiter with this usage
    globalRateLimiter.trackSuccessfulRequest(provider, totalTokens);
  } catch (e) {
    // Never let token tracking issues crash the main flow
    if (isLoggingEnabled()) {
      log(`Error tracking token usage: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

// Legacy functions that use the registry for backward compatibility
export function detectProviderFromModel(model: string): ModelProvider {
  return providerRegistry.detectProviderFromModel(model);
}

export async function createProvider(
  provider: ModelProvider,
  options: ProviderOptions
): Promise<ModelProviderInterface> {
  return providerRegistry.createProvider(options);
}

export async function createProviderFromConfig(config: AppConfig): Promise<ModelProviderInterface> {
  return providerRegistry.createProviderFromConfig(config);
}

// Initialize default providers
// This will be extended when we import provider modules
// Note: The actual provider registration will happen in their respective files