import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { trackProviderTokenUsage } from '../src/utils/model-providers/provider-interface';
import { globalRateLimiter } from '../src/utils/rate-limiter';

// Mock the logging functions
vi.mock("../src/utils/agent/log.js", () => ({
  __esModule: true,
  log: vi.fn(),
  isLoggingEnabled: () => true, // Set to true to cover the logging branch
}));

// Create a spy on the rate limiter's trackSuccessfulRequest method
vi.mock("../src/utils/rate-limiter.js", async () => {
  const actual = await vi.importActual("../src/utils/rate-limiter.js");
  return {
    ...actual,
    globalRateLimiter: {
      ...actual.globalRateLimiter,
      trackSuccessfulRequest: vi.fn(actual.globalRateLimiter.trackSuccessfulRequest),
    },
  };
});

describe('Token Usage Tracking', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('should track OpenAI token usage correctly', () => {
    // Track usage for OpenAI
    trackProviderTokenUsage('openai', 100, 200);
    
    // Verify the rate limiter was called with correct params
    expect(globalRateLimiter.trackSuccessfulRequest).toHaveBeenCalledWith('openai', 300);
    expect(globalRateLimiter.trackSuccessfulRequest).toHaveBeenCalledTimes(1);
  });

  test('should track Anthropic token usage correctly', () => {
    // Track usage for Anthropic
    trackProviderTokenUsage('anthropic', 150, 250);
    
    // Verify the rate limiter was called with correct params
    expect(globalRateLimiter.trackSuccessfulRequest).toHaveBeenCalledWith('anthropic', 400);
    expect(globalRateLimiter.trackSuccessfulRequest).toHaveBeenCalledTimes(1);
  });

  test('should handle zero token usage', () => {
    // Track zero token usage
    trackProviderTokenUsage('openai', 0, 0);
    
    // Verify the rate limiter was called with zero tokens
    expect(globalRateLimiter.trackSuccessfulRequest).toHaveBeenCalledWith('openai', 0);
  });

  test('should handle errors gracefully', () => {
    // Mock an error when tracking
    vi.mocked(globalRateLimiter.trackSuccessfulRequest).mockImplementationOnce(() => {
      throw new Error('Test error');
    });
    
    // Should not throw even though there's an error inside
    expect(() => {
      trackProviderTokenUsage('openai', 100, 200);
    }).not.toThrow();
  });

  test('should work with any provider name', () => {
    // Track for a custom provider
    trackProviderTokenUsage('custom_provider', 50, 50);
    
    // Verify the rate limiter was called with the custom provider
    expect(globalRateLimiter.trackSuccessfulRequest).toHaveBeenCalledWith('custom_provider', 100);
  });
});