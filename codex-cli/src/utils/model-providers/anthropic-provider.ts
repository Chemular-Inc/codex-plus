/**
 * Anthropic provider implementation
 */

import type { ModelProvider, ChatRequest, ChatDelta, ModelTool } from "./common-types.js";
import type { ResponseInputItem, ResponseItem } from "openai/resources/responses/responses.mjs";
import { log, isLoggingEnabled } from "../agent/log.js";
import { ANTHROPIC_API_KEY } from "../config.js";
import Anthropic from "@anthropic-ai/sdk";

/**
 * Anthropic Provider implementation
 */
export class AnthropicProvider implements ModelProvider {
  name = "anthropic";
  defaultModel = "claude-3-5-sonnet-20240620";
  supportsFunctionCalls = true;
  
  private anthropic: Anthropic;
  
  private sessionId: string;
  
  constructor(apiKey: string, sessionId: string) {
    this.sessionId = sessionId;
    this.anthropic = new Anthropic({
      apiKey: apiKey || ANTHROPIC_API_KEY || "",
    });
    
    if (isLoggingEnabled()) {
      log(`AnthropicProvider: Initialized with sessionId=${sessionId}`);
    }
  }
  
  /**
   * Stream a chat completion from Anthropic
   */
  async *stream(request: ChatRequest): AsyncIterable<ChatDelta> {
    if (isLoggingEnabled()) {
      log(`AnthropicProvider.stream: Streaming from model ${request.model}`);
    }
    
    try {
      // Convert our ChatMessages to Anthropic Messages format
      const messages: Array<Anthropic.MessageParam> = [];
      
      // Add system message if provided
      if (request.system) {
        messages.push({
          role: "user", 
          content: [
            { type: "text", text: request.system }
          ]
        });
      }
      
      // Convert chat messages to Anthropic format
      for (const msg of request.messages) {
        // Convert to Anthropic's role format
        const role = msg.role === "system" ? "user" : msg.role;
        
        // Add the message
        messages.push({
          role: role as "user" | "assistant",
          content: [
            { type: "text", text: msg.content }
          ]
        });
      }
      
      // Prepare tools if provided
      const tools: Array<Anthropic.Tool> = [];
      
      if (request.tools && request.tools.length > 0) {
        // Convert our generic tools to Anthropic's format
        for (const tool of request.tools) {
          if (tool.name === "shell") {
            // Convert shell tool to Anthropic format
            tools.push({
              name: "shell",
              description: "Runs a shell command, and returns its output.",
              input_schema: {
                type: "object",
                properties: {
                  command: {
                    type: "array", 
                    items: { type: "string" },
                    description: "The command to execute"
                  },
                  workdir: {
                    type: "string",
                    description: "The working directory for the command."
                  },
                  timeout: {
                    type: "number",
                    description: "The maximum time to wait for the command to complete in milliseconds."
                  }
                },
                required: ["command"]
              }
            });
          }
        }
        
        // Add text editor tool if needed
        tools.push({
          name: "str_replace_editor",
          description: "Edit text files using commands like view, str_replace, create, and insert.",
          input_schema: {
            type: "object",
            properties: {},
            additionalProperties: true
          }
        } as Anthropic.Tool);
      }
      
      // Create message parameters for Anthropic API
      const params: Anthropic.MessageCreateParams = {
        model: request.model,
        max_tokens: 4096,
        messages,
        stream: true,
      };
      
      // Add tools if available - but handle Claude 3.7 differently
      if (tools.length > 0) {
        // Check if this is a Claude 3.7 model - they have unique tool handling requirements
        const isClaude37 = request.model.includes("claude-3-7") || request.model.includes("claude-3.7");
        
        if (isClaude37) {
          if (isLoggingEnabled()) {
            log(`AnthropicProvider: Claude 3.7 detected, using modified tool configuration`);
          }
          
          // For Claude 3.7, ensure we specify tool_choice
          params.tools = tools;
          params.tool_choice = "auto";
        } else {
          params.tools = tools;
        }
      }
      
      // Add temperature if provided
      if (request.temperature !== undefined) {
        params.temperature = request.temperature;
      }
      
      // Add system prompt - customize for Claude 3.7
      if (request.model.includes("claude-3-7") || request.model.includes("claude-3.7")) {
        params.system = "You are Claude 3.7, a helpful AI assistant integrated with a CLI tool. You have access to tools for viewing files and executing commands. When appropriate, use these tools to help the user.";
      } else {
        params.system = "You are Claude, a helpful AI assistant integrated with a CLI tool. You can use tools to help the user.";
      }
      
      if (isLoggingEnabled()) {
        log(`AnthropicProvider.stream: params = ${JSON.stringify(params, null, 2)}`);
      }
      
      // Create the message stream
      const stream = await this.anthropic.messages.create(params);
      
      // Variables to track the current tool use
      let currentToolUse: { id: string; name: string; input: any } | null = null;
      let contentBuffer = "";
      let messageId = "";
      
      // Process the stream
      try {
        if (isLoggingEnabled()) {
          log(`AnthropicProvider: Starting to process stream events`);
        }
        
        // TypeScript fix: assert that stream has Symbol.asyncIterator as in OpenAI implementation
        const asyncIterable = stream as unknown as AsyncIterable<any>;
        
        for await (const event of asyncIterable) {
          if (isLoggingEnabled()) {
            log(`AnthropicProvider: Event received: ${event.type}`);
          }
          
          // Type assertion for specific event types
          if (event.type === "content_block_delta") {
            // Cast to avoid TypeScript errors
            const textDelta = event.delta as any;
            if (textDelta && textDelta.type === "text_delta" && typeof textDelta.text === "string") {
              // Content text
              contentBuffer += textDelta.text;
              
              if (isLoggingEnabled()) {
                log(`AnthropicProvider: Text content: "${textDelta.text}"`);
              }
              
              yield { kind: "content", text: textDelta.text };
            } else {
              if (isLoggingEnabled()) {
                log(`AnthropicProvider: Unhandled content_block_delta: ${JSON.stringify(textDelta)}`);
              }
            }
          } else if (event.type === "message_delta") {
            if (isLoggingEnabled()) {
              log(`AnthropicProvider: Message delta received`);
            }
            
            if (event.delta.stop_reason) {
              // Get message ID if available
              const anyEvent = event as any;
              if (anyEvent.message && anyEvent.message.id) {
                messageId = anyEvent.message.id;
                if (isLoggingEnabled()) {
                  log(`AnthropicProvider: Got message ID: ${messageId}`);
                }
              }
              
              // Message complete
              if (isLoggingEnabled()) {
                log(`AnthropicProvider: Stream complete with stop_reason, yielding done event with messageId: ${messageId}`);
              }
              
              yield { 
                kind: "done", 
                responseId: messageId 
              };
            }
          } else if (event.type === "content_block_start") {
            // Cast to any to avoid TypeScript errors
            const contentBlockStart = event as any;
            
            if (contentBlockStart.content_block && contentBlockStart.content_block.type === "tool_use") {
              // Tool use started
              currentToolUse = {
                id: contentBlockStart.content_block.id,
                name: contentBlockStart.content_block.name,
                input: contentBlockStart.content_block.input
              };
              
              if (isLoggingEnabled()) {
                log(`AnthropicProvider: Tool use started: ${JSON.stringify(currentToolUse)}`);
              }
            }
          } else if (event.type === "content_block_stop") {
            // Cast to any to avoid TypeScript errors
            const contentBlockStop = event as any;
            
            if (contentBlockStop.content_block && 
                contentBlockStop.content_block.type === "tool_use" && 
                currentToolUse) {
              // Tool use completed, emit tool call
              // Use the same structure as OpenAI for maximum compatibility
              const toolCall = {
                type: "function_call",
                id: currentToolUse.id,
                call_id: currentToolUse.id,
                name: currentToolUse.name,
                arguments: JSON.stringify(currentToolUse.input),
                status: "completed"
              };
              
              if (isLoggingEnabled()) {
                log(`AnthropicProvider: Emitting tool call with ID: ${currentToolUse.id}`);
              }
              
              yield { kind: "toolCall", call: toolCall };
              currentToolUse = null;
            }
          } else if (event.type === "content_block_error") {
            // Handle tool call errors
            log(`AnthropicProvider: Content block error: ${JSON.stringify(event)}`);
          } else {
            if (isLoggingEnabled()) {
              log(`AnthropicProvider: Unhandled event type: ${event.type}`);
            }
          }
        }
        
        // This is the fallback if there was no message_delta with stop_reason
        if (!messageId) {
          if (isLoggingEnabled()) {
            log(`AnthropicProvider: Stream ended without stop_reason`);
          }
          
          // Regardless of whether we've sent a done event or not, always ensure we have content
          if (contentBuffer && contentBuffer.trim().length > 0) {
            if (isLoggingEnabled()) {
              log(`AnthropicProvider: Content buffer has content, yielding final content`);
            }
            
            // If we have content but got no "done" event, ensure we yield the content
            yield { kind: "content", text: contentBuffer };
          }
          
          // Always send a done event at the end of the stream to ensure client doesn't hang
          if (isLoggingEnabled()) {
            log(`AnthropicProvider: Sending fallback done event`);
          }
          
          yield { 
            kind: "done", 
            responseId: `anthropic-${Date.now()}`
          };
        }
      }
      } catch (streamError) {
        log(`Error processing Anthropic stream events: ${streamError}`);
        
        // Make sure we yield a done event even on error, so the client doesn't hang
        yield { 
          kind: "done", 
          responseId: `anthropic-error-${Date.now()}`
        };
        
        throw streamError;
      }
    } catch (error) {
      log(`Error streaming from Anthropic: ${error}`);
      throw error;
    }
  }
  
  /**
   * Process stream events from Anthropic
   */
  processStreamEvent(
    event: Record<string, unknown>,
    _responseId: string,
    _thinkingStart: number
  ): ResponseItem | null {
    if (!event || !event['type']) {
      return null;
    }
    
    // Handle individual item events
    if (event['type'] === "response.output_item.done" && event['item']) {
      const item = event['item'] as ResponseItem;
      return item;
    }
    
    return null;
  }
  
  /**
   * Process tool calls from Anthropic
   */
  async processToolCall(
    item: ResponseItem,
    handleFunctionCall: (item: any) => Promise<Array<ResponseInputItem>>
  ): Promise<Array<ResponseInputItem>> {
    try {
      if (isLoggingEnabled()) {
        log(`AnthropicProvider.processToolCall: Processing tool call: ${JSON.stringify(item)}`);
      }
      
      // Extract the call ID - critical for matching with function_call_output
      const callId = (item as any).call_id || (item as any).id;
      
      if (!callId) {
        log("AnthropicProvider.processToolCall: No call_id found in tool call");
        return [];
      }
      
      if (isLoggingEnabled()) {
        log(`AnthropicProvider.processToolCall: Using call_id: ${callId}`);
      }
      
      // Create a copy of the item as plain object
      const toolCallItem: Record<string, unknown> = {};
      
      // Copy all properties to a plain object
      Object.entries(item as any).forEach(([key, value]) => {
        toolCallItem[key] = value;
      });
      
      // Ensure the item has both call_id and id properties for maximum compatibility
      toolCallItem.call_id = callId;
      toolCallItem.id = callId;
      
      // Ensure type is set correctly
      if (!toolCallItem.type) {
        toolCallItem.type = "function_call";
      }
      
      // For Anthropic, we may need to ensure arguments is a string
      if (toolCallItem.arguments && typeof toolCallItem.arguments !== 'string') {
        toolCallItem.arguments = JSON.stringify(toolCallItem.arguments);
      }
      
      // Handle the function call
      const result = await handleFunctionCall(toolCallItem);
      
      if (isLoggingEnabled()) {
        log(`AnthropicProvider.processToolCall: handleFunctionCall returned ${result.length} items`);
      }
      
      // Ensure all result items have the correct call_id for consistency
      const finalResults = result.map(outputItem => {
        if (outputItem.type === "function_call_output") {
          console.error(`Function call output before fix: call_id=${(outputItem as any).call_id}`);
          
          const fixedItem = {
            ...outputItem,
            call_id: callId
          };
          
          console.error(`Function call output after fix: call_id=${fixedItem.call_id}`);
          return fixedItem;
        }
        return outputItem;
      });
      
      return finalResults;
    } catch (error) {
      log(`Error processing tool call: ${error}`);
      console.error(`Error in AnthropicProvider.processToolCall: ${error}`);
      
      // Get the call ID for the error response
      const callId = (item as any).call_id || (item as any).id;
      
      if (!callId) {
        console.error(`WARNING: No call_id found in function call item`);
      }
      
      // Create an error response with the correct call_id
      return [{
        type: "function_call_output",
        call_id: callId || `anthropic-error-${Date.now()}`,
        output: `Error processing tool call: ${error}`,
      } as ResponseInputItem];
    }
  }
  
  /**
   * Handle provider-specific errors
   */
  handleProviderError(
    error: any,
    onItem: (item: ResponseItem) => void,
    onLoading: (loading: boolean) => void
  ): boolean {
    // Log the error for debugging
    if (isLoggingEnabled()) {
      log(`AnthropicProvider.handleProviderError: ${JSON.stringify(error)}`);
    }
    
    // Handle Anthropic-specific errors
    if (error && typeof error === 'object') {
      // Get the error status code if available
      const errorStatus = error.status || error.statusCode || (error.response && error.response.status);
      
      // Check for error type - similar naming to OpenAI for consistency
      const errorType = error.type || error.error_type || (error.error && error.error.type);
      
      // Check for error message
      const errorMessage = error.message || (error.error && error.error.message) || "Unknown error";
      
      // Check for rate limits
      const isRateLimit = 
        errorStatus === 429 || 
        errorType === 'rate_limit_exceeded' || 
        /rate limit|too many requests/i.test(errorMessage);
      
      if (isRateLimit) {
        // Format error details for display
        const errorDetails = [
          `Status: ${errorStatus || "unknown"}`,
          `Type: ${errorType || "rate limit"}`,
          `Message: ${errorMessage}`
        ].join(", ");
        
        onItem({
          id: `error-${Date.now()}`,
          type: "message",
          role: "system",
          content: [
            {
              type: "input_text",
              text: `⚠️  Anthropic API rate limit exceeded. ${errorDetails}`
            }
          ]
        });
        onLoading(false);
        return true;
      }
      
      // Server errors (500 range)
      const isServerError = errorStatus && errorStatus >= 500;
      if (isServerError) {
        onItem({
          id: `error-${Date.now()}`,
          type: "message",
          role: "system",
          content: [
            {
              type: "input_text",
              text: `⚠️  Anthropic API server error (${errorStatus}). Please try again later.`
            }
          ]
        });
        onLoading(false);
        return true;
      }
      
      // Client errors (400 range, excluding rate limits)
      const isClientError = errorStatus && errorStatus >= 400 && errorStatus < 500 && errorStatus !== 429;
      if (isClientError) {
        // Format error details for display
        const errorDetails = [
          `Status: ${errorStatus}`,
          `Type: ${errorType || "client_error"}`,
          `Message: ${errorMessage}`
        ].join(", ");
        
        onItem({
          id: `error-${Date.now()}`,
          type: "message",
          role: "system",
          content: [
            {
              type: "input_text",
              text: `⚠️  Anthropic API request error. ${errorDetails}`
            }
          ]
        });
        onLoading(false);
        return true;
      }
      
      // Network or timeout errors
      const isNetworkError = 
        (error.code && ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT'].includes(error.code)) ||
        error.name === 'TimeoutError' ||
        /timeout|network|connection/i.test(errorMessage);
        
      if (isNetworkError) {
        onItem({
          id: `error-${Date.now()}`,
          type: "message",
          role: "system",
          content: [
            {
              type: "input_text",
              text: `⚠️  Network error while contacting Anthropic. Please check your connection and try again. Error: ${errorMessage}`
            }
          ]
        });
        onLoading(false);
        return true;
      }
    }
    
    // If we couldn't identify the error type, let the agent loop handle it
    return false;
  }
  
  /**
   * Get the API key for Anthropic
   */
  getApiKey(configApiKey?: string): string {
    return configApiKey || ANTHROPIC_API_KEY || "";
  }
  
  /**
   * Get Anthropic-specific tool definitions
   */
  getToolDefinitions(): Array<ModelTool> {
    // Get current model being used
    const modelId = this.defaultModel;
    const isClaude37 = modelId.includes("claude-3-7") || modelId.includes("claude-3.7");
    
    if (isLoggingEnabled()) {
      log(`AnthropicProvider.getToolDefinitions: Getting tools for model ${modelId}, isClaude37=${isClaude37}`);
    }
    
    // Base tools that work with all Claude versions
    const baseTools: Array<ModelTool> = [
      // Shell tool
      {
        type: "function",
        name: "shell",
        description: "Runs a shell command, and returns its output.",
        parameters: {
          type: "object",
          properties: {
            command: { 
              type: "array", 
              items: { type: "string" },
              description: "The command to execute"
            },
            workdir: {
              type: "string",
              description: "The working directory for the command."
            },
            timeout: {
              type: "number",
              description: "The maximum time to wait for the command to complete in milliseconds."
            }
          },
          required: ["command"]
        }
      }
    ];
    
    // Add Claude 3.7 specific configuration for text editor tool
    if (isClaude37) {
      if (isLoggingEnabled()) {
        log(`AnthropicProvider.getToolDefinitions: Using Claude 3.7 specific tool configuration`);
      }
      
      // Add simplified editor tool for Claude 3.7
      baseTools.push({
        type: "function",
        name: "file_editor",
        description: "Edit text files using view, edit, and create operations.",
        parameters: {
          type: "object",
          properties: {
            operation: {
              type: "string",
              enum: ["view", "edit", "create"],
              description: "The operation to perform on the file"
            },
            path: {
              type: "string",
              description: "The absolute path to the file"
            },
            content: {
              type: "string",
              description: "The content to write (for edit and create operations)"
            }
          },
          required: ["operation", "path"]
        }
      });
    } else {
      // Standard editor tool for other Claude versions
      baseTools.push({
        type: "text_editor_20250124",
        name: "str_replace_editor",
        description: "Edit text files using commands like view, str_replace, create, and insert."
      });
    }
    
    return baseTools;
  }
}