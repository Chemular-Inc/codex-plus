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
  "claude-3-7-sonnet-20250219",
  "claude-3-5-sonnet-20240620",
  "claude-3-5-sonnet-20241022",
  "claude-3-5-haiku-20241022",

  // Abbreviated model names with hyphens (preferred format for API)
  "claude-3-opus",
  "claude-3-sonnet",
  "claude-3-haiku",
  "claude-3-7-sonnet",
  "claude-3-5-sonnet",
  "claude-3-5-haiku",

  // Dot notation variants (for user convenience)
  "claude-3",
  "claude-3.5",
  "claude-3.5-sonnet",
  "claude-3.5-haiku",
  "claude-3.7",

  // Named variants
  "claude-3.5-sonnet-v2",
];

// Interface for resolved model information
export interface ResolvedModel {
  provider: string;
  modelId: string;
  displayName: string;
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
  return Object.values(MODEL_ALIASES).map(model => model.displayName);
}

/**
 * Format a model name for display
 */
export function formatModelName(modelName: string): string {
  const resolved = resolveModel(modelName);
  return resolved ? resolved.displayName : modelName;
}

/**
 * Background model loader / cache.
 *
 * We start fetching the list of available models from OpenAI once the CLI
 * enters interactive mode.  The request is made exactly once during the
 * lifetime of the process and the results are cached for subsequent calls.
 */

let modelsPromise: Promise<Array<string>> | null = null;

async function fetchModels(): Promise<Array<string>> {
  // If the user has not configured an API key we cannot hit the network.
  if (!OPENAI_API_KEY) {
    return RECOMMENDED_MODELS;
  }

  try {
    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
    const list = await openai.models.list();

    const models: Array<string> = [];
    for await (const model of list as AsyncIterable<{ id?: string }>) {
      if (model && typeof model.id === "string") {
        models.push(model.id);
      }
    }

    return models.sort();
  } catch {
    return [];
  }
}

export function preloadModels(): void {
  if (!modelsPromise) {
    // Fire‑and‑forget – callers that truly need the list should `await`
    // `getAvailableModels()` instead.
    void getAvailableModels();
  }
}

export async function getAvailableModels(): Promise<Array<string>> {
  if (!modelsPromise) {
    modelsPromise = fetchModels();
  }
  return modelsPromise;
}

/**
 * Maps user-friendly model names to their full API-compatible identifiers
 */
export const CLAUDE_MODEL_MAP: Record<string, string> = {
  // Simplified names -> Full API model identifiers
  "claude-3": "claude-3-opus-20240229",
  "claude-3.5": "claude-3-5-sonnet-20241022", // Updated to latest version
  "claude-3.7": "claude-3-7-sonnet-20250219",
  "claude-3-5": "claude-3-5-sonnet-20241022", // Updated to latest version
  "claude-3-7": "claude-3-7-sonnet-20250219",

  // Architecture versions without dates -> Dated versions
  "claude-3-opus": "claude-3-opus-20240229",
  "claude-3-sonnet": "claude-3-sonnet-20240229",
  "claude-3-haiku": "claude-3-haiku-20240307",
  "claude-3-5-sonnet": "claude-3-5-sonnet-20241022", // Updated to latest version
  "claude-3-5-haiku": "claude-3-5-haiku-20241022", // New model
  "claude-3-7-sonnet": "claude-3-7-sonnet-20250219",

  // Named variants
  "claude-3.5-sonnet": "claude-3-5-sonnet-20241022", // New format with dot notation
  "claude-3.5-haiku": "claude-3-5-haiku-20241022", // New format with dot notation
  "claude-3.5-sonnet-v2": "claude-3-5-sonnet-20241022", // V2 alias

  // Already complete models should map to themselves (for lookup safety)
  "claude-3-opus-20240229": "claude-3-opus-20240229",
  "claude-3-sonnet-20240229": "claude-3-sonnet-20240229",
  "claude-3-haiku-20240307": "claude-3-haiku-20240307",
  "claude-3-7-sonnet-20250219": "claude-3-7-sonnet-20250219",
  "claude-3-5-sonnet-20240620": "claude-3-5-sonnet-20240620", // Keep older version for compat
  "claude-3-5-sonnet-20241022": "claude-3-5-sonnet-20241022", // New version
  "claude-3-5-haiku-20241022": "claude-3-5-haiku-20241022", // New model
};

/**
 * Map user-friendly model names to API-compatible model names
 */
export function normalizeModelName(model: string): string {
  if (!model) return model;

  const lowerModel = model.toLowerCase();

  // Handle Claude models
  if (lowerModel.includes("claude")) {
    // First replace dots with hyphens in version numbers
    let normalizedName = lowerModel.replace(/(\d+)\.(\d+)/g, "$1-$2");

    // Look up the exact API model in our mapping
    const exactModel = CLAUDE_MODEL_MAP[normalizedName];
    if (exactModel) {
      return exactModel;
    }

    // Special handling for "v2" and other variant names
    if (normalizedName.includes("-v")) {
      // Extract the base model name without the variant suffix
      const baseModelName = normalizedName.replace(/-v\d+$/, "");
      const baseMapping = CLAUDE_MODEL_MAP[baseModelName];
      if (baseMapping) {
        return baseMapping;
      }
    }

    // If not in our map but has claude in the name,
    // return the normalized name (dots -> hyphens)
    return normalizedName;
  }

  // For all other models (OpenAI, etc.), return as is
  return model;
}

/**
 * Verify that the provided model identifier is present in the set returned by
 * {@link getAvailableModels} or is a supported Claude model.
 * The list of models is fetched from the OpenAI `/models` endpoint the first time
 * it is required and then cached in‑process.
 */
export async function isModelSupportedForResponses(
  model: string | undefined | null,
): Promise<boolean> {
<<<<<<< HEAD
  if (isLoggingEnabled()) {
    log(`Checking if model is supported: ${model}`);
  }
  
=======
  // Handle empty model or recommended models
>>>>>>> stable-ui
  if (
    typeof model !== "string" ||
    model.trim() === "" ||
    RECOMMENDED_MODELS.includes(model)
  ) {
    return true;
  }

<<<<<<< HEAD
  // If we can resolve the model to any provider, consider it supported
  const resolvedModel = resolveModel(model);
  if (resolvedModel) {
    if (isLoggingEnabled()) {
      log(`Model ${model} resolved to provider ${resolvedModel.provider}, model ID ${resolvedModel.modelId}`);
    }
    return true;
  }

  // Fall back to checking OpenAI models list for backward compatibility
=======
  // Normalize the model name first to ensure we're checking the correct format
  const normalizedModel = normalizeModelName(model);

  // Check if this is a Claude model
  const provider = detectProviderFromModel(normalizedModel);
  if (provider === ModelProvider.ANTHROPIC) {
    // If it's in our Claude model map, it's definitely supported
    if (Object.keys(CLAUDE_MODEL_MAP).includes(normalizedModel.toLowerCase())) {
      return true;
    }

    // If the model has "claude" in it but is not in our map,
    // we'll still accept it (for flexibility with future models)
    if (normalizedModel.toLowerCase().includes("claude")) {
      return true;
    }
  }

  // For OpenAI models, check against the API
>>>>>>> stable-ui
  try {
    const models = await Promise.race<Array<string>>([
      getAvailableModels(),
      new Promise<Array<string>>((resolve) =>
        setTimeout(() => resolve([]), MODEL_LIST_TIMEOUT_MS),
      ),
    ]);

    // If the timeout fired we get an empty list → treat as supported to avoid
    // false negatives.
    if (models.length === 0) {
      return true;
    }

    return models.includes(normalizedModel.trim());
  } catch {
    // Network or library failure → don't block start‑up.
    return true;
  }
}
