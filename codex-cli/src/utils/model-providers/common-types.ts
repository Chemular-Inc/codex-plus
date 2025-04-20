/**
 * Common types and interfaces for model providers
 * 
 * This file defines the core interfaces that all model providers must implement,
 * creating a provider-agnostic abstraction layer for the rest of the application.
 */

import type { ResponseInputItem, ResponseItem } from "openai/resources/responses/responses.mjs";

/**
 * Represents a message in a chat conversation.
 */
export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

/**
 * Represents a tool that can be invoked by the model.
 */
export interface ModelTool {
  type: string;
  name: string;
  description?: string; 
  parameters?: Record<string, unknown>;
}

/**
 * Options for how tools are used.
 */
export type ToolChoice = "auto" | "none" | { name: string };

/**
 * Response emitted during streaming.
 */
export type ChatDelta = 
  | { kind: "content"; text: string }
  | { kind: "toolCall"; call: Record<string, unknown> } 
  | { kind: "done"; responseId?: string };

/**
 * Request parameters for chat completions.
 */
export interface ChatRequest {
  model: string;
  messages: Array<ChatMessage>;
  temperature?: number;
  system?: string;
  tools?: Array<ModelTool>;
  toolChoice?: ToolChoice;
  stream?: boolean;
  extras?: Record<string, unknown>;
}

/**
 * Provider adapter interface that all model providers must implement.
 */
export interface ModelProvider {
  /** Name of the provider (e.g., "openai", "anthropic") */
  name: string;
  
  /** The default model to use if none is specified */
  defaultModel: string;
  
  /** Whether this provider supports function/tool calls */
  supportsFunctionCalls: boolean;
  
  /** Stream a chat completion from the provider */
  stream(request: ChatRequest): AsyncIterable<ChatDelta>;
  
  /** 
   * Convert provider-specific events to standard ResponseItems
   * This method normalizes the provider's event format to the application's format
   */
  processStreamEvent(
    event: Record<string, unknown>, 
    responseId: string,
    thinkingStart: number
  ): ResponseItem | null;
  
  /**
   * Process tool calls from the provider
   * Returns items that should be added to turnInput
   */
  processToolCall(
    item: ResponseItem, 
    handleFunctionCall: (item: any) => Promise<Array<ResponseInputItem>>
  ): Promise<Array<ResponseInputItem>>;
  
  /**
   * Handle provider-specific errors
   * Returns true if the error was handled, false if it should be thrown
   */
  handleProviderError(
    error: any, 
    onItem: (item: ResponseItem) => void, 
    onLoading: (loading: boolean) => void
  ): boolean;
  
  /**
   * Get the API key for this provider from environment variables or config
   */
  getApiKey(configApiKey?: string): string;
  
  /**
   * Get provider-specific tool definitions
   * Optional method that returns custom tool definitions for this provider
   */
  getToolDefinitions?(): Array<ModelTool>;
}