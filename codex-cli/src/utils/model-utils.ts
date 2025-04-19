import { OPENAI_API_KEY } from "./config";
import OpenAI from "openai";
import { detectProviderFromModel, ModelProvider } from "./model-providers/index.js";

const MODEL_LIST_TIMEOUT_MS = 2_000; // 2 seconds
export const RECOMMENDED_MODELS: Array<string> = ["o4-mini", "o3"];
export const SUPPORTED_CLAUDE_MODELS: Array<string> = [
  "claude-3-opus-20240229",
  "claude-3-sonnet-20240229", 
  "claude-3-haiku-20240307",
  "claude-3-7-sonnet-20250219",
  "claude-3.5-sonnet-20240620",
  "claude-3",
  "claude-3.5",
  "claude-3.7"
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
 * Verify that the provided model identifier is present in the set returned by
 * {@link getAvailableModels} or is a supported Claude model.
 * The list of models is fetched from the OpenAI `/models` endpoint the first time 
 * it is required and then cached in‑process.
 */
export async function isModelSupportedForResponses(
  model: string | undefined | null,
): Promise<boolean> {
  if (
    typeof model !== "string" ||
    model.trim() === "" ||
    RECOMMENDED_MODELS.includes(model)
  ) {
    return true;
  }
  
  // Check if this is a Claude model
  const provider = detectProviderFromModel(model);
  if (provider === ModelProvider.ANTHROPIC) {
    // Either it's in our supported list or we'll trust it if it has "claude" in the name
    return SUPPORTED_CLAUDE_MODELS.includes(model) || 
           model.toLowerCase().includes("claude");
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

    return models.includes(model.trim());
  } catch {
    // Network or library failure → don't block start‑up.
    return true;
  }
}
