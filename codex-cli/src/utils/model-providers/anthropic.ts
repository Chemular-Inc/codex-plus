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
interface AnthropicMessage {
  role: "user" | "assistant" | "system";
  content: AnthropicContent[];
}

type AnthropicContent = 
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

interface AnthropicToolResult {
  tool_use_id: string;
  output: string | Record<string, unknown>;
}

// Mapping function between OpenAI and Anthropic formats
function mapOpenAIInputToAnthropic(
  input: Array<ResponseInputItem>
): { messages: Array<AnthropicMessage>; toolResults: Array<AnthropicToolResult> } {
  const messages: Array<AnthropicMessage> = [];
  const toolResults: Array<AnthropicToolResult> = [];
  
  if (isLoggingEnabled()) {
    log(`Converting ${input.length} messages to Anthropic format`);
  }
  
  // First pass - collect all messages, including the last assistant message
  // This is critical since we need the entire conversation history
  for (const item of input) {
    if (item.type === "message") {
      const message: AnthropicMessage = {
        role: item.role as "user" | "assistant" | "system",
        content: [],
      };
      
      // Log message details for debugging
      if (isLoggingEnabled()) {
        log(`Processing message - role: ${item.role}, content items: ${item.content.length}`);
      }
      
      // Safely process each content item
      for (const contentItem of item.content) {
        if (contentItem.type === "input_text" || contentItem.type === "output_text") {
          message.content.push({ 
            type: "text", 
            text: contentItem.text 
          });
          
          if (isLoggingEnabled()) {
            // Log truncated content for debugging
            const previewText = contentItem.text.length > 50 
              ? contentItem.text.substring(0, 50) + "..." 
              : contentItem.text;
            log(`Added text content: "${previewText}"`);
          }
        } else if (contentItem.type === "input_image" && "image_url" in contentItem) {
          // Convert to base64 if needed
          message.content.push({
            type: "image",
            source: {
              type: "base64",
              media_type: "image/jpeg", // Assuming JPEG as default
              data: contentItem.image_url.replace(/^data:image\/[^;]+;base64,/, ""),
            },
          });
          
          if (isLoggingEnabled()) {
            log(`Added image content`);
          }
        }
        // Skip other content types not supported by Anthropic
      }
      
      if (message.content.length > 0) {
        messages.push(message);
        
        if (isLoggingEnabled()) {
          log(`Added message with role: ${message.role}, content items: ${message.content.length}`);
        }
      }
    } else if (item.type === "function_call_output" && "call_id" in item) {
      // Convert function outputs to tool results
      toolResults.push({
        tool_use_id: item.call_id,
        output: item.output,
      });
      
      if (isLoggingEnabled()) {
        log(`Added tool result for call_id: ${item.call_id}`);
      }
    }
  }
  
  if (isLoggingEnabled()) {
    log(`Mapped to ${messages.length} messages and ${toolResults.length} tool results`);
    
    // Show the conversation flow for debugging
    let conversationPreview = "Conversation flow: ";
    for (const msg of messages) {
      conversationPreview += `[${msg.role}] → `;
    }
    conversationPreview += "[end]";
    log(conversationPreview);
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
      // Create function call item with proper typing
      const functionCallItem: ResponseItem = {
        id: toolUse.id || `tool-${Date.now()}`,
        type: "function_call",
        name: toolUse.name,
        call_id: toolUse.id || `tool-${Date.now()}`,
        arguments: JSON.stringify(toolUse.input),
      };
      
      // For shell commands, make sure the argument format is compatible
      if (toolUse.name === "shell" && toolUse.input && typeof toolUse.input === "object") {
        const input = toolUse.input as Record<string, unknown>;
        if (input.command && typeof input.command === "string") {
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
  if (anthropicResponse.content && anthropicResponse.content.length > 0) {
    // Create properly typed content array for the message
    const content: Array<{ type: string; text: string }> = [];
    
    for (const contentBlock of anthropicResponse.content) {
      if (contentBlock.type === "text" && contentBlock.text) {
        content.push({
          type: "output_text",
          text: contentBlock.text,
        });
      }
    }
    
    if (content.length > 0) {
      const messageItem: ResponseItem = {
        id: `${conversationId}-message`,
        type: "message",
        role: "assistant",
        content,
      };
      
      responseItems.push(messageItem);
    }
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
      thinking?: { budgetTokens: number };
      stream?: boolean;
    }
  ): Promise<AsyncIterable<any>> {
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
            thinking?: { 
              type: "enabled" | "disabled";
              budget_tokens?: number;
            };
            stream?: boolean;
          }
          
          const requestBody: AnthropicRequestBody = {
            model,
            messages,
            max_tokens: options?.maxTokens || 4096,
            temperature: options?.temperature || 0.7,
          };
          
          // Add thinking parameter for Claude 3.7+ models
          if (model.includes('claude-3-7') || model.includes('claude-3.7')) {
            if (options?.thinking) {
              requestBody.thinking = { 
                type: "enabled",
                budget_tokens: options.thinking.budgetTokens 
              };
              // When thinking is enabled, temperature MUST be set to 1
              requestBody.temperature = 1;
            } else {
              requestBody.thinking = { 
                type: "enabled",
                budget_tokens: 3000 // Default token budget
              };
              // When thinking is enabled, temperature MUST be set to 1
              requestBody.temperature = 1;
            }
          }
          
          // Add system instruction if provided
          if (options?.system) {
            // Enhance system prompt for Claude to encourage tool usage
            // Keep it similar to what OpenAI would receive, just with guidance on using tools
            const toolUsageInstructions = `
IMPORTANT: You have access to a shell tool. Use it when needed to:
- List directories and explore files (ls)
- Search for code or files (grep, find)
- Run commands to accomplish tasks
- Execute code or tests

First use the shell tool to gather information before responding substantively.
`;
            requestBody.system = `${options.system}\n\n${toolUsageInstructions}`;
          }
          
          // IMPORTANT: Define tools to match OpenAI's implementation exactly
          // With Anthropic-specific format but identical functionality
          requestBody.tools = [
            {
              name: "shell",
              description: "Runs a shell command, and returns its output.",
              input_schema: {
                type: "object",
                properties: {
                  command: {
                    // OpenAI uses array format, but we need to document it differently for Anthropic
                    // The mapping function will convert string to array format when needed
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
            }
          ];
          
          // Set tool_choice to match OpenAI's expected behavior
          // For Anthropic, we need to explicitly set this as an object
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
          
          // Always stream
          requestBody.stream = true;
          
          // Make the API call with better error handling
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
            // Get error details
            const errorText = await response.text();
            let errorObj: Record<string, unknown> = {};
            
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
            
            // Normalize error types for consistent handling
            if (response.status === 429 || 
                (errorObj.error && typeof errorObj.error === 'object' && 
                 'type' in errorObj.error && errorObj.error.type === 'rate_limit_error') ||
                (errorObj.error && typeof errorObj.error === 'object' && 
                 'message' in errorObj.error && typeof errorObj.error.message === 'string' && 
                 errorObj.error.message.includes('rate limit'))) {
              errorObj.type = 'rate_limit_error';
            }
            
            // Create a proper error with the detailed message
            let errorMsg = '';
            if (errorObj.error && typeof errorObj.error === 'object' && 'message' in errorObj.error) {
              errorMsg = String(errorObj.error.message);
            } else if ('message' in errorObj) {
              errorMsg = String(errorObj.message);
            } else {
              errorMsg = errorText;
            }
            
            const error = new Error(`Anthropic API Error (${response.status}): ${errorMsg}`);
            
            // Attach the original error details for debugging
            (error as any).details = errorObj;
            
            // Throw the error with its original message and status
            throw error;
          }
          
          // Create an abort controller for the stream
          const controller = new AbortController();
          
          // Get the reader
          const reader = response.body?.getReader();
          if (!reader) {
            throw new Error("Failed to create reader from response");
          }
          
          // Create an async generator to process the stream
          const stream = (async function*() {
              const decoder = new TextDecoder();
              let buffer = "";
              let responseId = "";
              let messageId = "";
              let fullTextContent = ""; // Accumulate all text chunks
              
              // Handle abort signal
              controller.signal.addEventListener('abort', () => {
                reader.cancel('Aborted by user').catch(err => {
                  if (isLoggingEnabled()) {
                    log(`Error cancelling reader: ${String(err)}`);
                  }
                });
              });
              
              try {
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  
                  buffer += decoder.decode(value, { stream: true });
                  
                  // Process events in the buffer
                  const lines = buffer.split('\n\n');
                  buffer = lines.pop() || ""; // Keep the last line which might be incomplete
                  
                  for (const line of lines) {
                    if (!line.trim() || line.trim() === "data: [DONE]") continue;
                    
                    const dataMatch = line.match(/^data: (.+)$/m);
                    if (!dataMatch) continue;
                    
                    try {
                      const data = JSON.parse(dataMatch[1]);
                      
                      if (data.type === "message_start") {
                        responseId = data.message.id;
                        // Generate unique message ID based on the response ID
                        messageId = `${responseId}-message`;
                        
                        // Some models send initial content in the message_start event
                        if (data.message?.content && data.message.content.length > 0) {
                          for (const content of data.message.content) {
                            if (content.type === "text" && content.text) {
                              fullTextContent += content.text;
                            }
                          }
                        }
                      } else if (data.type === "content_block_start" || data.type === "content_block_delta") {
                        // Accumulate content deltas instead of yielding each one
                        const textContent = data.content_block?.text || data.delta?.text;
                        if (textContent) {
                          fullTextContent += textContent;
                          
                          // This is the critical part: 
                          // We need to match exactly what the agent-loop expects from OpenAI
                          // 1. Send a delta event with ONLY the new text (not accumulated)
                          // 2. If we don't have a stable message ID, we need to reuse the same one
                          // 3. Delta events MUST match the exact format expected by the agent
                          
                          const stableMessageId = messageId || `message-${responseId || Date.now()}`;
                          
                          if (isLoggingEnabled()) {
                            log(`Generating delta with new text: "${textContent}" (${textContent.length} chars)`);
                          }
                          
                          yield {
                            type: "response.output_item.delta", // Match OpenAI's delta event type exactly
                            delta: { 
                              text: textContent // This is just the current delta
                            },
                            item: {
                              id: stableMessageId, // IMPORTANT: Use a stable message ID
                              type: "message", // Must match expected type
                              role: "assistant", // Must be 'assistant' for proper role tracking
                              content: [{ 
                                type: "output_text", // Must be 'output_text' to match expected type
                                text: fullTextContent // Send the ENTIRE accumulated text
                              }],
                            }
                          };
                        }
                      } else if (data.type === "tool_use") {
                        // Handle tool usage
                        yield {
                          type: "response.output_item.done",
                          item: {
                            id: data.id || `${responseId}-tool-${Date.now()}`,
                            type: "function_call",
                            name: data.tool_use.name,
                            call_id: data.tool_use.id,
                            arguments: JSON.stringify(data.tool_use.input),
                          }
                        };
                      } else if (data.type === "message_stop") {
                        // IMPORTANT: This is where we create the completed response that the agent needs
                        // The agent loop expects:
                        // 1. A "response.completed" event with the response ID
                        // 2. The response ID must be set correctly for context tracking
                        
                        // Save the stableMessageId for consistency in the output
                        const stableMessageId = messageId || `message-${responseId || Date.now()}`;
                        
                        if (isLoggingEnabled()) {
                          log(`Message complete with ID: ${responseId}, content length: ${fullTextContent.length}`);
                        }
                        
                        // We need to match EXACTLY how OpenAI formats completion events
                        // The agent-loop.ts expects this exact format to update lastResponseId
                        yield {
                          type: "response.completed",
                          response: {
                            id: responseId, // CRITICAL: This is stored as lastResponseId in agent-loop
                            status: "completed",
                            output: [{
                              id: stableMessageId,
                              type: "message",
                              role: "assistant",
                              content: [{
                                type: "output_text",
                                text: fullTextContent
                              }]
                            }]
                          }
                        };
                        
                        if (isLoggingEnabled()) {
                          log(`Yielded response.completed with ID: ${responseId}`);
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
            })();
            
          // Add controller to stream for abort support
          (stream as any).controller = controller;
          
          return stream;
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
      // Return the stream directly as an async iterable
      return response;
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
   * Conforms to Anthropic's current tool specification while maintaining
   * compatibility with OpenAI's format
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
              // OpenAI uses array format, but we need to document it differently for Anthropic
              // The mapping function will convert string to array format when needed
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
      thinking?: { budgetTokens: number };
    }
  ): Promise<AsyncIterable<any>> {
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
      
      // Handle conversation context properly - this is critical for maintaining context
      // For Anthropic's Messages API, the conversationId is a client-side concept
      // that we use to organize messages from the same conversation
      let conversationId = options.conversationId || this.sessionId || `conv_${Date.now()}`;
      
      // Store the previous response ID to include the turn context
      // This is CRITICAL for maintaining conversation context in the Messages API
      const previousResponseId = options.previousResponseId;
      
      if (isLoggingEnabled()) {
        log(`Using conversation ID: ${conversationId}`);
        log(`Previous response ID: ${previousResponseId || "none"}`);
        log(`Input message count: ${input.length}`);
        for (let i = 0; i < input.length; i++) {
          log(`Input ${i}: ${input[i].type} - ${input[i].role || "unknown role"}`);
        }
      }
      
      // Only streaming (matching OpenAI behavior)
      return await this.client.sendMessage(input, {
        model: this.model,
        system: options.system,
        temperature: options.temperature || 0.7,
        conversationId,
        // Always include shell tool to match OpenAI capability
        tools: this.client.getToolsForCodex(),
        // Pass thinking configuration if provided
        thinking: options.thinking,
        // Always stream - this matches the OpenAI behavior
        stream: true
      });
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