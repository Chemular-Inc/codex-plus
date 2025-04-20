/**
 * Model adapter that works with the agent loop
 * 
 * This is the main interface between the agent loop and the provider-specific implementations.
 * It normalizes the communication between the application and model providers.
 */

import type { ChatMessage, ChatRequest, ModelProvider } from "./common-types.js";
import type { AppConfig } from "../config.js";
import type { ResponseInputItem, ResponseItem } from "openai/resources/responses/responses.mjs";

import { getProviderForModel, resolveModel } from "./provider-registry.js";
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
      tools: [{
        type: "function",
        name: "shell",
        description: "Runs a shell command, and returns its output."
      }],
      stream: true,
      extras: {
        // Include original messages as input for the OpenAI provider
        input: messages
      }
    };
    
    // Add previous response ID if available and non-empty
    if (previousResponseId && previousResponseId.trim() !== '') {
      // OpenAI's API prefers having a properly formatted previous_response_id or none at all
      // We'll include it in extras for the provider to use appropriately
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
          const responseId = `${Date.now()}`;
          
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
              
              // Make sure the toolCall has a proper ID format 
              if (toolCall) {
                // OpenAI expects IDs in a specific format
                const callId = toolCall.call_id || toolCall.id;
                if (callId) {
                  if (isLoggingEnabled()) {
                    log(`Received tool call with ID: ${callId}`);
                  }
                  
                  // Ensure both id and call_id are set for maximum compatibility
                  toolCall.call_id = callId;
                  toolCall.id = callId;
                } else {
                  log(`Warning: Tool call without ID received: ${JSON.stringify(toolCall)}`);
                }
              }
            }
            else if (delta.kind === "done") {
              // Prepare the final output items for the completion event
              const outputItems = [];
              
              // If we have a tool call, add it first
              if (toolCall) {
                outputItems.push(toolCall);
                
                if (isLoggingEnabled()) {
                  log(`Including tool call in final output: ${JSON.stringify(toolCall)}`);
                }
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
              
              // Create a properly formatted response ID for OpenAI
              // OpenAI requires IDs to start with 'resp'
              const formattedResponseId = responseId.startsWith('resp') 
                ? responseId 
                : `resp_${responseId}`;
                
              // Emit the completion event with properly formatted ID
              yield {
                type: "response.completed",
                response: {
                  id: formattedResponseId,
                  status: "completed",
                  output: outputItems
                }
              };
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