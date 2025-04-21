/**
 * Tests for the provider token tracking functionality 
 * 
 * These tests verify that token tracking works correctly with different providers
 * and is properly integrated in the provider interface.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { trackProviderTokenUsage } from '../src/utils/model-providers/provider-interface';
import type { ModelProvider } from '../src/utils/model-providers/provider-interface';
import { globalRateLimiter } from '../src/utils/rate-limiter';

// Mock the rate limiter to capture calls to trackSuccessfulRequest
vi.mock('../src/utils/rate-limiter', () => ({
  __esModule: true,
  globalRateLimiter: {
    trackSuccessfulRequest: vi.fn(),
  },
  // Include necessary exports for other imports
  TimeWindow: {
    MINUTE: 60 * 1000,
    HOUR: 60 * 60 * 1000,
    DAY: 24 * 60 * 60 * 1000,
  },
}));

// Mock the logging functions
vi.mock("../src/utils/agent/log.js", () => ({
  __esModule: true,
  log: vi.fn(),
  isLoggingEnabled: () => true, // Enable logging for coverage
}));

describe('Provider Token Tracking', () => {
  // Reset mocks before each test
  beforeEach(() => {
    vi.clearAllMocks();
  });
  
  test('should track OpenAI token usage accurately', () => {
    // Test with OpenAI provider
    trackProviderTokenUsage('openai', 100, 150);
    
    // Verify rate limiter was called with correct parameters
    expect(globalRateLimiter.trackSuccessfulRequest).toHaveBeenCalledTimes(1);
    expect(globalRateLimiter.trackSuccessfulRequest).toHaveBeenCalledWith('openai', 250);
  });
  
  test('should track Anthropic token usage accurately', () => {
    // Test with Anthropic provider
    trackProviderTokenUsage('anthropic', 200, 300);
    
    // Verify rate limiter was called with correct parameters
    expect(globalRateLimiter.trackSuccessfulRequest).toHaveBeenCalledTimes(1);
    expect(globalRateLimiter.trackSuccessfulRequest).toHaveBeenCalledWith('anthropic', 500);
  });
  
  test('should handle zero token counts', () => {
    // Test with zero tokens
    trackProviderTokenUsage('openai', 0, 0);
    
    // Verify rate limiter was called with zero tokens
    expect(globalRateLimiter.trackSuccessfulRequest).toHaveBeenCalledWith('openai', 0);
  });
  
  test('should gracefully handle errors in rate limiter', () => {
    // Mock the rate limiter to throw an error
    vi.mocked(globalRateLimiter.trackSuccessfulRequest).mockImplementationOnce(() => {
      throw new Error('Rate limiter error');
    });
    
    // Should not throw even though there's an error in the rate limiter
    expect(() => {
      trackProviderTokenUsage('openai', 100, 100);
    }).not.toThrow();
  });
  
  // Test integration with AnthropicProvider
  test('should process token usage from Anthropic API response correctly', () => {
    // Create a fake Anthropic response with usage data
    const fakeAnthropicResponse = {
      message: {
        id: 'msg_123',
        usage: {
          input_tokens: 150,
          output_tokens: 250
        }
      }
    };
    
    // Call the function directly as we would from the provider
    trackProviderTokenUsage(
      'anthropic', 
      fakeAnthropicResponse.message.usage.input_tokens,
      fakeAnthropicResponse.message.usage.output_tokens
    );
    
    // Verify the rate limiter was called with the correct total
    expect(globalRateLimiter.trackSuccessfulRequest).toHaveBeenCalledWith(
      'anthropic', 
      fakeAnthropicResponse.message.usage.input_tokens + 
      fakeAnthropicResponse.message.usage.output_tokens
    );
  });
  
  // Test integration with OpenAIProvider
  test('should process token usage from OpenAI API response correctly', () => {
    // Create a fake OpenAI response with usage data
    const fakeOpenAIResponse = {
      id: 'resp_123',
      usage: {
        prompt_tokens: 120,
        completion_tokens: 180,
        total_tokens: 300
      }
    };
    
    // Call the function directly as we would from the provider
    trackProviderTokenUsage(
      'openai', 
      fakeOpenAIResponse.usage.prompt_tokens,
      fakeOpenAIResponse.usage.completion_tokens
    );
    
    // Verify the rate limiter was called with the correct total
    expect(globalRateLimiter.trackSuccessfulRequest).toHaveBeenCalledWith(
      'openai', 
      fakeOpenAIResponse.usage.prompt_tokens + 
      fakeOpenAIResponse.usage.completion_tokens
    );
    
    // Verify it was called with the same value as the total_tokens field
    expect(fakeOpenAIResponse.usage.prompt_tokens + 
           fakeOpenAIResponse.usage.completion_tokens).toBe(
      fakeOpenAIResponse.usage.total_tokens
    );
  });
});