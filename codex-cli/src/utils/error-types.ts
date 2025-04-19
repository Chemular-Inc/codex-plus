/**
 * Error handling utilities 
 * Provides error detection and parsing utilities for API errors
 */

/**
 * Check if an error object is a rate limit error
 */
export function isRateLimitError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  
  const errorObj = error as Record<string, any>;
  
  // Check for status code 429
  if (errorObj.status === 429) return true;
  
  // Check for error types
  if (
    errorObj.code === 'rate_limit_exceeded' ||
    errorObj.type === 'rate_limit_exceeded'
  ) {
    return true;
  }
  
  // Check for error message containing "rate limit"
  if (
    typeof errorObj.message === 'string' && 
    /rate limit/i.test(errorObj.message)
  ) {
    return true;
  }
  
  // Check for rate limit in nested error object
  if (errorObj.error && typeof errorObj.error === 'object') {
    if (
      errorObj.error.type === 'rate_limit_error' ||
      errorObj.error.code === 'rate_limit_exceeded' ||
      (typeof errorObj.error.message === 'string' && 
       /rate limit/i.test(errorObj.error.message))
    ) {
      return true;
    }
  }
  
  return false;
}

/**
 * Extract retry-after delay from error objects
 */
export function extractRetryAfterDelay(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  
  const errorObj = error as Record<string, any>;
  
  // Check for retry-after header
  if (errorObj.retry_after) {
    const retryAfter = Number(errorObj.retry_after);
    if (!isNaN(retryAfter)) {
      return retryAfter * 1000; // Convert to ms
    }
  }
  
  // Check for retry_after in headers
  if (errorObj.headers && errorObj.headers['retry-after']) {
    const retryAfter = Number(errorObj.headers['retry-after']);
    if (!isNaN(retryAfter)) {
      return retryAfter * 1000; // Convert to ms
    }
  }
  
  // Parse from error message "Please try again in 1.23s"
  if (typeof errorObj.message === 'string') {
    const match = /(?:retry|try) again in ([\d.]+)s/i.exec(errorObj.message);
    if (match && match[1]) {
      const seconds = parseFloat(match[1]);
      if (!isNaN(seconds)) {
        return seconds * 1000; // Convert to ms
      }
    }
  }
  
  // Check debug logs for troubleshooting
  if (process.env.DEBUG) {
    console.log('Rate limit error detected, but no retry delay found:', errorObj);
  }
  
  return null;
}