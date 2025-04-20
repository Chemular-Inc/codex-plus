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
  
  constructor(apiKey: string, _sessionId: string) {
    this.anthropic = new Anthropic({
      apiKey: apiKey || ANTHROPIC_API_KEY || "",
    });
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
      
      // Add tools if available
      if (tools.length > 0) {
        params.tools = tools;
      }
      
      // Add temperature if provided
      if (request.temperature !== undefined) {
        params.temperature = request.temperature;
      }
      
      // Add system prompt
      params.system = "You are Claude, a helpful AI assistant integrated with a CLI tool. You can use tools to help the user.";
      
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
      for await (const event of stream) {
        // Type assertion for specific event types
        if (event.type === "content_block_delta") {
          // Cast to avoid TypeScript errors
          const textDelta = event.delta as any;
          if (textDelta && textDelta.type === "text_delta" && typeof textDelta.text === "string") {
            // Content text
            contentBuffer += textDelta.text;
            yield { kind: "content", text: textDelta.text };
          }
        } else if (event.type === "message_delta") {
          if (event.delta.stop_reason) {
            // Get message ID if available
            const anyEvent = event as any;
            if (anyEvent.message && anyEvent.message.id) {
              messageId = anyEvent.message.id;
            }
            
            // Message complete
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
              log(`Tool use started: ${JSON.stringify(currentToolUse)}`);
            }
          }
        } else if (event.type === "content_block_stop") {
          // Cast to any to avoid TypeScript errors
          const contentBlockStop = event as any;
          if (contentBlockStop.content_block && 
              contentBlockStop.content_block.type === "tool_use" && 
              currentToolUse) {
            // Tool use completed, emit tool call
            const toolCall = {
              type: "function_call",
              id: currentToolUse.id,
              call_id: currentToolUse.id,
              name: currentToolUse.name,
              arguments: JSON.stringify(currentToolUse.input),
              status: "completed"
            };
            
            if (isLoggingEnabled()) {
              log(`Emitting tool call: ${JSON.stringify(toolCall)}`);
            }
            
            yield { kind: "toolCall", call: toolCall };
            currentToolUse = null;
          }
        }
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
    if (isLoggingEnabled()) {
      log(`AnthropicProvider.processToolCall: Processing tool call: ${JSON.stringify(item)}`);
    }
    
    // Extract the tool call ID
    const callId = (item as any).call_id || (item as any).id;
    
    if (!callId) {
      log("AnthropicProvider.processToolCall: No call_id found in tool call");
      return [];
    }
    
    // Create a copy of the item
    const toolCallItem = JSON.parse(JSON.stringify(item));
    
    // Ensure the item has both call_id and id properties
    toolCallItem.call_id = callId;
    toolCallItem.id = callId;
    
    // Handle the function call
    const result = await handleFunctionCall(toolCallItem);
    
    // Ensure all result items have the correct call_id
    const finalResults = result.map(outputItem => {
      if (outputItem.type === "function_call_output") {
        return {
          ...outputItem,
          call_id: callId
        };
      }
      return outputItem;
    });
    
    if (isLoggingEnabled()) {
      log(`AnthropicProvider.processToolCall: Results: ${JSON.stringify(finalResults)}`);
    }
    
    return finalResults;
  }
  
  /**
   * Handle provider-specific errors
   */
  handleProviderError(
    error: any,
    onItem: (item: ResponseItem) => void,
    onLoading: (loading: boolean) => void
  ): boolean {
    // Handle Anthropic-specific errors
    if (error && typeof error === 'object') {
      // Check for API errors
      if ('status' in error && typeof error.status === 'number') {
        const errorStatus = error.status;
        
        // Rate limiting
        if (errorStatus === 429) {
          onItem({
            id: `error-${Date.now()}`,
            type: "message",
            role: "system",
            content: [
              {
                type: "input_text",
                text: "⚠️  Anthropic API rate limit exceeded. Please try again shortly."
              }
            ]
          });
          onLoading(false);
          return true;
        }
        
        // Server errors
        if (errorStatus >= 500) {
          onItem({
            id: `error-${Date.now()}`,
            type: "message",
            role: "system",
            content: [
              {
                type: "input_text",
                text: "⚠️  Anthropic API server error. Please try again later."
              }
            ]
          });
          onLoading(false);
          return true;
        }
      }
      
      // Network or timeout errors
      if (
        'code' in error && 
        typeof error.code === 'string' && 
        ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT'].includes(error.code)
      ) {
        onItem({
          id: `error-${Date.now()}`,
          type: "message",
          role: "system",
          content: [
            {
              type: "input_text",
              text: "⚠️  Network error while contacting Anthropic. Please check your connection and try again."
            }
          ]
        });
        onLoading(false);
        return true;
      }
    }
    
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
    return [
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
      },
      // Text editor tool - Anthropic specific
      {
        type: "text_editor_20250124",
        name: "str_replace_editor",
        description: "Edit text files using commands like view, str_replace, create, and insert."
      }
    ];
  }
}