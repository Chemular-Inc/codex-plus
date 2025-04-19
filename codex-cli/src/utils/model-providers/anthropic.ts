/**
 * Anthropic Claude API integration for Codex CLI
 * This module provides integration with Claude AI models
 */

import type { ResponseInputItem, ResponseItem } from "openai/resources/responses/responses.mjs";
import { log, isLoggingEnabled } from "../agent/log.js";
import { executeWithRateLimiting } from "../rate-limiter.js";
import { isRateLimitError } from "../error-types.js";
import { ModelProvider, ProviderOptions, ModelProviderInterface, providerRegistry } from "./provider-interface.js";
import { normalizeModelName } from "../model-utils.js";

// Types mirroring Anthropic API structures
type AnthropicMessage = {
  role: "user" | "assistant" | "system";
  content: Array<AnthropicContent>;
};

type AnthropicContent = 
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

type AnthropicTool = {
  name: string;
  description: string;
  input_schema: object;
};

// Type for tool use structure from Anthropic API
type AnthropicToolUse = {
  id: string;
  name: string;
  input: object;
};

type AnthropicToolResult = {
  tool_use_id: string;
  output: string | object;
};

// Mapping function between OpenAI and Anthropic formats
function mapOpenAIInputToAnthropic(
  input: Array<ResponseInputItem>
): { messages: Array<AnthropicMessage>; toolResults: Array<AnthropicToolResult> } {
  const messages: Array<AnthropicMessage> = [];
  const toolResults: Array<AnthropicToolResult> = [];
  
  for (const item of input) {
    if (item.type === "message") {
      const message: AnthropicMessage = {
        role: item.role as "user" | "assistant" | "system",
        content: [],
      };
      
      for (const contentItem of item.content) {
        if (contentItem.type === "input_text" || contentItem.type === "output_text") {
          message.content.push({ type: "text", text: contentItem.text });
        } else if (contentItem.type === "input_image") {
          // Convert to base64 if needed
          message.content.push({
            type: "image",
            source: {
              type: "base64",
              media_type: "image/jpeg", // Assuming JPEG as default
              data: contentItem.image_url.replace(/^data:image\/[^;]+;base64,/, ""),
            },
          });
        }
        // Skip other content types not supported by Anthropic
      }
      
      if (message.content.length > 0) {
        messages.push(message);
      }
    } else if (item.type === "function_call_output") {
      // Convert function outputs to tool results
      toolResults.push({
        tool_use_id: item.call_id,
        output: item.output,
      });
    }
  }
  
  return { messages, toolResults };
}

// Map Anthropic responses back to OpenAI format for Codex
interface AnthropicResponse {
  id?: string;
  content?: Array<{ type: string; text?: string }>;
  tool_uses?: Array<{ id: string; name: string; input: Record<string, unknown> }>;
}

function mapAnthropicResponseToOpenAI(
  anthropicResponse: AnthropicResponse, 
  conversationId: string
): Array<ResponseItem> {
  const responseItems: Array<ResponseItem> = [];
  
  // First process tool calls so they appear before the message content in the response
  // This is important because the agent loop processes items in order
  if (anthropicResponse.tool_uses && anthropicResponse.tool_uses.length > 0) {
    for (const toolUse of anthropicResponse.tool_uses) {
      // Create function call item
      const functionCallItem: ResponseItem = {
        id: toolUse.id,
        type: "function_call",
        name: toolUse.name,
        call_id: toolUse.id,
        arguments: JSON.stringify(toolUse.input),
      };
      
      // For shell commands, make sure the argument format is compatible
      if (toolUse.name === "shell" && typeof toolUse.input === "object") {
        // If command is a string, convert it to array format that OpenAI expects
        const input = toolUse.input as any;
        if (typeof input.command === "string") {
          const commandArgs = input.command.split(/\s+/).filter(Boolean);
          if (commandArgs.length > 0) {
            const newArguments = {
              ...input,
              command: commandArgs
            };
            functionCallItem.arguments = JSON.stringify(newArguments);
          }
        }
      }
      
      responseItems.push(functionCallItem);
    }
  }
  
  // Map the main message content after tool calls
  if (anthropicResponse.content) {
    const messageItem: ResponseItem = {
      id: `${conversationId}-message`,
      type: "message",
      role: "assistant",
      content: anthropicResponse.content.map((contentBlock) => {
        if (contentBlock.type === "text") {
          return {
            type: "output_text",
            text: contentBlock.text,
          };
        }
        // Handle other content types as needed
        return null;
      }).filter(Boolean),
    };
    
    responseItems.push(messageItem);
  }
  
  // Ensure we always have at least an empty message if nothing else
  if (responseItems.length === 0) {
    responseItems.push({
      id: `${conversationId}-empty`,
      type: "message",
      role: "assistant",
      content: [{
        type: "output_text",
        text: "I'll help with that.",
      }]
    });
  }
  
  return responseItems;
}

/**
 * Anthropic client implementation
 */
class AnthropicClient {
  private apiKey: string;
  private baseUrl: string;
  private defaultModel: string;
  
  constructor(apiKey: string, options?: { baseUrl?: string; defaultModel?: string }) {
    this.apiKey = apiKey;
    this.baseUrl = options?.baseUrl || "https://api.anthropic.com/v1";
    // Use normalized model name and a more reliable default model
    const defaultModel = options?.defaultModel || "claude-3-sonnet";
    this.defaultModel = normalizeModelName(defaultModel);
  }
  
  /**
   * Main method to send messages to Anthropic Claude
   */
  async sendMessage(
    input: Array<ResponseInputItem>,
    options?: {
      model?: string;
      system?: string;
      maxTokens?: number;
      temperature?: number;
      conversationId?: string;
      tools?: Array<AnthropicTool>;
      toolResults?: Array<AnthropicToolResult>;
    }
  ): Promise<{ items: Array<ResponseItem>; response_id: string }> {
    // Use normalized model name to ensure compatibility with Anthropic API
    const rawModel = options?.model || this.defaultModel;
    const model = normalizeModelName(rawModel);
    const conversationId = options?.conversationId || `conv_${Date.now()}`;
    
    // Convert input to Anthropic format
    const { messages, toolResults } = mapOpenAIInputToAnthropic(input);
    
    // Call Anthropic API with rate limiting
    try {
      // Debug logging to trace conversation context issues
      if (isLoggingEnabled()) {
        log(`Claude conversation context - messages: ${messages.length}`);
        const userMsgs = messages.filter(m => m.role === 'user').length;
        const assistantMsgs = messages.filter(m => m.role === 'assistant').length;
        log(`Message breakdown - user: ${userMsgs}, assistant: ${assistantMsgs}`);
        
        // Log any tool results being sent
        if (toolResults.length > 0) {
          log(`Tool results being sent: ${toolResults.length}`);
        }
      }
      
      // More accurate token estimation (Anthropic-specific)
      // This is a better approximation for Claude models
      const estimatedTokens = this.estimateTokenCount(messages, options?.system);
      
      const response = await executeWithRateLimiting(
        'anthropic',
        async () => {
          // Prepare request payload
          interface AnthropicRequestBody {
            model: string;
            messages: Array<AnthropicMessage>;
            max_tokens: number;
            temperature: number;
            system?: string;
            tools?: Array<AnthropicTool>;
            tool_choice?: { type: string };
            tool_results?: Array<AnthropicToolResult>;
            thinking?: { enable: boolean };
          }
          
          const requestBody: AnthropicRequestBody = {
            model,
            messages,
            max_tokens: options?.maxTokens || 4096,
            temperature: options?.temperature || 0.7,
          };
          
          // Add thinking parameter for Claude 3.7+ models
          if (model.includes('claude-3-7') || model.includes('claude-3.7')) {
            requestBody.thinking = { enable: true };
          }
          
          // Add system instruction if provided
          if (options?.system) {
            // Enhance system prompt for Claude to encourage tool usage
            const toolUsageInstructions = `
IMPORTANT: You MUST use the shell tool to explore files, run commands, and interact with the filesystem.
When asked to look at code, search for files, or perform any operations:
1. ALWAYS use the shell tool
2. NEVER say you'll do something without actually doing it
3. MAINTAIN context between messages
4. EXECUTE commands before responding substantively
`;
            requestBody.system = `${options.system}\n\n${toolUsageInstructions}`;
          }
          
          // IMPORTANT: Always include the shell tool for Claude models
          // This ensures tool calls are properly handled
          requestBody.tools = [
            {
              name: "shell",
              description: "Runs a shell command, and returns its output.",
              input_schema: {
                type: "object",
                properties: {
                  command: { 
                    type: "string", 
                    description: "The command to execute. Can include arguments."
                  },
                  workdir: {
                    type: "string",
                    description: "The working directory for the command.",
                  },
                  timeout: {
                    type: "number",
                    description: "The maximum time to wait for the command to complete in milliseconds.",
                  },
                },
                required: ["command"],
              },
            }
          ];
          
          // Set tool_choice as object per Anthropic API requirements
          // Use "auto" to match OpenAI's approach - the model decides when to use tools
          requestBody.tool_choice = { type: "auto" };
          
          // Add tool results if available
          if (toolResults.length > 0 || (options?.toolResults && options.toolResults.length > 0)) {
            requestBody.tool_results = [
              ...(options?.toolResults || []),
              ...toolResults,
            ];
          }
          
          if (isLoggingEnabled()) {
            log(`Sending request to Anthropic: ${JSON.stringify(requestBody, null, 2)}`);
          }
          
          // Make the API call with better error handling
          const response = await fetch(`${this.baseUrl}/messages`, {
            method: "POST",
            headers: {
              "x-api-key": this.apiKey,
              "anthropic-version": "2023-06-01",
              "content-type": "application/json",
              // "anthropic-beta": "tools-2023-12-15", // Removed - no longer supported
            },
            body: JSON.stringify(requestBody),
          });
          
          if (!response.ok) {
            // Get error details
            const errorText = await response.text();
            let errorObj: Record<string, any> = {};
            
            try {
              errorObj = JSON.parse(errorText);
            } catch {
              // If parsing fails, use the raw error text
              errorObj = { message: errorText };
            }
            
            // Add status code to error object
            errorObj.status = response.status;
            
            // Check for retry-after header
            const retryAfter = response.headers.get('retry-after');
            if (retryAfter) {
              errorObj.retry_after = retryAfter;
            }
            
            // Copy relevant headers for error analysis
            errorObj.headers = {};
            response.headers.forEach((value, key) => {
              errorObj.headers[key] = value;
            });
            
            // Only apply rate limit special casing when it's actually a rate limit
            // Don't transform other error types
            if (response.status === 429 || 
                (errorObj.error?.type === 'rate_limit_error') ||
                (errorObj.error?.message && errorObj.error.message.includes('rate limit'))) {
              errorObj.type = 'rate_limit_error';
            }
            
            // Create a proper error with the detailed message
            const errorMsg = errorObj.error?.message || errorObj.message || errorText;
            const error = new Error(`Anthropic API Error (${response.status}): ${errorMsg}`);
            
            // Attach the original error details for debugging
            (error as any).details = errorObj;
            
            // Throw the error with its original message and status
            throw error;
          }
          
          return response.json();
        },
        {
          estimatedTokens,
          // Configure timeout for Anthropic requests
          timeoutMs: 120000, // 120 second timeout for Claude (same as OpenAI)
          onRateLimitEncountered: (delayMs, attempt) => {
            log(`Anthropic rate limit encountered: waiting ${Math.round(delayMs / 1000)}s before attempt ${attempt}`);
            
            // Mimic OpenAI's error handling for consistency
            if (attempt > 0) {
              throw new Error(`⏳ Rate limit reached. Automatically retrying in ${Math.round(delayMs / 1000)} seconds... (Attempt ${attempt})`);
            }
          },
          onFinalFailure: (error) => {
            log(`Anthropic API error after all retries: ${JSON.stringify(error)}`);
            
            // Special handling for rate limit errors only
            if (isRateLimitError(error)) {
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
            } else {
              // For other errors, show the original error message clearly
              const errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
              throw new Error(`⚠️ Anthropic API Error: ${errorMessage}`);
            }
          }
        }
      );
      
      // Map the response back to OpenAI format
      const items = mapAnthropicResponseToOpenAI(response, conversationId);
      
      return {
        items,
        response_id: response.id || conversationId,
      };
    } catch (error) {
      // Log the full error details for debugging
      log(`Error calling Anthropic API: ${error instanceof Error ? error.message : JSON.stringify(error)}`);
      
      // Enhanced error handling for specific error types
      const errorObj = error as Record<string, any>;
      const details = errorObj.details || errorObj;
      
      // Handle content policy violations in a user-friendly way
      if (details.type === 'content_policy_violation' || 
          details.error_type === 'content_policy_violation' || 
          details.error?.type === 'content_policy_violation' ||
          (typeof errorObj.message === 'string' && 
           errorObj.message.includes('content filter'))) {
        throw new Error(
          "Anthropic's content filter has blocked this request. " +
          "Please modify your prompt and try again."
        );
      }
      
      // Handle API errors with more specific information
      if (details.status === 400 || details.status === 401 || details.status === 403) {
        const message = details.error?.message || details.message || "Unknown error";
        throw new Error(`Anthropic API Error (${details.status}): ${message}`);
      }
      
      // Preserve the original error with its message
      if (error instanceof Error) {
        throw error;
      } else {
        throw new Error(`Anthropic API Error: ${JSON.stringify(error)}`);
      }
    }
  }
  
  /**
   * Estimate token count for Anthropic models
   * More accurate than the generic byte-based estimate
   */
  private estimateTokenCount(
    messages: Array<AnthropicMessage>, 
    systemPrompt?: string
  ): number {
    // Constants for Claude token estimation
    const AVG_CHARS_PER_TOKEN = 4;
    const MESSAGE_OVERHEAD_TOKENS = 4; // Tokens for message formatting
    
    let totalTokens = 0;
    
    // Count system prompt tokens
    if (systemPrompt) {
      totalTokens += Math.ceil(systemPrompt.length / AVG_CHARS_PER_TOKEN) + 10; // Extra overhead for system
    }
    
    // Count message tokens
    for (const message of messages) {
      // Add per-message overhead
      totalTokens += MESSAGE_OVERHEAD_TOKENS;
      
      // Count tokens in content
      for (const content of message.content) {
        if (content.type === 'text') {
          totalTokens += Math.ceil((content.text?.length || 0) / AVG_CHARS_PER_TOKEN);
        } else if (content.type === 'image') {
          // Images have higher token counts in Claude
          // Base64 images are approximately 4/3 their byte size
          const base64Data = content.source?.data || '';
          const imageBytes = base64Data.length * 0.75;
          // Very rough approximation: 85 tokens per 512x512 image 
          // Adjust based on estimated image complexity
          totalTokens += Math.max(85, Math.ceil(imageBytes / 5000));
        }
      }
    }
    
    return totalTokens;
  }
  
  /**
   * Configure the tools required for Codex CLI
   * Conforms to Anthropic's current tool specification
   */
  getToolsForCodex(): Array<AnthropicTool> {
    return [
      {
        name: "shell",
        description: "Runs a shell command, and returns its output.",
        input_schema: {
          type: "object",
          properties: {
            command: { 
              type: "string", 
              description: "The command to execute. Can include arguments."
            },
            workdir: {
              type: "string",
              description: "The working directory for the command.",
            },
            timeout: {
              type: "number",
              description: "The maximum time to wait for the command to complete in milliseconds.",
            },
          },
          required: ["command"],
        },
      },
    ];
  }
}

/**
 * Factory function to create an Anthropic client instance
 */
export function createAnthropicClient(
  apiKey: string,
  options?: { baseUrl?: string; defaultModel?: string }
): AnthropicClient {
  return new AnthropicClient(apiKey, options);
}

/**
 * Implementation for Anthropic provider that meets the ModelProviderInterface
 */
class AnthropicProvider implements ModelProviderInterface {
  public provider = ModelProvider.ANTHROPIC;
  private client: any;
  private model: string;
  private options: ProviderOptions;
  
  constructor(options: ProviderOptions) {
    this.model = options.model;
    this.options = options;
    // Client will be initialized lazily in sendMessage
  }
  
  private async initializeClient(): Promise<void> {
    if (this.client) return;
    
    this.client = createAnthropicClient(this.options.apiKey, {
      baseUrl: this.options.baseUrl,
      defaultModel: this.options.model,
    });
  }
  
  async sendMessage(
    input: Array<ResponseInputItem>,
    options: {
      reasoning?: unknown;
      system?: string;
      temperature?: number;
      previousResponseId?: string;
      conversationId?: string;
    }
  ): Promise<{
    items: Array<ResponseItem>;
    response_id: string;
  }> {
    try {
      // Make sure client is initialized
      await this.initializeClient();
      
      if (isLoggingEnabled()) {
        log(`Anthropic provider sending message with model: ${this.model}`);
        log(`Input contains ${input.length} items`);
        if (options.system) {
          log(`System prompt length: ${options.system.length}`);
        }
      }
      
      // Pass conversation ID from previousResponseId if available
      const conversationId = options.previousResponseId ? 
        options.previousResponseId : 
        options.conversationId || `conv_${Date.now()}`;
      
      const result = await this.client.sendMessage(input, {
        model: this.model,
        system: options.system,
        temperature: options.temperature || 0.7,
        conversationId: conversationId,
        // Always include shell tool to match OpenAI capability
        tools: this.client.getToolsForCodex(),
      });
      
      if (isLoggingEnabled()) {
        log(`Anthropic response contains ${result.items.length} items`);
        const toolCalls = result.items.filter(item => item.type === "function_call").length;
        if (toolCalls > 0) {
          log(`Response includes ${toolCalls} tool calls`);
        }
      }
      
      return result;
    } catch (error) {
      if (isLoggingEnabled()) {
        log(`Error in Anthropic provider: ${error instanceof Error ? error.message : String(error)}`);
      }
      throw error;
    }
  }
}

/**
 * Factory function for creating Anthropic provider instances
 */
export async function createAnthropicProvider(options: ProviderOptions): Promise<ModelProviderInterface> {
  return new AnthropicProvider(options);
}

// Register this provider with the registry
providerRegistry.registerProvider(
  ModelProvider.ANTHROPIC,
  createAnthropicProvider,
  [/^claude/, /anthropic/] // Model name patterns for Anthropic
);