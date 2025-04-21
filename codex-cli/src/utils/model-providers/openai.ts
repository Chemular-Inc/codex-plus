/**
 * OpenAI provider implementation for Codex CLI
 */

import type { ResponseInputItem, ResponseItem } from "openai/resources/responses/responses.mjs";
import { log, isLoggingEnabled } from "../agent/log.js";
import { executeWithRateLimiting } from "../rate-limiter.js";
import { ModelProvider, ProviderOptions, ModelProviderInterface, providerRegistry } from "./provider-interface.js";

/**
 * Implementation for OpenAI provider
 */
class OpenAIProvider implements ModelProviderInterface {
  public provider = ModelProvider.OPENAI;
  private client: any; // Use any to avoid direct import
  private model: string;
  private options: ProviderOptions;
  
  constructor(options: ProviderOptions) {
    this.model = options.model;
    this.options = options;
    // Initialize client lazily in sendMessage to avoid import issues
  }
  
  private async initializeClient(): Promise<void> {
    if (this.client) return;
    
    // Dynamic import to avoid hoisting issues
    const { default: OpenAI } = await import('openai');
    this.client = new OpenAI({
      apiKey: this.options.apiKey,
      baseURL: this.options.baseUrl,
    });
  }
  
  /**
   * Check if a response requires additional tool processing
   * OpenAI handles tools differently - we don't need to continue the loop with tool results
   * @param response The response to check
   * @returns false for OpenAI provider
   */
  public requiresToolProcessing(response: {
    items: Array<ResponseItem>;
    response_id: string;
  }): boolean {
    // OpenAI handles tool calls within its own API flow
    return false;
  }
  
  async sendMessage(
    input: Array<ResponseInputItem>,
    options: {
      reasoning?: unknown;
      system?: string;
      temperature?: number;
      previousResponseId?: string;
      conversationId?: string;
      thinking?: { budgetTokens: number };
    }
  ): Promise<{
    items: Array<ResponseItem>;
    response_id: string;
  }> {
    try {
      // Make sure client is initialized
      await this.initializeClient();
      
      // Estimate tokens for rate limiting
      // Using a more accurate token estimation approach
      const estimatedTokens = this.estimateTokenCount(input, options.system);
      
      // Use executeWithRateLimiting for consistent rate limit handling
      const response = await executeWithRateLimiting(
        'openai',
        async () => {
          return this.client.responses.create({
            model: this.model,
            instructions: options.system || "",
            previous_response_id: options.previousResponseId,
            input,
            stream: false,
            temperature: options.temperature || 0.7,
            parallel_tool_calls: false,
            reasoning: options.reasoning,
            tools: [
              {
                type: "function",
                name: "shell",
                description: "Runs a shell command, and returns its output.",
                strict: false,
                parameters: {
                  type: "object",
                  properties: {
                    command: { type: "array", items: { type: "string" } },
                    workdir: {
                      type: "string",
                      description: "The working directory for the command.",
                    },
                    timeout: {
                      type: "number",
                      description:
                        "The maximum time to wait for the command to complete in milliseconds.",
                    },
                  },
                  required: ["command"],
                  additionalProperties: false,
                },
              },
            ],
          });
        },
        {
          estimatedTokens,
          // Configure timeout for OpenAI requests
          timeoutMs: 120000, // 2 minute timeout
          onRateLimitEncountered: (delayMs, attempt) => {
            if (isLoggingEnabled()) {
              log(`OpenAI rate limit encountered: waiting ${Math.round(delayMs / 1000)}s before attempt ${attempt}`);
            }
            
            // Only emit user-visible messages for non-preemptive throttling (actual rate limit errors)
            if (attempt > 0) {
              // This error will be caught by the agent loop and transformed into a user-visible message
              throw new Error(`⏳ Rate limit reached. Automatically retrying in ${Math.round(delayMs / 1000)} seconds... (Attempt ${attempt})`);
            }
          },
          onFinalFailure: (error) => {
            if (isLoggingEnabled()) {
              log(`OpenAI API error after all retries: ${JSON.stringify(error)}`);
            }
            
            // This will be caught by the agent loop and displayed to the user
            const errorObj = error as Record<string, any>;
            const status = errorObj?.status ?? errorObj?.httpStatus ?? errorObj?.statusCode;
            
            const errorDetails = [
              `Status: ${status || "unknown"}`,
              `Code: ${errorObj.code || "unknown"}`,
              `Type: ${errorObj.type || "unknown"}`,
              `Message: ${errorObj.message || "unknown"}`,
            ].join(", ");
            
            throw new Error(`⚠️ Rate limit reached after multiple attempts. Error details: ${errorDetails}. Please try again later.`);
          }
        }
      );
      
      return {
        items: response.output,
        response_id: response.id,
      };
    } catch (error) {
      if (isLoggingEnabled()) {
        log(`Error in OpenAI provider: ${error instanceof Error ? error.message : JSON.stringify(error)}`);
      }
      throw error;
    }
  }
  
  /**
   * Estimate token count for OpenAI models
   * More accurate than the generic byte-based estimate
   */
  private estimateTokenCount(
    input: Array<ResponseInputItem>,
    instructions?: string
  ): number {
    // Constants for OpenAI token estimation
    const AVG_CHARS_PER_TOKEN = 4; // English text averages 4 chars per token
    const MESSAGE_OVERHEAD = 5; // Tokens for message formatting
    
    let totalTokens = 0;
    
    // Count instructions tokens
    if (instructions) {
      totalTokens += Math.ceil(instructions.length / AVG_CHARS_PER_TOKEN) + 10; // Extra overhead for instructions
    }
    
    // Count input tokens
    for (const item of input) {
      // Add message overhead
      totalTokens += MESSAGE_OVERHEAD;
      
      if (item.type === 'message') {
        // Count tokens in message content
        for (const contentItem of item.content || []) {
          if (contentItem.type === 'input_text' || contentItem.type === 'output_text') {
            totalTokens += Math.ceil((contentItem.text?.length || 0) / AVG_CHARS_PER_TOKEN);
          } else if (contentItem.type === 'input_image') {
            // Simplified image token count estimation
            totalTokens += 170; // Assume high-res for safety
          }
        }
      } else if (item.type === 'function_call_output') {
        // Function call outputs can be large
        totalTokens += Math.ceil((item.output?.length || 0) / AVG_CHARS_PER_TOKEN) + 10;
      }
    }
    
    return totalTokens;
  }
}

/**
 * Factory function to create an OpenAI provider instance
 */
export async function createOpenAIProvider(options: ProviderOptions): Promise<ModelProviderInterface> {
  return new OpenAIProvider(options);
}

// Register this provider with the registry
providerRegistry.registerProvider(
  ModelProvider.OPENAI,
  createOpenAIProvider,
  [/^gpt/, /^-openai/] // Model name patterns for OpenAI
);