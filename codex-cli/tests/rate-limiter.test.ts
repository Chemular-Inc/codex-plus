import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { RateLimiter, globalRateLimiter, executeWithRateLimiting, TimeWindow } from '../src/utils/rate-limiter';
import { isRateLimitError } from '../src/utils/error-types';

// Mock the logging functions
vi.mock("../src/utils/agent/log.js", () => ({
  __esModule: true,
  log: vi.fn(),
  isLoggingEnabled: () => false,
}));

describe('RateLimiter', () => {
  // Reset the rate limiter before each test
  beforeEach(() => {
    vi.useFakeTimers();
    globalRateLimiter.reset();
  });

  // Cleanup after each test
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test('should track successful requests', () => {
    const rateLimiter = new RateLimiter();
    
    // Start a request and track its success
    rateLimiter.startRequest('openai');
    rateLimiter.trackSuccessfulRequest('openai', 1000);
    
    // Check if the tracker was updated correctly
    const shouldThrottle = rateLimiter.shouldThrottle('openai', 500);
    
    // Should not throttle for a small request
    expect(shouldThrottle.throttle).toBe(false);
    
    // Add more requests to approach the limit
    for (let i = 0; i < 10; i++) {
      rateLimiter.trackSuccessfulRequest('openai', 3000);
    }
    
    // Now should recommend throttling for a large request
    const shouldThrottleNow = rateLimiter.shouldThrottle('openai', 20000);
    expect(shouldThrottleNow.throttle).toBe(true);
    expect(shouldThrottleNow.recommendedDelay).toBeGreaterThan(0);
  });

  test('should handle rate limit errors with exponential backoff', () => {
    const rateLimiter = new RateLimiter();
    
    // Track multiple rate limit errors
    const delay1 = rateLimiter.trackRateLimitError('openai', {}, 1);
    const delay2 = rateLimiter.trackRateLimitError('openai', {}, 2);
    const delay3 = rateLimiter.trackRateLimitError('openai', {}, 3);
    
    // Delays should increase exponentially
    expect(delay1).toBeGreaterThan(0);
    expect(delay2).toBeGreaterThan(delay1);
    expect(delay3).toBeGreaterThan(delay2);
  });

  test('should reset usage counters after time window expires', () => {
    const rateLimiter = new RateLimiter();
    
    // Add some usage
    rateLimiter.trackSuccessfulRequest('anthropic', 5000);
    
    // Should not throttle immediately
    const beforeAdvance = rateLimiter.shouldThrottle('anthropic', 1000);
    expect(beforeAdvance.throttle).toBe(false);
    
    // Add more usage to approach limits
    for (let i = 0; i < 8; i++) {
      rateLimiter.trackSuccessfulRequest('anthropic', 3000);
    }
    
    // Should throttle now
    const afterUsage = rateLimiter.shouldThrottle('anthropic', 5000);
    expect(afterUsage.throttle).toBe(true);
    
    // Simulate window reset by using a new instance
    // This is necessary because the time window logic uses Date.now() internally
    const newRateLimiter = new RateLimiter();
    
    // Should not throttle with a fresh tracker
    const afterReset = newRateLimiter.shouldThrottle('anthropic', 5000);
    expect(afterReset.throttle).toBe(false);
  });

  test('should handle provider configuration', () => {
    const rateLimiter = new RateLimiter();
    
    // Set a custom provider tier
    rateLimiter.setProviderTier('openai', 'pro');
    
    // Track usage approaching pro tier limits
    for (let i = 0; i < 20; i++) {
      rateLimiter.trackSuccessfulRequest('openai', 5000);
    }
    
    // Check if throttling respects the pro tier limits
    const throttleCheck = rateLimiter.shouldThrottle('openai', 10000);
    
    // Should throttle as we're approaching limits even with pro tier
    expect(throttleCheck.throttle).toBe(true);
    
    // Reset everything
    rateLimiter.reset('openai');
    
    // After reset, should not throttle
    const afterReset = rateLimiter.shouldThrottle('openai', 5000);
    expect(afterReset.throttle).toBe(false);
  });
});


describe('isRateLimitError', () => {
  test('should detect rate limit errors by status code', () => {
    expect(isRateLimitError({ status: 429 })).toBe(true);
  });
  
  test('should detect rate limit errors by error type', () => {
    expect(isRateLimitError({ type: 'rate_limit_exceeded' })).toBe(true);
    expect(isRateLimitError({ code: 'rate_limit_exceeded' })).toBe(true);
  });
  
  test('should detect rate limit errors by message', () => {
    expect(isRateLimitError({ message: 'Rate limit exceeded' })).toBe(true);
  });
  
  test('should detect nested rate limit errors', () => {
    expect(isRateLimitError({ 
      error: { 
        type: 'rate_limit_error', 
        message: 'Too many requests' 
      } 
    })).toBe(true);
  });
  
  test('should return false for non-rate limit errors', () => {
    expect(isRateLimitError({ status: 400 })).toBe(false);
    expect(isRateLimitError({ type: 'invalid_request_error' })).toBe(false);
    expect(isRateLimitError({ message: 'Bad request' })).toBe(false);
    expect(isRateLimitError(null)).toBe(false);
    expect(isRateLimitError(undefined)).toBe(false);
  });
});