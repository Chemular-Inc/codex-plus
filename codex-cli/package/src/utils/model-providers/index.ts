/**
 * Model providers entry point
 * This file imports all provider implementations to register them with the registry
 */

// Export the core types and interfaces
export {
  ModelProvider,
  ModelProviderInterface,
  ProviderOptions,
  providerRegistry,
  detectProviderFromModel,
  createProvider,
  createProviderFromConfig
} from './provider-interface.js';

// Import provider implementations to register them
// The order doesn't matter as they register themselves via the registry
import './openai.js';
import './anthropic.js';

// Export individual provider implementations for direct usage if needed
export { createOpenAIProvider } from './openai.js';
export { createAnthropicProvider, createAnthropicClient } from './anthropic.js';