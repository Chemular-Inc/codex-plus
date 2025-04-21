import { OPENAI_API_KEY } from "./config.js";
import OpenAI from "openai";
import { log, isLoggingEnabled } from "./agent/log.js";
import {
  detectProviderFromModel,
  ModelProvider,
} from "./model-providers/index.js";

const MODEL_LIST_TIMEOUT_MS = 2_000; // 2 seconds
export const RECOMMENDED_MODELS: Array<string> = [
  "o3-mini",
  "claude-3-7-sonnet-20250219",
];
export const SUPPORTED_CLAUDE_MODELS: Array<string> = [
  // Full model identifiers with version numbers
  "claude-3-opus-20240229",
  "claude-3-sonnet-20240229",
  "claude-3-haiku-20240307",
  "claude-3-5-sonnet-20240620",
  "claude-3-5-haiku-20240307",
  "claude-3-7-sonnet-20250219", // Latest claude model
  
  // Friendly names without version numbers
  "claude-3-opus",
  "claude-3-sonnet",
  "claude-3-haiku",
  "claude-3-5-sonnet",
  "claude-3-5-haiku",
  "claude-3-7-sonnet",
  
  // Dot notation variants
  "claude-3.5-sonnet",
  "claude-3.5-haiku",
  "claude-3.7-sonnet",
];

// Type definition for resolved model information
export interface ResolvedModel {
  provider: string;    // Provider name (openai, anthropic)
  modelId: string;     // Actual model ID to use with the API
  displayName: string; // Human-readable display name
}

// Model aliases mapping friendly names to provider-specific model IDs
const MODEL_ALIASES: Record<string, ResolvedModel> = {
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
  
  // Anthropic models - full model IDs
  "claude-3-5-sonnet": { provider: "anthropic", modelId: "claude-3-5-sonnet-20240620", displayName: "Claude 3.5 Sonnet" },
  "claude-3-5-haiku": { provider: "anthropic", modelId: "claude-3-5-haiku-20240307", displayName: "Claude 3.5 Haiku" },
  "claude-3-opus": { provider: "anthropic", modelId: "claude-3-opus-20240229", displayName: "Claude 3 Opus" },
  "claude-3-sonnet": { provider: "anthropic", modelId: "claude-3-sonnet-20240229", displayName: "Claude 3 Sonnet" },
  "claude-3-haiku": { provider: "anthropic", modelId: "claude-3-haiku-20240307", displayName: "Claude 3 Haiku" },
  
  // Anthropic models - dot notation (user-friendly)
  "claude-3.5-sonnet": { provider: "anthropic", modelId: "claude-3-5-sonnet-20240620", displayName: "Claude 3.5 Sonnet" },
  "claude-3.5-haiku": { provider: "anthropic", modelId: "claude-3-5-haiku-20240307", displayName: "Claude 3.5 Haiku" },
  "claude-3.5": { provider: "anthropic", modelId: "claude-3-5-sonnet-20240620", displayName: "Claude 3.5 Sonnet" },
  "claude-3.7-sonnet": { provider: "anthropic", modelId: "claude-3-7-sonnet-20250219", displayName: "Claude 3.7 Sonnet" },
  "claude-3.7": { provider: "anthropic", modelId: "claude-3-7-sonnet-20250219", displayName: "Claude 3.7 Sonnet" },
  
  // Claude shortcuts
  "claude": { provider: "anthropic", modelId: "claude-3-5-sonnet-20240620", displayName: "Claude 3.5 Sonnet" },
};

/**
 * Resolves a model name to provider and model ID
 * Supports various formats:
 * - Direct aliases (like "gpt-4", "claude")
 * - Provider-prefixed models (like "openai/gpt-4", "anthropic/claude-3-sonnet")
 * - Dot notation (like "claude-3.5" instead of "claude-3-5")
 * - Direct model IDs with pattern matching for provider inference
 */
export function resolveModel(modelName: string): ResolvedModel | null {
  // Check for provider prefix format (provider/model)
  const providerPrefixMatch = modelName.match(/^([a-z]+)\/(.+)$/);
  if (providerPrefixMatch && providerPrefixMatch[1] && providerPrefixMatch[2]) {
    const provider = providerPrefixMatch[1];
    const modelId = providerPrefixMatch[2];
    
    // For explicit provider prefixes, we'll return the model directly with the specified provider
    return {
      provider,
      modelId,
      displayName: modelId
    };
  }
  
  // If it's a direct match in our aliases, return it
  if (MODEL_ALIASES[modelName]) {
    return MODEL_ALIASES[modelName];
  }
  
  // Convert dot notation to dash notation for Claude models (e.g., claude-3.5 -> claude-3-5)
  if (modelName.includes(".") && modelName.startsWith("claude")) {
    const dashNotation = modelName.replace(/\./g, "-");
    if (MODEL_ALIASES[dashNotation]) {
      return MODEL_ALIASES[dashNotation];
    }
  }
  
  // Infer provider from model name patterns
  if (modelName.startsWith("gpt-") || modelName.startsWith("o")) {
    return {
      provider: "openai",
      modelId: modelName,
      displayName: modelName
    };
  }
  
  // Handle Claude models (any model starting with "claude-")
  if (modelName.startsWith("claude-")) {
    return {
      provider: "anthropic",
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
 * Get all available model alias display names
 */
export function getAvailableModelAliases(): Array<string> {
  return Object.keys(MODEL_ALIASES);
}

/**
 * Get all available models - for backward compatibility
 */
export function getAvailableModels(): Array<string> {
  return Object.keys(MODEL_ALIASES);
}

/**
 * Normalize model name - especially useful for Claude models which may be
 * specified in dot notation (claude-3.5) vs dash notation (claude-3-5)
 */
export function normalizeModelName(model: string): string {
  // Check if it's a model alias and use the resolved model ID
  const resolvedModel = resolveModel(model);
  if (resolvedModel) {
    return resolvedModel.modelId;
  }
  
  // For Claude models with dot notation, convert to dash notation
  // e.g., claude-3.5-sonnet -> claude-3-5-sonnet
  if (model.includes(".") && model.startsWith("claude")) {
    return model.replace(/\./g, "-");
  }
  
  // Return the original model name if no normalization is needed
  return model;
}

export type ListModelsResult = {
  unavailable: boolean;
  all: Array<string>;
  agentic: Array<string>;
};

/**
 * Checks if the provided model name is supported for use with the Responses API.
 * Caches the model list the first time it is called so it is cached for future
 * invocations.
 *
 * We apply a strict timeout to the model‑listing API call to avoid a slow
 * initial response if the user isn't using an already known model. The timeout
 * is short (2s) because fetching the model list is a non‑critical enhancement
 * rather than a core function – if the API is slow, we'd rather proceed without
 * this information than wait several seconds before the user sees their first
 * prompt.
 *
 * @returns `true` if we can confirm model support, `false` otherwise.
 *
 * Note: The actual model list is only fetched from the OpenAI API once per runtime if
 * it is required and then cached in‑process.
 */
export async function isModelSupportedForResponses(
  model: string | undefined | null,
): Promise<boolean> {
  if (!model) {
    return false;
  }
  
  // Check if it's in our recommended models list for a quick pass
  if (
    [
      "gpt-4",
      "gpt-3.5-turbo",
      "o1",
      "o1-mini",
      "o1-preview",
      "o2",
      "o3",
      "o3-mini",
      "o4",
      "o4-mini",
    ].includes(model) ||
    RECOMMENDED_MODELS.includes(model)
  ) {
    return true;
  }

  // If we can resolve the model to any provider, consider it supported
  const resolvedModel = resolveModel(model);
  if (resolvedModel) {
    if (isLoggingEnabled()) {
      log(`Model ${model} resolved to provider ${resolvedModel.provider}, model ID ${resolvedModel.modelId}`);
    }
    return true;
  }
  
  // For Claude models, check against our supported list
  if (model.startsWith("claude-") || SUPPORTED_CLAUDE_MODELS.includes(model)) {
    return true;
  }
  
  // If this is an OpenAI model, check the OpenAI API
  if (detectProviderFromModel(model) === ModelProvider.OPENAI) {
    try {
      if (!OPENAI_API_KEY) {
        return false;
      }
      
      const models = await preloadModels();
      return models.agentic.includes(model);
    } catch (e) {
      if (isLoggingEnabled()) {
        log(`Error checking model support: ${e instanceof Error ? e.message : String(e)}`);
      }
      return false;
    }
  }
  
  return false;
}

// Global model list cache to avoid refetching the models.
let _modelsList: ListModelsResult | null = null;

/**
 * Preload a list of model names, primarily for display in UI elements.
 * This is safe to call multiple times because it caches the result.
 */
export async function preloadModels(): Promise<ListModelsResult> {
  // Return cached results if available
  if (_modelsList) {
    return _modelsList;
  }

  // Default result - used if API call fails or times out
  let result: ListModelsResult = {
    unavailable: true,
    all: [...RECOMMENDED_MODELS],
    agentic: [...RECOMMENDED_MODELS],
  };

  // Try to fetch from API with timeout
  if (OPENAI_API_KEY) {
    try {
      // Create a client to fetch model list
      const client = new OpenAI({
        apiKey: OPENAI_API_KEY,
      });

      // Use Promise.race to implement timeout
      const modelsPromise = client.models.list();
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => {
          reject(new Error(`OpenAI model list request timed out after ${MODEL_LIST_TIMEOUT_MS}ms`));
        }, MODEL_LIST_TIMEOUT_MS);
      });

      // Wait for either promise to resolve
      const models = await Promise.race([modelsPromise, timeoutPromise]) as Awaited<ReturnType<typeof client.models.list>>;

      // Extract model IDs
      const allIds = models.data.map((m) => m.id);
      
      // All 'gpt-' models plus o1, o2, o3, o4 variants can use the Responses API
      const agentic = allIds.filter(
        (id) => id.startsWith("gpt-") || /^o\d(-.*)?$/.test(id)
      );

      result = {
        unavailable: false,
        all: allIds,
        agentic,
      };
      
      if (isLoggingEnabled()) {
        log(`Loaded ${allIds.length} models from OpenAI API (${agentic.length} support responses)`);
      }
    } catch (e) {
      if (isLoggingEnabled()) {
        log(`Could not load models: ${e instanceof Error ? e.message : String(e)}`);
      }
      
      // Fall back to recommended models on error
      result.unavailable = true;
    }
  }

  // Cache the result for future calls
  _modelsList = result;
  return result;
}