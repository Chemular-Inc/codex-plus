/**
 * Command-line interface for configuring rate limiting settings
 */

import { loadConfig, saveConfig } from "./config.js";
import { globalRateLimiter, RateLimitConfig, TimeWindow, PROVIDER_CONFIGS } from "./rate-limiter.js";
import { homedir } from "os";
import { join } from "path";

// Using same path as defined in config.js
// Prefix with underscore to indicate it's not directly used
const _CONFIG_DIR = join(homedir(), ".codex");

/**
 * Configuration options for rate limiting CLI
 */
export interface RateLimitConfigOptions {
  provider?: string;
  enable?: boolean;
  maxRetries?: number;
  baseDelay?: number;
  maxDelay?: number;
  useJitter?: boolean;
  tier?: string;
  concurrencyLimit?: number;
  tokensPerMinute?: number;
  requestsPerMinute?: number;
}

/**
 * Configure rate limiting settings for a provider
 */
export function configureRateLimiting(
  options: RateLimitConfigOptions = {}
): string {
  const provider = options.provider?.toLowerCase() || "openai";
  
  // Load the current config
  const config = loadConfig();
  
  // Ensure rate limiting config exists
  if (!config.rateLimiting) {
    config.rateLimiting = {
      enabled: true,
      maxRetries: 5,
      baseDelayMs: 2000,
      maxDelayMs: 60000,
      useJitter: true,
    };
  }
  
  // Update rate limiting settings if provided
  if (options.enable !== undefined) {
    config.rateLimiting.enabled = options.enable;
    
    // Update global rate limiter
    globalRateLimiter.setEnabled(options.enable);
  }
  
  if (options.maxRetries !== undefined) {
    config.rateLimiting.maxRetries = options.maxRetries;
  }
  
  if (options.baseDelay !== undefined) {
    config.rateLimiting.baseDelayMs = options.baseDelay;
  }
  
  if (options.maxDelay !== undefined) {
    config.rateLimiting.maxDelayMs = options.maxDelay;
  }
  
  if (options.useJitter !== undefined) {
    config.rateLimiting.useJitter = options.useJitter;
  }
  
  // Ensure providers config exists
  if (!config.providers) {
    config.providers = {
      openai: {},
      anthropic: {},
    };
  }
  
  // Ensure provider config exists
  if (!config.providers[provider]) {
    config.providers[provider] = {};
  }
  
  // Update provider tier if specified
  if (options.tier) {
    config.providers[provider].tier = options.tier;
    
    // Update the global rate limiter with the new tier
    globalRateLimiter.setProviderTier(provider, options.tier);
  }
  
  // Handle custom rate limits (advanced users)
  const updateProviderLimits = (
    providerName: string, 
    tokensPerMinute?: number, 
    requestsPerMinute?: number,
    concurrencyLimit?: number
  ) => {
    if (!config.providers[providerName].limits) {
      config.providers[providerName].limits = {};
    }
    
    if (tokensPerMinute !== undefined) {
      config.providers[providerName].limits.tokensPerMinute = tokensPerMinute;
    }
    
    if (requestsPerMinute !== undefined) {
      config.providers[providerName].limits.requestsPerMinute = requestsPerMinute;
    }
    
    if (concurrencyLimit !== undefined) {
      config.providers[providerName].limits.concurrencyLimit = concurrencyLimit;
    }
  };
  
  // Update provider-specific limits if provided
  updateProviderLimits(
    provider,
    options.tokensPerMinute,
    options.requestsPerMinute,
    options.concurrencyLimit
  );
  
  // Apply custom provider limits if set
  if (config.providers[provider].limits) {
    const customConfig = {
      ...config.providers[provider].limits
    };
    
    // Update global rate limiter with custom provider config
    globalRateLimiter.updateConfig({
      providerConfig: customConfig
    });
  }
  
  // Save the updated config
  saveConfig(config);
  
  // Return a configuration summary
  return generateConfigSummary(config, provider);
}

/**
 * Generate a user-friendly summary of the rate limiting configuration
 */
interface RateLimitConfigSummary {
  rateLimiting: {
    enabled: boolean;
    maxRetries: number;
    baseDelayMs: number;
    maxDelayMs: number;
    useJitter: boolean;
  };
  providers?: {
    [provider: string]: {
      tier?: string;
      limits?: {
        tokensPerMinute?: number;
        requestsPerMinute?: number;
        concurrencyLimit?: number;
      };
    };
  };
}

function generateConfigSummary(config: RateLimitConfigSummary, provider: string): string {
  const summary: Array<string> = [];
  
  summary.push(`Rate limiting configuration:`);
  summary.push(`- Status: ${config.rateLimiting.enabled ? "Enabled" : "Disabled"}`);
  summary.push(`- Max retries: ${config.rateLimiting.maxRetries}`);
  summary.push(`- Base delay: ${config.rateLimiting.baseDelayMs}ms`);
  summary.push(`- Max delay: ${config.rateLimiting.maxDelayMs}ms`);
  summary.push(`- Use jitter: ${config.rateLimiting.useJitter ? "Yes" : "No"}`);
  
  // Add provider-specific info
  const providerInfo = config.providers?.[provider];
  if (providerInfo) {
    if (providerInfo.tier) {
      summary.push(`- ${provider.charAt(0).toUpperCase() + provider.slice(1)} tier: ${providerInfo.tier}`);
    }
    
    // Add custom limits if set
    const limits = providerInfo.limits;
    if (limits) {
      if (limits.tokensPerMinute) {
        summary.push(`- Tokens per minute: ${limits.tokensPerMinute}`);
      }
      if (limits.requestsPerMinute) {
        summary.push(`- Requests per minute: ${limits.requestsPerMinute}`);
      }
      if (limits.concurrencyLimit) {
        summary.push(`- Concurrency limit: ${limits.concurrencyLimit}`);
      }
    }
    
    // Add provider tier defaults
    if (providerInfo.tier && PROVIDER_CONFIGS[provider]?.[providerInfo.tier]) {
      const tierDefaults = PROVIDER_CONFIGS[provider][providerInfo.tier];
      
      if (!limits?.tokensPerMinute && tierDefaults.tokensPerMinute) {
        summary.push(`- Tokens per minute (tier default): ${tierDefaults.tokensPerMinute}`);
      }
      if (!limits?.requestsPerMinute && tierDefaults.requestsPerMinute) {
        summary.push(`- Requests per minute (tier default): ${tierDefaults.requestsPerMinute}`);
      }
      if (!limits?.concurrencyLimit && tierDefaults.concurrencyLimit) {
        summary.push(`- Concurrency limit (tier default): ${tierDefaults.concurrencyLimit}`);
      }
    }
  }
  
  return summary.join("\n");
}

/**
 * Get the current rate limiting configuration
 */
export function getRateLimitingConfig(): Record<string, unknown> {
  const config = loadConfig();
  return {
    ...config.rateLimiting,
    providers: config.providers,
  };
}

/**
 * Get the available provider tiers
 */
export function getAvailableProviderTiers(): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  
  for (const provider in PROVIDER_CONFIGS) {
    result[provider] = Object.keys(PROVIDER_CONFIGS[provider])
      .filter(tier => tier !== 'default');
  }
  
  return result;
}

/**
 * Reset all rate limit trackers
 */
export function resetRateLimitTrackers(provider?: string): void {
  globalRateLimiter.reset(provider);
}