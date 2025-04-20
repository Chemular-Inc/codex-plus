/**
 * A simple rate limiter to prevent excessive API calls to providers
 */

// Track rate limiting per provider
interface RateLimitState {
  lastCallTime: number;
  minTimeBetweenCalls: number; // in milliseconds
}

// Track state for each provider
const providerStates: Record<string, RateLimitState> = {
  // Default state for OpenAI
  openai: {
    lastCallTime: 0,
    minTimeBetweenCalls: 100, // 100ms minimum between calls
  },
  // Default state for Anthropic
  anthropic: {
    lastCallTime: 0,
    minTimeBetweenCalls: 200, // 200ms minimum between calls
  },
};

/**
 * Wraps a function call to enforce rate limits for a specific provider
 * Returns the result of the function call
 */
export async function rateLimited<T>(
  provider: string,
  fn: () => Promise<T>
): Promise<T> {
  const state = providerStates[provider] || {
    lastCallTime: 0,
    minTimeBetweenCalls: 200, // Default for unknown providers
  };

  const now = Date.now();
  const timeSinceLastCall = now - state.lastCallTime;
  
  // If we need to wait, delay the execution
  if (timeSinceLastCall < state.minTimeBetweenCalls) {
    const waitTime = state.minTimeBetweenCalls - timeSinceLastCall;
    await new Promise(resolve => setTimeout(resolve, waitTime));
  }
  
  // Update the last call time
  state.lastCallTime = Date.now();
  
  // Call the function
  return fn();
}

/**
 * Update the rate limit configuration for a provider
 */
export function configureRateLimit(
  provider: string,
  minTimeBetweenCalls: number
): void {
  if (!providerStates[provider]) {
    providerStates[provider] = {
      lastCallTime: 0,
      minTimeBetweenCalls,
    };
  } else {
    providerStates[provider].minTimeBetweenCalls = minTimeBetweenCalls;
  }
}