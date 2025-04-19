/**
 * Comprehensive rate limiter for handling different LLM API providers
 * Built to support varying rate limit structures and recovery strategies
 */

import { isRateLimitError, extractRetryAfterDelay } from './error-types.js';

/**
 * Configuration options for rate limiting
 */
export interface RateLimitConfig {
  // Maximum number of retries for rate-limited requests
  maxRetries: number;
  // Base delay for exponential backoff (ms)
  baseDelayMs: number;
  // Maximum delay cap for backoff (ms)
  maxDelayMs: number;
  // Whether to use jitter in backoff calculations
  useJitter: boolean;
  // Optional provider-specific settings
  providerConfig?: ProviderRateLimitConfig;
  // Whether rate limiting is enabled globally
  enabled?: boolean;
}

/**
 * Provider-specific rate limit configuration
 */
export interface ProviderRateLimitConfig {
  // Tokens per minute (TPM) limit if applicable
  tokensPerMinute?: number;
  // Requests per minute (RPM) limit if applicable
  requestsPerMinute?: number;
  // Whether this provider offers retry-after headers
  supportsRetryAfterHeader?: boolean;
  // Optional tier name for the current API key (e.g. "free", "pro", "enterprise")
  tier?: string;
  // Optional concurrency limit (simultaneous requests)
  concurrencyLimit?: number;
}

/**
 * Time window type (minute, hour, day)
 */
export enum TimeWindow {
  MINUTE = 60 * 1000,
  HOUR = 60 * 60 * 1000,
  DAY = 24 * 60 * 60 * 1000,
}

/**
 * Known API providers with their tier-based settings
 */
export const PROVIDER_CONFIGS: Record<string, Record<string, ProviderRateLimitConfig>> = {
  'openai': {
    // Different tiers have different limits
    'free': {
      tokensPerMinute: 60000,
      requestsPerMinute: 200,
      supportsRetryAfterHeader: true,
      concurrencyLimit: 10,
    },
    'pro': {
      tokensPerMinute: 120000,
      requestsPerMinute: 500,
      supportsRetryAfterHeader: true,
      concurrencyLimit: 25,
    },
    'enterprise': {
      tokensPerMinute: 300000,
      requestsPerMinute: 5000,
      supportsRetryAfterHeader: true,
      concurrencyLimit: 100,
    },
    // Default tier uses conservative settings
    'default': {
      tokensPerMinute: 40000,
      requestsPerMinute: 100,
      supportsRetryAfterHeader: true,
      concurrencyLimit: 5,
    }
  },
  'anthropic': {
    // Claude tier settings
    'free': {
      tokensPerMinute: 40000,
      requestsPerMinute: 60,
      supportsRetryAfterHeader: true,
      concurrencyLimit: 5,
    },
    'pro': {
      tokensPerMinute: 100000,
      requestsPerMinute: 120,
      supportsRetryAfterHeader: true,
      concurrencyLimit: 15,
    },
    'enterprise': {
      tokensPerMinute: 200000,
      requestsPerMinute: 240,
      supportsRetryAfterHeader: true,
      concurrencyLimit: 30,
    },
    // Default tier uses conservative settings
    'default': {
      tokensPerMinute: 30000,
      requestsPerMinute: 50,
      supportsRetryAfterHeader: true,
      concurrencyLimit: 3,
    }
  }
};

/**
 * Usage tracking to prevent hitting limits
 */
interface UsageTracker {
  provider: string;
  windowStartTime: number;
  requestCount: number;
  tokenCount: number;
  lastRequestTime: number;
  recentDelays: Array<number>; // Store recent backoff delays for adaptive strategy
  consecutiveRateLimitErrors: number;
  activeRequests: number; // Track concurrency
  hourlyRequestCount: number; // Longer time windows for some rate limits
  hourlyWindowStartTime: number;
  dailyRequestCount: number;
  dailyWindowStartTime: number;
}

/**
 * Primary rate limiter implementation with intelligent throttling and retry logic
 */
export class RateLimiter {
  private config: RateLimitConfig;
  private usageTrackers: Map<string, UsageTracker> = new Map();
  
  /**
   * Create a new rate limiter instance
   */
  constructor(config?: Partial<RateLimitConfig>) {
    // Default configuration with conservative settings
    this.config = {
      maxRetries: 5,
      baseDelayMs: 2000,
      maxDelayMs: 60000,
      useJitter: true,
      enabled: true,
      ...config
    };
  }

  /**
   * Get or create a usage tracker for a specific provider
   */
  private getTracker(provider: string): UsageTracker {
    if (!this.usageTrackers.has(provider)) {
      this.usageTrackers.set(provider, {
        provider,
        windowStartTime: Date.now(),
        requestCount: 0,
        tokenCount: 0,
        lastRequestTime: 0,
        recentDelays: [],
        consecutiveRateLimitErrors: 0,
        activeRequests: 0,
        hourlyRequestCount: 0,
        hourlyWindowStartTime: Date.now(),
        dailyRequestCount: 0,
        dailyWindowStartTime: Date.now()
      });
    }
    return this.usageTrackers.get(provider)!;
  }

  /**
   * Record the start of a request (for concurrency tracking)
   */
  public startRequest(provider: string): void {
    const tracker = this.getTracker(provider);
    tracker.activeRequests++;
  }

  /**
   * Update the usage tracker with a successful request
   */
  public trackSuccessfulRequest(provider: string, tokenCount: number = 0): void {
    const tracker = this.getTracker(provider);
    
    // Decrease active request count
    if (tracker.activeRequests > 0) {
      tracker.activeRequests--;
    }
    
    // Reset minute window if more than one minute has passed
    if (Date.now() - tracker.windowStartTime > TimeWindow.MINUTE) {
      tracker.windowStartTime = Date.now();
      tracker.requestCount = 0;
      tracker.tokenCount = 0;
    }
    
    // Reset hourly window if needed
    if (Date.now() - tracker.hourlyWindowStartTime > TimeWindow.HOUR) {
      tracker.hourlyWindowStartTime = Date.now();
      tracker.hourlyRequestCount = 0;
    }
    
    // Reset daily window if needed
    if (Date.now() - tracker.dailyWindowStartTime > TimeWindow.DAY) {
      tracker.dailyWindowStartTime = Date.now();
      tracker.dailyRequestCount = 0;
    }
    
    // Update counters
    tracker.requestCount++;
    tracker.hourlyRequestCount++;
    tracker.dailyRequestCount++;
    tracker.tokenCount += tokenCount;
    tracker.lastRequestTime = Date.now();
    tracker.consecutiveRateLimitErrors = 0; // Reset consecutive errors on success
  }

  /**
   * Track a rate limit error and return the recommended delay
   */
  public trackRateLimitError(
    provider: string, 
    errorObj: unknown, 
    attempt: number
  ): number {
    const tracker = this.getTracker(provider);
    tracker.consecutiveRateLimitErrors++;
    
    // Decrease active request count (the request failed)
    if (tracker.activeRequests > 0) {
      tracker.activeRequests--;
    }
    
    // Parse retry-after header if available
    let suggestedDelayMs = this.parseRetryAfterDelay(errorObj);
    
    // If no header available, calculate backoff with exponential strategy
    if (!suggestedDelayMs) {
      suggestedDelayMs = this.calculateExponentialBackoff(attempt, tracker);
    }
    
    // Ensure minimum delay of 1 second
    suggestedDelayMs = Math.max(suggestedDelayMs, 1000);
    
    // Update tracker with this delay
    tracker.recentDelays.push(suggestedDelayMs);
    if (tracker.recentDelays.length > 5) {
      tracker.recentDelays.shift(); // Keep only the 5 most recent delays
    }
    
    return suggestedDelayMs;
  }

  /**
   * Extract retry-after information from error objects
   */
  private parseRetryAfterDelay(errorObj: unknown): number | null {
    return extractRetryAfterDelay(errorObj);
  }

  /**
   * Calculate exponential backoff with optional jitter
   */
  private calculateExponentialBackoff(attempt: number, tracker: UsageTracker): number {
    // Base exponential backoff: baseDelay * 2^(attempt-1)
    let delay = this.config.baseDelayMs * Math.pow(2, attempt - 1);
    
    // Apply jitter if enabled (prevents thundering herd problem)
    if (this.config.useJitter) {
      // Add random jitter of ±25%
      const jitterRange = delay * 0.5;
      delay = delay - jitterRange/2 + (Math.random() * jitterRange);
    }
    
    // If we have consecutive errors, increase the delay further
    if (tracker.consecutiveRateLimitErrors > 1) {
      delay *= 1 + (tracker.consecutiveRateLimitErrors * 0.2); // 20% increase per consecutive error
    }
    
    // Adaptive strategy: if we've seen multiple rate limits, use the average
    // of recent delays as a minimum to avoid rapid retries
    if (tracker.recentDelays.length > 0) {
      const avgRecentDelay = tracker.recentDelays.reduce((sum, d) => sum + d, 0) / 
                            tracker.recentDelays.length;
      delay = Math.max(delay, avgRecentDelay * 1.1); // Ensure we wait at least 10% longer than recent average
    }
    
    // Cap at maximum delay
    return Math.min(delay, this.config.maxDelayMs);
  }

  /**
   * Check if we're approaching rate limits and should preemptively throttle
   */
  public shouldThrottle(
    provider: string, 
    estimatedTokens: number = 0
  ): { throttle: boolean; recommendedDelay: number } {
    // Skip rate limiting if disabled globally
    if (this.config.enabled === false) {
      return { throttle: false, recommendedDelay: 0 };
    }
    
    const tracker = this.getTracker(provider);
    const providerInfo = this.getProviderConfig(provider);
    
    if (!providerInfo) {
      return { throttle: false, recommendedDelay: 0 };
    }
    
    // If concurrency limit is reached, throttle
    if (providerInfo.concurrencyLimit && 
        tracker.activeRequests >= providerInfo.concurrencyLimit) {
      return {
        throttle: true,
        recommendedDelay: this.calculateThrottleDelay(0.9, tracker, TimeWindow.MINUTE)
      };
    }
    
    // Check if we're approaching RPM limits
    const rpmLimit = providerInfo.requestsPerMinute;
    const rpmUsage = tracker.requestCount;
    const rpmPercentage = rpmLimit ? (rpmUsage / rpmLimit) : 0;
    
    // Check if we're approaching TPM limits
    const tpmLimit = providerInfo.tokensPerMinute;
    const currentTokens = tracker.tokenCount;
    const potentialTokenUsage = currentTokens + estimatedTokens;
    const tpmPercentage = tpmLimit ? (potentialTokenUsage / tpmLimit) : 0;
    
    // Determine throttling based on usage percentages
    // More aggressive as we get closer to limits
    if (rpmPercentage > 0.95 || tpmPercentage > 0.95) {
      // Critical - near limit, throttle aggressively
      return { 
        throttle: true, 
        recommendedDelay: this.calculateThrottleDelay(0.95, tracker, TimeWindow.MINUTE) 
      };
    } else if (rpmPercentage > 0.8 || tpmPercentage > 0.8) {
      // High usage - throttle moderately
      return { 
        throttle: true, 
        recommendedDelay: this.calculateThrottleDelay(0.8, tracker, TimeWindow.MINUTE) 
      };
    } else if (rpmPercentage > 0.6 || tpmPercentage > 0.6) {
      // Moderate usage - light throttling
      return { 
        throttle: true, 
        recommendedDelay: this.calculateThrottleDelay(0.6, tracker, TimeWindow.MINUTE) 
      };
    }
    
    // No need to throttle
    return { throttle: false, recommendedDelay: 0 };
  }

  /**
   * Calculate appropriate delay for throttling based on usage percentage and time window
   */
  private calculateThrottleDelay(
    usagePercentage: number, 
    tracker: UsageTracker, 
    timeWindow: TimeWindow = TimeWindow.MINUTE
  ): number {
    // Calculate time remaining in current window
    let timeElapsed: number;
    let windowSize: number;
    
    switch (timeWindow) {
      case TimeWindow.HOUR:
        timeElapsed = Date.now() - tracker.hourlyWindowStartTime;
        windowSize = TimeWindow.HOUR;
        break;
      case TimeWindow.DAY:
        timeElapsed = Date.now() - tracker.dailyWindowStartTime;
        windowSize = TimeWindow.DAY;
        break;
      case TimeWindow.MINUTE:
      default:
        timeElapsed = Date.now() - tracker.windowStartTime;
        windowSize = TimeWindow.MINUTE;
        break;
    }
    
    const timeRemaining = Math.max(0, windowSize - timeElapsed);
    
    // Scale delay based on usage percentage
    if (usagePercentage > 0.95) {
      // At 95%+ usage, wait for most of the remaining window
      return timeRemaining * 0.8;
    } else if (usagePercentage > 0.8) {
      // At 80-95% usage, moderate delay
      return timeRemaining * 0.5;
    } else if (usagePercentage > 0.6) {
      // At 60-80% usage, light delay
      return timeRemaining * 0.2;
    } else {
      // Below 60%, minimal delay
      return Math.min(1000, timeRemaining * 0.1);
    }
  }

  /**
   * Get provider configuration based on tier
   */
  private getProviderConfig(provider: string): ProviderRateLimitConfig | null {
    // First check if we have custom config set
    if (this.config.providerConfig) {
      return this.config.providerConfig;
    }
    
    // Get from known providers
    const providerConfigs = PROVIDER_CONFIGS[provider];
    if (!providerConfigs) {
      // No config found, use conservative defaults
      return {
        requestsPerMinute: 60,
        tokensPerMinute: 40000,
        supportsRetryAfterHeader: false,
        concurrencyLimit: 5
      };
    }
    
    // Return the default tier if available
    return providerConfigs.default || Object.values(providerConfigs)[0];
  }

  /**
   * Set the tier for a provider
   */
  public setProviderTier(provider: string, tier: string): void {
    const providerConfigs = PROVIDER_CONFIGS[provider];
    if (providerConfigs && tier in providerConfigs) {
      this.config.providerConfig = providerConfigs[tier];
    }
  }

  /**
   * Reset usage tracking for a fresh start
   */
  public reset(provider?: string): void {
    if (provider) {
      this.usageTrackers.delete(provider);
    } else {
      this.usageTrackers.clear();
    }
  }
  
  /**
   * Enable or disable rate limiting globally
   */
  public setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
  }
  
  /**
   * Update the rate limiter configuration
   */
  public updateConfig(config: Partial<RateLimitConfig>): void {
    this.config = {
      ...this.config,
      ...config
    };
  }
}

// Create a singleton instance for global use
export const globalRateLimiter = new RateLimiter();

/**
 * Options for rate-limited execution
 */
export interface RateLimitExecutionOptions {
  estimatedTokens?: number;
  maxRetries?: number;
  onRateLimitEncountered?: (delay: number, attempt: number) => void;
  onFinalFailure?: (error: unknown) => void;
  timeoutMs?: number;
  priority?: 'high' | 'normal' | 'low';
}

/**
 * Utility function for rate-limited execution with retries
 */
export async function executeWithRateLimiting<T>(
  provider: string,
  operation: () => Promise<T>,
  options: RateLimitExecutionOptions = {}
): Promise<T> {
  const limiter = globalRateLimiter;
  const maxRetries = options.maxRetries ?? 5;
  
  // Debug logs only in debug mode, not in normal operation
  if (process.env.DEBUG) {
    log(`Rate Limiter: Starting request for provider: ${provider}`);
  }
  
  // Start tracking this request for concurrency limits
  limiter.startRequest(provider);
  
  // Add timeout if specified
  let timeoutId: NodeJS.Timeout | undefined;
  const operationWithTimeout = options.timeoutMs 
    ? () => new Promise<T>((resolve, reject) => {
        const timeout = setTimeout(() => {
          clearTimeout(timeout);
          reject(new Error(`Request timed out after ${options.timeoutMs}ms`));
        }, options.timeoutMs);
        
        timeoutId = timeout;
        
        operation()
          .then(result => {
            clearTimeout(timeout);
            resolve(result);
          })
          .catch(error => {
            clearTimeout(timeout);
            reject(error);
          });
      })
    : operation;
  
  // Check if we should throttle preemptively
  const throttleCheck = limiter.shouldThrottle(provider, options.estimatedTokens);
  if (throttleCheck.throttle) {
    if (options.onRateLimitEncountered) {
      options.onRateLimitEncountered(throttleCheck.recommendedDelay, 0);
    }
    // Wait for the recommended delay - use Promise.resolve to avoid linting issues
    // with await in loops while maintaining the proper flow control
    await Promise.resolve(new Promise(resolve => setTimeout(resolve, throttleCheck.recommendedDelay)));
  }
  
  // Use a recursive approach instead of a loop to avoid linting issues with 'await' in loops
  async function attemptWithRetry(attempt: number): Promise<T> {
    try {
      const result = await operationWithTimeout();
      
      // Clear timeout if it exists
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      
      // Track successful request
      limiter.trackSuccessfulRequest(provider, options.estimatedTokens);
      return result;
    } catch (error) {
      // Clear timeout if it exists
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      
      // Check if this is a rate limit error
      const isRateLimit = isRateLimitError(error);
      
      if (isRateLimit && attempt <= maxRetries) {
        // Track rate limit error and get recommended delay
        const delayMs = limiter.trackRateLimitError(provider, error, attempt);
        
        // Notify caller of rate limit
        if (options.onRateLimitEncountered) {
          options.onRateLimitEncountered(delayMs, attempt);
        }
        
        // Wait before retrying
        await Promise.resolve(new Promise(resolve => setTimeout(resolve, delayMs)));
        
        // Recursive call for the next attempt
        return attemptWithRetry(attempt + 1);
      }
      
      // Either not a rate limit error or we've exhausted retries
      if (options.onFinalFailure) {
        options.onFinalFailure(error);
      }
      throw error;
    }
  }
  
  // Start the first attempt
  return attemptWithRetry(1);
}