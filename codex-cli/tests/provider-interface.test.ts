import { describe, it, expect, vi } from "vitest";

// Mock imports
vi.mock("../src/utils/agent/log.js", () => ({
  __esModule: true,
  log: vi.fn(),
  isLoggingEnabled: () => false,
}));

vi.mock("../src/utils/rate-limiter.js", () => ({
  __esModule: true,
  executeWithRateLimiting: async (provider, fn) => fn(),
  globalRateLimiter: { trackSuccessfulRequest: vi.fn() },
}));

// Import after mocks
import { 
  ModelProvider, 
  providerRegistry, 
  detectProviderFromModel,
  createProviderFromConfig 
} from "../src/utils/model-providers/index.js";

describe("Provider Interface", () => {
  it("should detect provider from model name", () => {
    // Test OpenAI models
    expect(detectProviderFromModel("gpt-4")).toBe(ModelProvider.OPENAI);
    expect(detectProviderFromModel("gpt-3.5-turbo")).toBe(ModelProvider.OPENAI);
    
    // Test Anthropic models
    expect(detectProviderFromModel("claude-3-5-sonnet")).toBe(ModelProvider.ANTHROPIC);
    expect(detectProviderFromModel("claude-3-opus")).toBe(ModelProvider.ANTHROPIC);
    
    // Test fallback
    expect(detectProviderFromModel("unknown-model")).toBe(ModelProvider.OPENAI);
  });
  
  it("should create provider from config", async () => {
    // Mock implementation for createProvider
    const mockProvider = {
      provider: ModelProvider.OPENAI,
      sendMessage: vi.fn().mockResolvedValue({
        items: [],
        response_id: "test-id"
      })
    };
    
    // Mock the registry's createProvider method
    vi.spyOn(providerRegistry, 'createProvider').mockResolvedValue(mockProvider);
    
    // Test with OpenAI config
    const openaiConfig = {
      model: "gpt-4",
      apiKey: "test-key"
    };
    
    const provider = await createProviderFromConfig(openaiConfig as any);
    expect(provider).toBe(mockProvider);
    
    // Test calling sendMessage
    const response = await provider.sendMessage([], {});
    expect(response).toEqual({
      items: [],
      response_id: "test-id"
    });
    expect(mockProvider.sendMessage).toHaveBeenCalledTimes(1);
  });
});
