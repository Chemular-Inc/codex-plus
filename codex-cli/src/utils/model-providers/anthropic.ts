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

// -----------------------------------------------------------------------------
// ANTHROPIC MESSAGE TYPES
// -----------------------------------------------------------------------------

// Message types for Anthropic (per their API specification)
export interface AnthropicMessage {
  role: "user" | "assistant" | "system";
  content: AnthropicContent[];
}

export type AnthropicContent = 
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string | AnthropicContent[]; is_error?: boolean };

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface AnthropicResponse {
  id: string;
  model: string;
  type?: string;
  role?: string;
  content?: AnthropicContent[];
  stop_reason?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  }
}

// -----------------------------------------------------------------------------
// MESSAGE FORMAT CONVERSION FUNCTIONS
// -----------------------------------------------------------------------------

/**
 * Convert OpenAI format messages to Anthropic format
 * This is critical - Anthropic needs the complete conversation context
 */
function convertOpenAIToAnthropicMessages(
  input: Array<ResponseInputItem>
): AnthropicMessage[] {
  // Store messages in order they appear
  const messages: AnthropicMessage[] = [];
  
  if (isLoggingEnabled()) {
    log(`Converting ${input.length} OpenAI items to Anthropic format`);
  }
  
  // First pass: Process regular messages
  for (const item of input) {
    if (item.type === "message") {
      // Create Anthropic message object
      const message: AnthropicMessage = {
        role: item.role as "user" | "assistant" | "system",
        content: [],
      };
      
      // Process all content in this message
      if (item.content && item.content.length > 0) {
        for (const contentItem of item.content) {
          // Handle text content
          if ((contentItem.type === "input_text" || contentItem.type === "output_text") && contentItem.text) {
            message.content.push({ 
              type: "text", 
              text: contentItem.text 
            });
          } 
          // Handle image content
          else if (contentItem.type === "input_image" && "image_url" in contentItem) {
            const base64Data = contentItem.image_url.replace(/^data:image\/[^;]+;base64,/, "");
            const mediaType = contentItem.image_url.match(/^data:([^;]+);base64,/)?.[1] || "image/jpeg";
            
            message.content.push({
              type: "image",
              source: {
                type: "base64",
                media_type: mediaType,
                data: base64Data,
              },
            });
          }
        }
      }
      
      // Only add messages that have content
      if (message.content.length > 0) {
        messages.push(message);
      }
    }
  }
  
  // Second pass: Process function call outputs as tool results in a user message
  // Group all tool results into a single user message
  const toolResults: AnthropicContent[] = [];
  
  for (const item of input) {
    if (item.type === "function_call_output" && "call_id" in item) {
      // Create a tool_result content item with proper formatting
      let toolResultContent: string | AnthropicContent[];
      
      // Parse the output to properly format it for Anthropic
      try {
        if (typeof item.output === 'string') {
          // Try to parse as JSON first - outputs are often JSON strings with metadata
          try {
            const parsed = JSON.parse(item.output);
            if (parsed && typeof parsed === 'object' && 'output' in parsed) {
              // Common format: {output: "...", metadata: {...}}
              toolResultContent = typeof parsed.output === 'string' ? parsed.output : JSON.stringify(parsed.output);
            } else {
              // Just use the string directly
              toolResultContent = item.output;
            }
          } catch (e) {
            // Not JSON, use as-is
            toolResultContent = item.output;
          }
        } else {
          // For non-string outputs, stringify the entire object
          toolResultContent = JSON.stringify(item.output);
        }
      } catch (e) {
        // Fallback for any parsing errors
        toolResultContent = String(item.output || "No output");
        if (isLoggingEnabled()) {
          log(`Error processing tool result: ${e}`);
        }
      }
      
      const toolResult: AnthropicContent = {
        type: "tool_result",
        tool_use_id: item.call_id,
        content: toolResultContent
      };
      
      toolResults.push(toolResult);
      
      if (isLoggingEnabled()) {
        log(`Created tool_result for tool_use_id: ${item.call_id}`);
      }
    }
  }
  
  // If we have tool results, add them to a user message
  if (toolResults.length > 0) {
    // Create a specific user message just for tool results
    const toolResultMessage: AnthropicMessage = {
      role: "user",
      content: toolResults
    };
    
    messages.push(toolResultMessage);
    
    if (isLoggingEnabled()) {
      log(`Added user message with ${toolResults.length} tool results`);
    }
  }
  
  if (isLoggingEnabled()) {
    log(`Conversion complete: ${messages.length} Anthropic messages`);
    
    // Print detailed summary for debugging
    messages.forEach((msg, i) => {
      const contentTypes = msg.content.map(c => c.type).join(', ');
      log(`Message ${i+1}: [${msg.role}] containing ${msg.content.length} items (${contentTypes})`);
    });
  }
  
  return messages;
}

/**
 * Convert Anthropic response to OpenAI format items for the agent loop
 */
function convertAnthropicToOpenAIResponse(
  response: AnthropicResponse
): { items: ResponseItem[], response_id: string } {
  const items: ResponseItem[] = [];
  
  // Process tool_use and text content in order
  if (response.content) {
    // First process tool_use items since they need to appear first
    for (const contentBlock of response.content) {
      if (contentBlock.type === "tool_use") {
        // Convert tool_use to function_call format that the agent expects
        const functionCallItem: ResponseItem = {
          id: contentBlock.id || `tool-${Date.now()}`,
          type: "function_call",
          name: contentBlock.name,
          call_id: contentBlock.id || `tool-${Date.now()}`,
          arguments: JSON.stringify(contentBlock.input),
        };
        
        // For shell commands, ensure the command format is compatible
        if (contentBlock.name === "shell" && contentBlock.input && typeof contentBlock.input === "object") {
          const input = contentBlock.input as Record<string, unknown>;
          if (input.command && typeof input.command === "string") {
            // Split command string into array format expected by the agent
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
        
        items.push(functionCallItem);
      }
    }
    
    // Then process text content for messages
    const textContents: {type: "output_text", text: string}[] = [];
    
    for (const contentBlock of response.content) {
      if (contentBlock.type === "text") {
        textContents.push({
          type: "output_text",
          text: contentBlock.text
        });
      }
    }
    
    // If we have text content, create a message
    if (textContents.length > 0) {
      const messageItem: ResponseItem = {
        id: `message-${Date.now()}`,
        type: "message",
        role: "assistant",
        content: textContents
      };
      items.push(messageItem);
    }
  }
  
  // CRITICAL FIX: Ensure we always have a message item
  // If there are no text contents but we have tool calls, it means Claude
  // has made tool calls without explaining them - this is fine
  
  // If there are no tool calls but we have a response, we need to ensure
  // there's a message - this could happen when Claude responds to a tool result
  if (items.length === 0 || !items.some(item => item.type === "message")) {
    // No items or no message item - create one with default text
    const defaultMessageItem: ResponseItem = {
      id: `message-${Date.now()}`,
      type: "message",
      role: "assistant",
      content: [{
        type: "output_text",
        text: response.stop_reason === "tool_use" 
          ? "I need to use a tool to help with this." 
          : "I've analyzed the results.",
      }]
    };
    
    // If there are no tool call items, add the message first
    // If there are tool call items but no message, add it after the tool calls
    if (!items.some(item => item.type === "function_call")) {
      items.unshift(defaultMessageItem);
    } else {
      items.push(defaultMessageItem);
    }
  }
  
  return { 
    items, 
    response_id: response.id || `resp-${Date.now()}`
  };
}

// -----------------------------------------------------------------------------
// ANTHROPIC CLIENT IMPLEMENTATION
// -----------------------------------------------------------------------------

/**
 * Anthropic Claude client implementation
 */
class AnthropicClient {
  private apiKey: string;
  private baseUrl: string;
  private defaultModel: string;
  private tokenCountCallbacks: Array<(inputTokens: number, outputTokens: number) => void> = [];
  
  constructor(apiKey: string, options?: { baseUrl?: string; defaultModel?: string }) {
    this.apiKey = apiKey;
    this.baseUrl = options?.baseUrl || "https://api.anthropic.com/v1";
    const defaultModel = options?.defaultModel || "claude-3-sonnet";
    this.defaultModel = normalizeModelName(defaultModel);
  }
  
  /**
   * Register a callback for token counting
   */
  onTokenCount(callback: (inputTokens: number, outputTokens: number) => void): void {
    this.tokenCountCallbacks.push(callback);
  }
  
  /**
   * Send messages to Anthropic Claude
   */
  async sendMessage(
    messages: AnthropicMessage[],
    options?: {
      model?: string;
      system?: string;
      maxTokens?: number;
      temperature?: number;
      tools?: AnthropicTool[];
      stream?: boolean;
      thinking?: { budgetTokens: number };
    }
  ): Promise<AnthropicResponse> {
    const model = options?.model || this.defaultModel;
    const normalizedModel = normalizeModelName(model);
    
    try {
      if (isLoggingEnabled()) {
        log(`Sending ${messages.length} messages to Anthropic API with model ${normalizedModel}`);
        if (options?.system) {
          log(`System prompt: ${options.system.substring(0, 50)}...`);
        }
      }
      
      // Estimate tokens for rate limiting
      const estimatedTokens = this.estimateTokenCount(messages, options?.system);
      
      // Call Anthropic API with rate limiting
      const response = await executeWithRateLimiting(
        'anthropic',
        async () => {
          // Prepare request payload
          const requestBody: Record<string, any> = {
            model: normalizedModel,
            messages,
            max_tokens: options?.maxTokens || 4096,
            temperature: options?.temperature || 0.7,
          };
          
          // Add system instruction if provided
          if (options?.system) {
            requestBody.system = options.system;
          }
          
          // Add thinking parameter for Claude 3.7 models
          if (model.includes('claude-3-7') || model.includes('claude-3.7')) {
            if (options?.thinking) {
              requestBody.thinking = { 
                type: "enabled",
                budget_tokens: options.thinking.budgetTokens 
              };
              // Claude 3.7 requires temperature=1 when thinking is enabled
              requestBody.temperature = 1.0;
            } else {
              requestBody.thinking = { 
                type: "enabled",
                budget_tokens: 3000 // Default token budget
              };
              requestBody.temperature = 1.0;
            }
          }
          
          // Add tools if provided
          if (options?.tools && options.tools.length > 0) {
            requestBody.tools = options.tools;
            // When tools are provided, set tool_choice to auto by default
            requestBody.tool_choice = { type: "auto" };
          } else {
            // Define the shell tool by default
            requestBody.tools = [this.getShellTool()];
            requestBody.tool_choice = { type: "auto" };
          }
          
          // Set streaming if requested
          requestBody.stream = !!options?.stream;
          
          if (isLoggingEnabled()) {
            log(`Anthropic API request: ${JSON.stringify({
              ...requestBody,
              messages: `[${messages.length} messages]` // Don't log full messages
            })}`);
          }
          
          // Make the API call
          const response = await fetch(`${this.baseUrl}/messages`, {
            method: "POST",
            headers: {
              "x-api-key": this.apiKey,
              "anthropic-version": "2023-06-01",
              "content-type": "application/json",
            },
            body: JSON.stringify(requestBody),
          });
          
          if (!response.ok) {
            // Handle error response
            const errorText = await response.text();
            let errorObj: Record<string, unknown> = {};
            
            try {
              errorObj = JSON.parse(errorText);
            } catch {
              // If parsing fails, use the raw error text
              errorObj = { message: errorText };
            }
            
            errorObj.status = response.status;
            
            // Check for rate limit headers
            const retryAfter = response.headers.get('retry-after');
            if (retryAfter) {
              errorObj.retry_after = retryAfter;
            }
            
            // Enhance error with headers for debugging
            errorObj.headers = {};
            response.headers.forEach((value, key) => {
              errorObj.headers[key] = value;
            });
            
            // Normalize rate limit error types
            if (response.status === 429 || 
                (errorObj.error && typeof errorObj.error === 'object' && 
                 'type' in errorObj.error && errorObj.error.type === 'rate_limit_error') ||
                (errorObj.error && typeof errorObj.error === 'object' && 
                 'message' in errorObj.error && typeof errorObj.error.message === 'string' && 
                 errorObj.error.message.includes('rate limit'))) {
              errorObj.type = 'rate_limit_error';
            }
            
            // Extract error message
            let errorMsg = '';
            if (errorObj.error && typeof errorObj.error === 'object' && 'message' in errorObj.error) {
              errorMsg = String(errorObj.error.message);
            } else if ('message' in errorObj) {
              errorMsg = String(errorObj.message);
            } else {
              errorMsg = errorText;
            }
            
            const error = new Error(`Anthropic API Error (${response.status}): ${errorMsg}`);
            (error as any).details = errorObj;
            throw error;
          }
          
          // Parse the response
          const anthropicResponse = await response.json() as AnthropicResponse;
          
          // Track token usage
          if (anthropicResponse.usage) {
            const { input_tokens, output_tokens } = anthropicResponse.usage;
            this.tokenCountCallbacks.forEach(callback => {
              callback(input_tokens, output_tokens);
            });
            
            if (isLoggingEnabled()) {
              log(`Anthropic API token usage - input: ${input_tokens}, output: ${output_tokens}`);
            }
          }
          
          return anthropicResponse;
        },
        {
          estimatedTokens,
          timeoutMs: 120000, // 120 second timeout
          onRateLimitEncountered: (delayMs, attempt) => {
            log(`Anthropic rate limit encountered: waiting ${Math.round(delayMs / 1000)}s before attempt ${attempt}`);
            
            if (attempt > 0) {
              throw new Error(`⏳ Rate limit reached. Automatically retrying in ${Math.round(delayMs / 1000)} seconds... (Attempt ${attempt})`);
            }
          },
          onFinalFailure: (error) => {
            log(`Anthropic API error after all retries: ${JSON.stringify(error)}`);
            
            if (isRateLimitError(error)) {
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
              const errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
              throw new Error(`⚠️ Anthropic API Error: ${errorMessage}`);
            }
          }
        }
      );
      
      return response;
    } catch (error) {
      log(`Error calling Anthropic API: ${error instanceof Error ? error.message : JSON.stringify(error)}`);
      
      // Enhanced error handling for specific error types
      const errorObj = error as Record<string, any>;
      const details = errorObj.details || errorObj;
      
      // Handle content policy violations
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
      
      // Preserve the original error
      throw error;
    }
  }
  
  /**
   * Stream messages to Anthropic Claude and yield incremental responses
   */
  async *streamMessage(
    messages: AnthropicMessage[],
    options?: {
      model?: string;
      system?: string;
      maxTokens?: number;
      temperature?: number;
      tools?: AnthropicTool[];
      thinking?: { budgetTokens: number };
    }
  ): AsyncGenerator<AnthropicResponse> {
    const model = options?.model || this.defaultModel;
    const normalizedModel = normalizeModelName(model);
    
    try {
      if (isLoggingEnabled()) {
        log(`Streaming ${messages.length} messages to Anthropic API with model ${normalizedModel}`);
      }
      
      // Estimate tokens for rate limiting
      const estimatedTokens = this.estimateTokenCount(messages, options?.system);
      
      // Call Anthropic API with rate limiting
      const response = await executeWithRateLimiting(
        'anthropic',
        async () => {
          // Prepare request payload
          const requestBody: Record<string, any> = {
            model: normalizedModel,
            messages,
            max_tokens: options?.maxTokens || 4096,
            temperature: options?.temperature || 0.7,
            stream: true, // Always stream for this method
          };
          
          // Add system instruction if provided
          if (options?.system) {
            requestBody.system = options.system;
          }
          
          // Add thinking parameter for Claude 3.7 models
          if (model.includes('claude-3-7') || model.includes('claude-3.7')) {
            if (options?.thinking) {
              requestBody.thinking = { 
                type: "enabled",
                budget_tokens: options.thinking.budgetTokens 
              };
              // Claude 3.7 requires temperature=1 when thinking is enabled
              requestBody.temperature = 1.0;
            } else {
              requestBody.thinking = { 
                type: "enabled",
                budget_tokens: 3000 // Default token budget
              };
              requestBody.temperature = 1.0;
            }
          }
          
          // Add tools if provided
          if (options?.tools && options.tools.length > 0) {
            requestBody.tools = options.tools;
            requestBody.tool_choice = { type: "auto" };
          } else {
            // Define the shell tool by default
            requestBody.tools = [this.getShellTool()];
            requestBody.tool_choice = { type: "auto" };
          }
          
          if (isLoggingEnabled()) {
            log(`Anthropic API stream request: ${JSON.stringify({
              ...requestBody,
              messages: `[${messages.length} messages]` // Don't log full messages
            })}`);
          }
          
          // Make the API call
          const response = await fetch(`${this.baseUrl}/messages`, {
            method: "POST",
            headers: {
              "x-api-key": this.apiKey,
              "anthropic-version": "2023-06-01",
              "content-type": "application/json",
            },
            body: JSON.stringify(requestBody),
          });
          
          if (!response.ok) {
            // Handle error response - same as in sendMessage
            const errorText = await response.text();
            let errorObj: Record<string, unknown> = {};
            
            try {
              errorObj = JSON.parse(errorText);
            } catch {
              errorObj = { message: errorText };
            }
            
            errorObj.status = response.status;
            
            const retryAfter = response.headers.get('retry-after');
            if (retryAfter) {
              errorObj.retry_after = retryAfter;
            }
            
            errorObj.headers = {};
            response.headers.forEach((value, key) => {
              errorObj.headers[key] = value;
            });
            
            if (response.status === 429 || 
                (errorObj.error && typeof errorObj.error === 'object' && 
                 'type' in errorObj.error && errorObj.error.type === 'rate_limit_error') ||
                (errorObj.error && typeof errorObj.error === 'object' && 
                 'message' in errorObj.error && typeof errorObj.error.message === 'string' && 
                 errorObj.error.message.includes('rate limit'))) {
              errorObj.type = 'rate_limit_error';
            }
            
            let errorMsg = '';
            if (errorObj.error && typeof errorObj.error === 'object' && 'message' in errorObj.error) {
              errorMsg = String(errorObj.error.message);
            } else if ('message' in errorObj) {
              errorMsg = String(errorObj.message);
            } else {
              errorMsg = errorText;
            }
            
            const error = new Error(`Anthropic API Error (${response.status}): ${errorMsg}`);
            (error as any).details = errorObj;
            throw error;
          }
          
          // Get the reader for streaming
          const reader = response.body?.getReader();
          if (!reader) {
            throw new Error("Failed to create reader from response");
          }
          
          const decoder = new TextDecoder();
          let buffer = "";
          let totalInputTokens = 0;
          let totalOutputTokens = 0;
          
          return {
            reader,
            decoder,
            buffer,
            totalInputTokens,
            totalOutputTokens
          };
        },
        {
          estimatedTokens,
          timeoutMs: 120000, // 120 second timeout
          onRateLimitEncountered: (delayMs, attempt) => {
            log(`Anthropic rate limit encountered: waiting ${Math.round(delayMs / 1000)}s before attempt ${attempt}`);
            
            if (attempt > 0) {
              throw new Error(`⏳ Rate limit reached. Automatically retrying in ${Math.round(delayMs / 1000)} seconds... (Attempt ${attempt})`);
            }
          },
          onFinalFailure: (error) => {
            log(`Anthropic API error after all retries: ${JSON.stringify(error)}`);
            
            if (isRateLimitError(error)) {
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
              const errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
              throw new Error(`⚠️ Anthropic API Error: ${errorMessage}`);
            }
          }
        }
      );
      
      // Process the stream
      const { reader, decoder, buffer } = response;
      let currentBuffer = buffer;
      
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          
          currentBuffer += decoder.decode(value, { stream: true });
          
          // Process events in the buffer
          const lines = currentBuffer.split('\n\n');
          currentBuffer = lines.pop() || ""; // Keep the last incomplete line
          
          for (const line of lines) {
            if (!line.trim() || line.trim() === "data: [DONE]") continue;
            
            const dataMatch = line.match(/^data: (.+)$/m);
            if (!dataMatch) continue;
            
            try {
              const data = JSON.parse(dataMatch[1]);
              
              // Yield each parsed data chunk
              if (data.type === "message_start") {
                // First chunk of a message (response header)
                yield {
                  id: data.message.id,
                  model: data.message.model,
                  role: "assistant",
                  content: [],
                  stop_reason: null,
                  type: "message_start",
                  usage: data.message.usage ? {
                    input_tokens: data.message.usage.input_tokens || 0,
                    output_tokens: 0 // Start with 0 output tokens
                  } : undefined
                };
                
                // Track token usage
                if (data.message.usage) {
                  this.tokenCountCallbacks.forEach(callback => {
                    callback(data.message.usage.input_tokens || 0, 0);
                  });
                }
              } 
              else if (data.type === "content_block_start" || data.type === "content_block_delta") {
                // Text content blocks
                if (data.content_block?.type === "text" && data.content_block?.text) {
                  yield {
                    id: data.message_id,
                    model: normalizedModel,
                    role: "assistant",
                    content: [{ type: "text", text: data.content_block.text }],
                    type: "content_block"
                  };
                } 
                else if (data.delta?.type === "text_delta" && data.delta?.text) {
                  yield {
                    id: data.message_id,
                    model: normalizedModel,
                    role: "assistant",
                    content: [{ type: "text", text: data.delta.text }],
                    type: "content_delta"
                  };
                }
              } 
              else if (data.type === "tool_use") {
                // Tool use
                yield {
                  id: data.message_id,
                  model: normalizedModel,
                  role: "assistant",
                  content: [{
                    type: "tool_use",
                    id: data.tool_use.id,
                    name: data.tool_use.name,
                    input: data.tool_use.input
                  }],
                  stop_reason: "tool_use",
                  type: "tool_use"
                };
              } 
              else if (data.type === "message_delta") {
                // Usage updates in delta events
                if (data.usage_delta) {
                  const outputTokens = data.usage_delta.output_tokens || 0;
                  if (outputTokens > 0) {
                    this.tokenCountCallbacks.forEach(callback => {
                      callback(0, outputTokens);
                    });
                  }
                }
              } 
              else if (data.type === "message_stop") {
                // End of message
                yield {
                  id: data.message_id,
                  model: normalizedModel,
                  role: "assistant",
                  content: [],
                  stop_reason: data.stop_reason || "end_turn",
                  type: "message_stop",
                  usage: data.usage ? {
                    input_tokens: data.usage.input_tokens || 0,
                    output_tokens: data.usage.output_tokens || 0
                  } : undefined
                };
                
                // Final token usage
                if (data.usage) {
                  const { input_tokens, output_tokens } = data.usage;
                  // Only report the total once at the end to avoid double counting from deltas
                  this.tokenCountCallbacks.forEach(callback => {
                    callback(input_tokens, output_tokens);
                  });
                  
                  if (isLoggingEnabled()) {
                    log(`Anthropic API final token usage - input: ${input_tokens}, output: ${output_tokens}`);
                  }
                }
              }
            } catch (e) {
              if (isLoggingEnabled()) {
                log(`Error parsing SSE event: ${e instanceof Error ? e.message : String(e)}`);
              }
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    } catch (error) {
      log(`Error streaming from Anthropic API: ${error instanceof Error ? error.message : JSON.stringify(error)}`);
      throw error;
    }
  }
  
  /**
   * Estimate token count for Anthropic models
   */
  private estimateTokenCount(
    messages: AnthropicMessage[], 
    systemPrompt?: string
  ): number {
    // Constants for Claude token estimation
    const AVG_CHARS_PER_TOKEN = 4;
    const MESSAGE_OVERHEAD_TOKENS = 4;
    
    let totalTokens = 0;
    
    // Count system prompt tokens
    if (systemPrompt) {
      totalTokens += Math.ceil(systemPrompt.length / AVG_CHARS_PER_TOKEN) + 10;
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
          const base64Data = content.source?.data || '';
          const imageBytes = base64Data.length * 0.75;
          // Very rough approximation for images
          totalTokens += Math.max(85, Math.ceil(imageBytes / 5000));
        } else if (content.type === 'tool_result') {
          // Tool results can be complex, add overhead
          if (typeof content.content === 'string') {
            totalTokens += Math.ceil(content.content.length / AVG_CHARS_PER_TOKEN) + 5;
          } else if (Array.isArray(content.content)) {
            totalTokens += 10; // Base overhead for array
            // Rough estimate for nested content
            for (const item of content.content) {
              if ('text' in item && typeof item.text === 'string') {
                totalTokens += Math.ceil(item.text.length / AVG_CHARS_PER_TOKEN);
              }
            }
          }
        }
      }
    }
    
    // Additional overhead for tool definitions - rough estimate
    totalTokens += 200;
    
    return totalTokens;
  }
  
  /**
   * Get the default shell tool definition for Codex CLI
   */
  getShellTool(): AnthropicTool {
    return {
      name: "shell",
      description: "Runs a shell command, and returns its output. IMPORTANT: You must ALWAYS use this tool for ALL file system operations, finding files, and executing code.",
      input_schema: {
        type: "object",
        properties: {
          command: {
            type: "string", 
            description: "The command to execute as a string. Will be split into command and arguments."
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
    };
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

// -----------------------------------------------------------------------------
// ANTHROPIC PROVIDER IMPLEMENTATION
// -----------------------------------------------------------------------------

/**
 * Implementation for Anthropic provider that meets the ModelProviderInterface
 * 
 * This is a stateful provider that maintains conversation history, since
 * Anthropic does not maintain history on their side (unlike OpenAI).
 * 
 * Anthropic tool use flow is handled in multiple steps:
 * 1. Send user message to Claude
 * 2. Claude returns with stop_reason="tool_use" when it wants to use a tool
 * 3. We add the tool_use response to conversation history
 * 4. The agent handles the tool call and returns the results
 * 5. We convert the tool results to Anthropic's format (tool_result blocks in a user message)
 * 6. We send the conversation history + tool results back to Claude
 * 7. Claude provides its final response
 * 8. We add Claude's final response to the conversation history
 * 
 * This flow ensures that Claude has the context of the entire conversation
 * including both tool requests and their results.
 */
class AnthropicProvider implements ModelProviderInterface {
  public provider = ModelProvider.ANTHROPIC;
  private client: AnthropicClient;
  private model: string;
  private options: ProviderOptions;
  
  // Conversation state management - critical for Anthropic
  private conversationHistory: AnthropicMessage[] = [];
  private sessionId: string;
  private lastResponseId: string = "";
  private currentTokensInput: number = 0; 
  private currentTokensOutput: number = 0;
  
  // CRITICAL: Track pending tool use IDs that need tool_result responses
  private pendingToolUseIds: string[] = [];
  
  constructor(options: ProviderOptions) {
    this.model = options.model;
    this.options = options;
    this.sessionId = `session_${Date.now()}`;
    
    // Initialize client
    this.client = createAnthropicClient(this.options.apiKey, {
      baseUrl: this.options.baseUrl,
      defaultModel: this.options.model
    });
    
    // Register token tracking callback
    this.client.onTokenCount((inputTokens, outputTokens) => {
      this.currentTokensInput += inputTokens;
      this.currentTokensOutput += outputTokens;
      
      if (isLoggingEnabled()) {
        log(`Anthropic token usage updated: input=${this.currentTokensInput}, output=${this.currentTokensOutput}`);
      }
    });
  }
  
  /**
   * Get total token count for current conversation
   */
  getTokenCount(): { input: number; output: number; total: number } {
    return {
      input: this.currentTokensInput,
      output: this.currentTokensOutput,
      total: this.currentTokensInput + this.currentTokensOutput
    };
  }
  
  /**
   * Reset token count (useful for new conversations)
   */
  resetTokenCount(): void {
    this.currentTokensInput = 0;
    this.currentTokensOutput = 0;
    if (isLoggingEnabled()) {
      log("Reset Anthropic token counters to zero");
    }
  }
  
  /**
   * Debug helper to print conversation state
   */
  private debugConversationState(): void {
    if (!isLoggingEnabled()) return;
    
    log("\n======== ANTHROPIC CONVERSATION STATE ========");
    log(`Session ID: ${this.sessionId}`);
    log(`Last Response ID: ${this.lastResponseId}`);
    log(`History length: ${this.conversationHistory.length} messages`);
    log(`Token usage: ${this.currentTokensInput} input, ${this.currentTokensOutput} output`);
    
    if (this.conversationHistory.length > 0) {
      log("Conversation flow (abbreviated):");
      this.conversationHistory.forEach((msg, idx) => {
        let contentPreview = "";
        if (msg.content.length > 0) {
          const firstItem = msg.content[0];
          if (firstItem.type === "text") {
            contentPreview = firstItem.text.substring(0, 25) + "...";
          } else {
            contentPreview = `[${firstItem.type}]`;
          }
        }
        log(`  ${idx+1}. [${msg.role}] "${contentPreview}"`);
      });
    }
    log("============================================\n");
  }
  
  /**
   * Check if a response requires additional tool processing
   * Used to determine if the agent loop should continue with tool results
   * @param response The response to check
   * @returns true if the response contains function calls
   */
  public requiresToolProcessing(response: {
    items: Array<ResponseItem>;
    response_id: string;
  }): boolean {
    const hasFunctionCalls = response.items.some(item => item.type === "function_call");
    
    if (isLoggingEnabled() && hasFunctionCalls) {
      log(`Anthropic provider detected tool use request that needs processing`);
    }
    
    return hasFunctionCalls;
  }

  /**
   * Send a message to Anthropic API
   * This is the main method implementing the ModelProviderInterface
   */
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
      // Maintain internal state for conversation tracking
      if (options.conversationId) {
        this.sessionId = options.conversationId;
      }
      
      if (options.previousResponseId) {
        this.lastResponseId = options.previousResponseId;
      }
      
      if (isLoggingEnabled()) {
        log(`\n============= NEW ANTHROPIC REQUEST =============`);
        log(`Model: ${this.model}`);
        log(`Input size: ${input.length} items`);
        log(`System prompt: ${options.system ? `${options.system.length} chars` : "none"}`);
        this.debugConversationState();
      }
      
      // Check if the input contains function_call_output items from tools
      // These indicate we need to send tool results back to Claude
      const toolResults = input.filter(item => 
        item.type === "function_call_output" && "call_id" in item
      );
      
      // Are we sending tool results back to Claude?
      const isToolResultResponse = toolResults.length > 0;
      
      if (isLoggingEnabled() && isToolResultResponse) {
        log(`Found ${toolResults.length} tool results to send back to Claude`);
        toolResults.forEach(result => {
          log(`- Tool result for ID: ${(result as any).call_id}`);
        });
      }
      
      // Convert input to Anthropic message format
      const convertedMessages = convertOpenAIToAnthropicMessages(input);
      
      // CRITICAL FIX: This is the core issue - we need a different approach
      // to handle the conversation history, especially with tool results
      
      if (!isToolResultResponse) {
        // CRITICAL FIX: Check if there are any pending tool use IDs that need responses
        // If so, we need to create dummy tool_result responses for them
        if (this.pendingToolUseIds.length > 0) {
          if (isLoggingEnabled()) {
            log(`WARNING: Found ${this.pendingToolUseIds.length} pending tool_use IDs that need responses: ${this.pendingToolUseIds.join(', ')}`);
            log(`Creating dummy tool_result responses for them before processing new user message`);
          }
          
          // Create a user message with tool_result blocks for each pending tool use ID
          const dummyToolResults: AnthropicContent[] = this.pendingToolUseIds.map(id => ({
            type: "tool_result",
            tool_use_id: id,
            content: "The tool execution was interrupted. Please try again.",
            is_error: true
          }));
          
          // Add the dummy tool results as a user message to the conversation history
          if (dummyToolResults.length > 0) {
            const dummyMessage: AnthropicMessage = {
              role: "user",
              content: dummyToolResults
            };
            
            this.conversationHistory.push(dummyMessage);
            
            if (isLoggingEnabled()) {
              log(`Added dummy user message with ${dummyToolResults.length} tool_result blocks to conversation history`);
            }
            
            // Clear the pending tool use IDs since we've created responses for them
            this.pendingToolUseIds = [];
          }
        }
        
        // Normal case - new user message, add it to history
        // Add all user messages to history
        for (const msg of convertedMessages) {
          this.conversationHistory.push(msg);
          
          if (isLoggingEnabled()) {
            log(`Added ${msg.role} message to conversation history`);
          }
        }
      } else {
        // We're sending tool results back to Claude
        // According to Anthropic's API, tool_result must immediately follow the
        // corresponding tool_use in the conversation history
        
        if (isLoggingEnabled()) {
          log(`Processing tool results, checking for matching tool_use messages`);
        }
        
        // Find tool_use_ids from incoming tool results
        const toolUseIds = toolResults.map(item => (item as any).call_id);
        
        if (isLoggingEnabled()) {
          log(`Found tool_use_ids to match: ${toolUseIds.join(', ')}`);
          log(`Current pending tool use IDs: ${this.pendingToolUseIds.join(', ')}`);
        }
        
        // Remove these IDs from the pending list since we're processing them now
        this.pendingToolUseIds = this.pendingToolUseIds.filter(id => !toolUseIds.includes(id));
        
        if (isLoggingEnabled()) {
          log(`Remaining pending tool use IDs after processing: ${this.pendingToolUseIds.join(', ')}`);
        }
        
        // We need to make sure the last message in history is the assistant's tool_use
        // Then we need to add the tool_result as the next message
        if (this.conversationHistory.length > 0) {
          const lastMessage = this.conversationHistory[this.conversationHistory.length - 1];
          
          // Verify the last message contains the matching tool_use blocks
          if (lastMessage.role === 'assistant') {
            const containsMatchingToolUse = lastMessage.content.some(content => {
              if (content.type === 'tool_use') {
                return toolUseIds.includes((content as any).id);
              }
              return false;
            });
            
            if (containsMatchingToolUse) {
              if (isLoggingEnabled()) {
                log(`Last message in history contains matching tool_use, adding tool_result`);
              }
              
              // Important: Get only the last user message from convertedMessages
              // which should contain all tool_result blocks
              if (convertedMessages.length > 0) {
                // Find the message with tool_result content
                const toolResultMessage = convertedMessages.find(msg => 
                  msg.role === 'user' && 
                  msg.content.some(content => content.type === 'tool_result')
                );
                
                if (toolResultMessage) {
                  // Add this message next in the conversation history
                  this.conversationHistory.push(toolResultMessage);
                  
                  if (isLoggingEnabled()) {
                    const toolResultContents = toolResultMessage.content.filter(c => c.type === 'tool_result');
                    log(`Added user message with ${toolResultContents.length} tool_result blocks to conversation history`);
                  }
                } else {
                  log(`WARNING: No tool_result message found in converted messages`);
                }
              }
            } else {
              log(`WARNING: Last message in history doesn't contain matching tool_use blocks!`);
              
              // Fallback approach: Add all user messages anyway
              for (const msg of convertedMessages) {
                if (msg.role === 'user') {
                  this.conversationHistory.push(msg);
                  
                  if (isLoggingEnabled()) {
                    log(`Added ${msg.role} message to conversation history (fallback)`);
                  }
                }
              }
            }
          } else {
            log(`WARNING: Last message in history is not from assistant, it's ${lastMessage.role}`);
            
            // Edge case: If the last message isn't from the assistant, something might be wrong
            // Add the user message anyway
            for (const msg of convertedMessages) {
              if (msg.role === 'user') {
                this.conversationHistory.push(msg);
                
                if (isLoggingEnabled()) {
                  log(`Added ${msg.role} message to conversation history (fallback)`);
                }
              }
            }
          }
        } else {
          log(`WARNING: Conversation history is empty, but receiving tool results`);
          
          // Just add the user message with tool results
          for (const msg of convertedMessages) {
            if (msg.role === 'user') {
              this.conversationHistory.push(msg);
              
              if (isLoggingEnabled()) {
                log(`Added ${msg.role} message to conversation history (empty history case)`);
              }
            }
          }
        }
      }
      
      // Trim history if necessary to avoid context limits
      const MAX_HISTORY = 20;
      if (this.conversationHistory.length > MAX_HISTORY) {
        const excessMessages = this.conversationHistory.length - MAX_HISTORY;
        this.conversationHistory = this.conversationHistory.slice(excessMessages);
        
        if (isLoggingEnabled()) {
          log(`Trimmed ${excessMessages} old messages from history to stay under context limit`);
        }
      }
      
      if (isLoggingEnabled()) {
        log(`Sending request with ${this.conversationHistory.length} message history items`);
        this.debugConversationState();
      }
      
      // Force temperature to 1.0 for thinking-enabled models (Claude requirement)
      const temperature = options.thinking ? 1.0 : (options.temperature || 0.7);
      
      // Call Anthropic with our maintained conversation history
      const response = await this.client.sendMessage(
        this.conversationHistory,
        {
          model: this.model,
          system: options.system,
          temperature: temperature,
          thinking: options.thinking,
          maxTokens: 4096, // Default max tokens
        }
      );
      
      // Store response ID
      this.lastResponseId = response.id;
      
      if (isLoggingEnabled()) {
        log(`Received response from Anthropic API with stop_reason: ${response.stop_reason}`);
        if (response.content) {
          const contentTypes = response.content.map(c => c.type).join(', ');
          log(`Response content types: ${contentTypes}`);
        }
      }
      
      // Check if Claude is requesting to use a tool
      if (response.stop_reason === "tool_use" && response.content) {
        // Find tool_use content blocks
        const toolUseBlocks = response.content.filter(
          content => content.type === "tool_use"
        ) as Array<{type: "tool_use"; id: string; name: string; input: Record<string, unknown>}>;
        
        if (toolUseBlocks.length > 0) {
          // CRITICAL: Add Claude's response with the tool_use request to our history
          // This ensures tool_use blocks are added to history immediately so they can
          // be matched with tool_result blocks in the next message
          this.conversationHistory.push({
            role: "assistant",
            content: response.content
          });
          
          // CRITICAL FIX: Track pending tool use IDs that need tool_result responses
          // This is essential for handling the case when the loop is interrupted
          const newToolUseIds = toolUseBlocks.map(block => block.id);
          this.pendingToolUseIds.push(...newToolUseIds);
          
          if (isLoggingEnabled()) {
            log(`Added Claude's tool_use request to conversation history`);
            log(`Claude requested ${toolUseBlocks.length} tools: ${toolUseBlocks.map(t => t.name).join(', ')}`);
            log(`Added ${newToolUseIds.length} new pending tool use IDs: ${newToolUseIds.join(', ')}`);
            log(`Total pending tool use IDs: ${this.pendingToolUseIds.length}`);
          }
          
          // Convert the response to OpenAI format for tool calls
          const convertedResponse = convertAnthropicToOpenAIResponse(response);
          
          if (isLoggingEnabled()) {
            log(`Conversion complete - extracted ${convertedResponse.items.length} items for agent`);
            log(`============= END ANTHROPIC REQUEST =============\n`);
          }
          
          return convertedResponse;
        }
      } 
      
      // This is a final message (not a tool_use) or response to a tool result,
      // add it to conversation history
      if (response.content && response.content.length > 0) {
        this.conversationHistory.push({
          role: "assistant",
          content: response.content
        });
        
        if (isLoggingEnabled()) {
          log(`Added assistant final response to conversation history`);
        }
      }
      
      // CRITICAL FIX: If this was a tool result -> final response, ensure we create a proper message response
      // Check if this was a response to tool results
      if (isToolResultResponse && response.content) {
        // Find text content blocks
        const textBlocks = response.content.filter(
          content => content.type === "text"
        ) as Array<{type: "text"; text: string}>;
        
        // Ensure there's at least one text block
        if (textBlocks.length === 0 && response.content.length > 0) {
          if (isLoggingEnabled()) {
            log(`No text blocks found in response to tool results, adding a fallback message`);
          }
          
          // Add a fallback block to ensure we have a message response
          response.content.push({
            type: "text",
            text: "I've processed the results of the command."
          });
        }
      }
      
      // Convert response to OpenAI format for the agent
      const convertedResponse = convertAnthropicToOpenAIResponse(response);
      
      if (isLoggingEnabled()) {
        log(`Conversion complete - extracted ${convertedResponse.items.length} items for agent`);
        log(`============= END ANTHROPIC REQUEST =============\n`);
      }
      
      return convertedResponse;
    } catch (error) {
      log(`Error in Anthropic provider: ${error instanceof Error ? error.message : String(error)}`);
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