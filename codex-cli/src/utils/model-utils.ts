import { OPENAI_API_KEY } from "./config";
import OpenAI from "openai";
import { detectProviderFromModel, ModelProvider } from "./model-providers/index.js";

const MODEL_LIST_TIMEOUT_MS = 2_000; // 2 seconds
export const RECOMMENDED_MODELS: Array<string> = ["o4-mini", "o3"];
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
  "claude-3.5-sonnet-v2"
];

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
  "claude-3-5-haiku-20241022": "claude-3-5-haiku-20241022" // New model
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
  // Handle empty model or recommended models
  if (
    typeof model !== "string" ||
    model.trim() === "" ||
    RECOMMENDED_MODELS.includes(model)
  ) {
    return true;
  }
  
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
