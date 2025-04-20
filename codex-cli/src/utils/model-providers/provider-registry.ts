/**
 * Provider registry that manages model providers and handles model mapping
 */

import type { ModelProvider } from "./common-types.js";

import { OpenAIProvider } from "./openai-provider.js";
import { log, isLoggingEnabled } from "../agent/log.js";

// Define model resolution interface
export interface ResolvedModel {
  provider: string;
  modelId: string;
  displayName: string;
}

// Provider registry that maps provider names to their implementations
const providers: Record<string, ModelProvider> = {};

// Model aliases - maps user-friendly names to provider-specific model IDs
const modelAliases: Record<string, ResolvedModel> = {
  // OpenAI models
  "gpt-4o": { provider: "openai", modelId: "gpt-4o", displayName: "GPT-4o" },
  "gpt-4-turbo": { provider: "openai", modelId: "gpt-4-turbo-2024-04-09", displayName: "GPT-4 Turbo" },
  "gpt-4": { provider: "openai", modelId: "gpt-4", displayName: "GPT-4" },
  "gpt-3.5-turbo": { provider: "openai", modelId: "gpt-3.5-turbo", displayName: "GPT-3.5 Turbo" },
  
  // o1/o2 shortcuts
  "o1": { provider: "openai", modelId: "o1", displayName: "o1" },
  "o1-mini": { provider: "openai", modelId: "o1-mini", displayName: "o1-mini" },
  "o1-preview": { provider: "openai", modelId: "o1-preview", displayName: "o1-preview" },
  "o2": { provider: "openai", modelId: "o2", displayName: "o2" },
  "o3": { provider: "openai", modelId: "o3", displayName: "o3" },
  "o4": { provider: "openai", modelId: "o4", displayName: "o4" },
  "o4-mini": { provider: "openai", modelId: "o4-mini", displayName: "o4-mini" },
};

/**
 * Initialize a provider with the given API key and session ID
 */
export function initializeProvider(providerName: string, apiKey: string, sessionId: string): ModelProvider {
  if (isLoggingEnabled()) {
    log(`Initializing provider: ${providerName}`);
  }
  
  switch (providerName) {
    case "openai":
      providers[providerName] = new OpenAIProvider(apiKey, sessionId);
      break;
    default:
      throw new Error(`Unsupported provider: ${providerName}`);
  }
  
  return providers[providerName];
}

/**
 * Get a provider by name, initializing it if necessary
 */
export function getProvider(providerName: string, apiKey: string, sessionId: string): ModelProvider {
  if (!providers[providerName]) {
    return initializeProvider(providerName, apiKey, sessionId);
  }
  return providers[providerName];
}

/**
 * Resolve a model name to provider and model ID
 */
export function resolveModel(modelName: string): ResolvedModel | null {
  // If it's a direct match in our aliases, return it
  if (modelAliases[modelName]) {
    return modelAliases[modelName];
  }
  
  // If the model name matches a specific pattern we can infer the provider
  if (modelName.startsWith("gpt-")) {
    return {
      provider: "openai",
      modelId: modelName,
      displayName: modelName
    };
  }
  
  // If we couldn't resolve the model, return null
  if (isLoggingEnabled()) {
    log(`Could not resolve model: ${modelName}`);
  }
  return null;
}

/**
 * Get all available model aliases
 */
export function getAvailableModels(): Array<ResolvedModel> {
  return Object.values(modelAliases);
}

/**
 * Get a provider for a given model
 */
export function getProviderForModel(
  modelName: string, 
  apiKey: string = "", 
  sessionId: string = ""
): ModelProvider | null {
  const resolvedModel = resolveModel(modelName);
  
  if (!resolvedModel) {
    if (isLoggingEnabled()) {
      log(`No provider found for model: ${modelName}`);
    }
    return null;
  }
  
  return getProvider(resolvedModel.provider, apiKey, sessionId);
}