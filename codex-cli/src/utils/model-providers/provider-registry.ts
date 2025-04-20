/**
 * Provider registry that manages model providers and handles model mapping
 */

import type { ModelProvider } from "./common-types.js";

import { OpenAIProvider } from "./openai-provider.js";
import { AnthropicProvider } from "./anthropic-provider.js";
import { log, isLoggingEnabled } from "../agent/log.js";
import { resolveModel, ResolvedModel, getAvailableModelAliases } from "../model-utils.js";

// Provider registry that maps provider names to their implementations
const providers: Record<string, ModelProvider> = {};

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
    case "anthropic":
      providers[providerName] = new AnthropicProvider(apiKey, sessionId);
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
 * Get all available model aliases
 */
export function getAvailableModels(): Array<ResolvedModel> {
  return getAvailableModelAliases().map(displayName => {
    // This is a simplification, only used for UI display
    return {
      provider: "unknown",
      modelId: displayName,
      displayName: displayName
    };
  });
}

/**
 * Get a provider for a given model
 */
export function getProviderForModel(
  modelName: string, 
  apiKey: string = "", 
  sessionId: string = ""
): ModelProvider | null {
  const resolved = resolveModel(modelName);
  
  if (!resolved) {
    if (isLoggingEnabled()) {
      log(`No provider found for model: ${modelName}`);
    }
    return null;
  }
  
  return getProvider(resolved.provider, apiKey, sessionId);
}