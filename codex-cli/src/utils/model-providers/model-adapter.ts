/**
 * Model adapter that works with the agent loop
 * 
 * This is the main interface between the agent loop and the provider-specific implementations.
 * It normalizes the communication between the application and model providers.
 */

import type { ChatMessage, ChatRequest, ModelProvider } from "./common-types.js";
import type { AppConfig } from "../config.js";
import type { ResponseInputItem, ResponseItem } from "openai/resources/responses/responses.mjs";

import { getProviderForModel } from "./provider-registry.js";
import { resolveModel } from "../model-utils.js";
import { log, isLoggingEnabled } from "../agent/log.js";


export class ModelAdapter {
  private provider: ModelProvider | null = null;
  private modelId: string;
  private providerName: string;
  
  constructor(
    private model: string,
    private sessionId: string,
    private config?: AppConfig
  ) {
    // Resolve the model to determine provider and actual model ID
    const resolvedModel = resolveModel(model);
    
    if (resolvedModel) {
      this.providerName = resolvedModel.provider;
      this.modelId = resolvedModel.modelId;
    } else {
      // Fall back to OpenAI if we can't resolve the model
      this.providerName = "openai";
      this.modelId = model;
    }
    
    if (isLoggingEnabled()) {
      log(`ModelAdapter initialized with provider: ${this.providerName}, model: ${this.modelId}`);
    }
  }
  
  /**
   * Get the API key for the current provider
   */
  getApiKey(): string {
    // Initialize the provider if needed
    this.initializeProvider();
    
    if (!this.provider) {
      throw new Error(`No provider available for ${this.providerName}`);
    }
    
    return this.provider.getApiKey(this.config?.apiKey);
  }
  
  /**
   * Initialize the provider
   */
  private initializeProvider(): void {
    if (this.provider) {
      return;
    }
    
    // Get API key based on provider
    let apiKey = "";
    if (this.providerName === "openai") {
      apiKey = this.config?.apiKey ?? process.env["OPENAI_API_KEY"] ?? "";
    } else if (this.providerName === "anthropic") {
      apiKey = process.env["ANTHROPIC_API_KEY"] ?? "";
    }
    
    this.provider = getProviderForModel(this.model, apiKey, this.sessionId);
    
    if (!this.provider) {
      throw new Error(`Could not initialize provider for model: ${this.model}`);
    }
  }
  
  /**
   * Stream a chat completion from the provider
   */
  async createStream(
    messages: Array<ResponseInputItem>,
    instructions: string,
    previousResponseId: string = ""
  ): Promise<AsyncIterable<Record<string, unknown>>> {
    // Initialize the provider if needed
    this.initializeProvider();
    
    if (!this.provider) {
      throw new Error(`No provider available for ${this.providerName}`);
    }
    
    // Convert our ResponseInputItems to ChatMessages
    const chatMessages: Array<ChatMessage> = [];
    
    // We need to convert ResponseInputItems to the format expected by our provider
    // First, extract the message-type items for the chat history
    for (const item of messages) {
      if (isLoggingEnabled()) {
        log(`Processing message item type: ${item.type}`);
      }
      
      if (item.type === "message") {
        let contentText = "";
        if (Array.isArray(item.content)) {
          contentText = item.content
            .map(c => {
              if (c.type === "input_text" || c.type === "output_text") {
                return c.text;
              }
              return "";
            })
            .join("");
        } else if (typeof item.content === "string") {
          contentText = item.content;
        }
        
        // Cast role to expected types
        const role = item.role === "assistant" ? "assistant" : 
                     item.role === "system" ? "system" : "user";
        
        chatMessages.push({
          role: role,
          content: contentText
        });
      }
      // Function call outputs are handled separately by the agent loop
    }
    
    // Create the chat request
    const chatRequest: ChatRequest = {
      model: this.modelId,
      messages: chatMessages,
      system: instructions,
      tools: this.provider.getToolDefinitions
        ? this.provider.getToolDefinitions()
        : [{
            type: "function",
            name: "shell",
            description: "Runs a shell command, and returns its output.",
            ...(this.providerName === "openai" && {
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
                    description: "The maximum time to wait for the command to complete in milliseconds.",
                  },
                },
                required: ["command"],
                additionalProperties: false,
              },
            }),
          }],
      stream: true,
      extras: {
        // Include original messages as input for the provider
        input: messages
      }
    };
    
    // Log all input messages for diagnostic purposes
    console.error('INPUT MESSAGES:');
    for (const msg of messages) {
      if (msg.type === 'function_call_output') {
        console.error(`  function_call_output: call_id=${msg.call_id}`);
      }
    }
    
    // Add previous response ID if available and non-empty
    if (previousResponseId && previousResponseId.trim() !== '') {
      // Pass the previous response ID directly to the provider
      console.error(`Using previous_response_id: ${previousResponseId}`);
      
      if (isLoggingEnabled()) {
        log(`Adding previous_response_id to request: ${previousResponseId}`);
      }
      
      chatRequest.extras = {
        ...chatRequest.extras,
        previous_response_id: previousResponseId
      };
    } else {
      if (isLoggingEnabled()) {
        log('No previous_response_id provided');
      }
    }
    
    if (isLoggingEnabled()) {
      log(`Creating stream with provider: ${this.providerName}, model: ${this.modelId}`);
    }
    
    // Create a synthetic stream that translates between the provider's format and the agent loop's expected format
    const providerStream = this.provider.stream(chatRequest);
    
    // Return an AsyncIterable that transforms provider-specific events to the format expected by agent-loop
    return {
      [Symbol.asyncIterator]: async function* () {
        try {
          // Track content accumulation for the final response
          let contentAccumulator = "";
          let toolCall: Record<string, unknown> | null = null;
          
          // We'll get the actual response ID from the provider's completed event
          // But have a fallback just in case
          let responseId = `${Date.now()}`;
          
          // Process deltas from the provider
          for await (const delta of providerStream) {
            if (delta.kind === "content") {
              // Accumulate content
              contentAccumulator += delta.text;
              
              // Emit event in the format agent-loop expects
              yield {
                type: "response.output_item.done",
                item: {
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: delta.text }],
                  id: responseId
                }
              };
            } 
            else if (delta.kind === "toolCall") {
              // Store the tool call for the completed event
              toolCall = delta.call;
              
              console.error(`\n*** ADAPTER RECEIVED TOOL CALL ***`);
              console.error(`Raw tool call from provider:`, JSON.stringify(toolCall, null, 2));
              
              // Make sure the toolCall has a proper ID format 
              if (toolCall) {
                // OpenAI expects IDs in a specific format
                const callId = (toolCall as Record<string, any>)['call_id'] || (toolCall as Record<string, any>)['id'];
                if (callId) {
                  console.error(`Tool call has ID: ${callId}`);
                  
                  // Ensure both id and call_id are set for maximum compatibility
                  // We want to make sure both of these are EXACTLY the same
                  (toolCall as Record<string, any>)['call_id'] = callId;
                  (toolCall as Record<string, any>)['id'] = callId;
                  
                  console.error(`Final tool call with ID: ${(toolCall as Record<string, any>)['call_id']}`);
                } else {
                  console.error(`WARNING: Tool call without ID!`);
                }
              }
              
              // Also emit the tool call immediately - this matches the original agent loop behavior
              yield {
                type: "response.output_item.done",
                item: toolCall
              };
            }
            else if (delta.kind === "done") {
              // Prepare the final output items for the completion event
              const outputItems = [];
              
              // If we have a tool call, add it to the completion event
              if (toolCall) {
                console.error(`Including tool call in completion event with ID: ${toolCall['call_id'] || toolCall['id']}`);
                outputItems.push(toolCall);
              }
              
              // If we have content, add a message item
              if (contentAccumulator) {
                outputItems.push({
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: contentAccumulator }],
                  id: responseId
                });
              }
              
              // If the provider gives us a response ID, use it
              // This is CRITICAL: OpenAI must recognize its own ID
              if (delta.responseId) {
                responseId = delta.responseId;
                console.error(`Provider supplied response ID: ${responseId}`);
              }
              
              console.error(`Using response ID in completion event: ${responseId}`);
              
              // Special handling for Claude with tool calls
              // If the stop reason is "tool_use", we need to make sure the agent loop
              // processes the tool call first, before sending the completion event
              const isClaudeToolUse = delta.stopReason === "tool_use" && toolCall;
              
              if (isClaudeToolUse) {
                console.error(`Claude stop_reason="tool_use" detected, ensuring tool call is processed first`);
                
                // For Claude, we need to ensure the agent processes this tool call immediately
                // We don't want to mark this as "completed" yet since Claude will continue after the tool result
                yield {
                  type: "response.output_item.done",
                  item: toolCall
                };
                
                // The completion event should reflect the current response so far,
                // but status should be "incomplete" to signal that we expect more after tool execution
                yield {
                  type: "response.completed",
                  response: {
                    id: responseId,
                    status: "requires_action",
                    output: outputItems,
                    requires_action: {
                      type: "submit_tool_outputs",
                      tool_calls: [toolCall]
                    }
                  }
                };
              } else {
                // Normal completion for non-tool-use stops
                yield {
                  type: "response.completed",
                  response: {
                    id: responseId,
                    status: "completed",
                    output: outputItems
                  }
                };
              }
            }
          }
        } catch (error) {
          log(`Error in provider stream: ${error}`);
          throw error;
        }
      }
    };
  }
  
  /**
   * Process a provider-specific event
   */
  processStreamEvent(
    event: Record<string, unknown>,
    responseId: string,
    thinkingStart: number
  ): ResponseItem | null {
    // Initialize the provider if needed
    this.initializeProvider();
    
    if (!this.provider) {
      throw new Error(`No provider available for ${this.providerName}`);
    }
    
    return this.provider.processStreamEvent(event, responseId, thinkingStart);
  }
  
  /**
   * Process a tool call using the provider-specific logic
   */
  async processToolCall(
    item: ResponseItem,
    handleFunctionCall: (item: any) => Promise<Array<ResponseInputItem>>
  ): Promise<Array<ResponseInputItem>> {
    // Initialize the provider if needed
    this.initializeProvider();
    
    if (!this.provider) {
      throw new Error(`No provider available for ${this.providerName}`);
    }
    
    return this.provider.processToolCall(item, handleFunctionCall);
  }
  
  /**
   * Handle provider-specific errors
   */
  handleProviderError(
    error: any,
    onItem: (item: ResponseItem) => void,
    onLoading: (loading: boolean) => void
  ): boolean {
    // Initialize the provider if needed
    this.initializeProvider();
    
    if (!this.provider) {
      // If we can't initialize the provider, we can't handle the error
      return false;
    }
    
    return this.provider.handleProviderError(error, onItem, onLoading);
  }
}