/**
 * OpenAI provider implementation
 */

import type { ModelProvider, ChatRequest, ChatDelta, ModelTool } from "./common-types.js";
import type { ResponseInputItem, ResponseItem } from "openai/resources/responses/responses.mjs";
import type { Reasoning } from "openai/resources.mjs";


import { log, isLoggingEnabled } from "../agent/log.js";
import { OPENAI_BASE_URL, OPENAI_TIMEOUT_MS } from "../config.js";
import { CLI_VERSION, ORIGIN } from "../session.js";
import OpenAI, { APIConnectionTimeoutError } from "openai";

/**
 * OpenAI Provider implementation
 */
export class OpenAIProvider implements ModelProvider {
  name = "openai";
  defaultModel = "gpt-4o";
  supportsFunctionCalls = true;
  
  private oai: OpenAI;
  
  constructor(apiKey: string, sessionId: string) {
    const timeoutMs = OPENAI_TIMEOUT_MS;
    
    this.oai = new OpenAI({
      // The OpenAI JS SDK only requires `apiKey` when making requests against
      // the official API. When running unit‑tests we stub out all network
      // calls so an undefined key is perfectly fine.
      ...(apiKey ? { apiKey } : {}),
      baseURL: OPENAI_BASE_URL,
      defaultHeaders: {
        originator: ORIGIN,
        version: CLI_VERSION,
        session_id: sessionId,
      },
      ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
    });
  }
  
  /**
   * Stream a chat completion from OpenAI
   */
  async *stream(request: ChatRequest): AsyncIterable<ChatDelta> {
    if (isLoggingEnabled()) {
      log(`OpenAI streaming request: ${JSON.stringify(request, null, 2)}`);
    }
    
    // Convert the provider-agnostic request to OpenAI's format
    const mergedInstructions = request.system || "";
    
    // Prepare tools for OpenAI
    const tools = this.prepareTools(request.tools || []);
    
    // Prepare reasoning for o1/o2/o3/o4 models
    let reasoning: Reasoning | undefined;
    if (request.model.startsWith("o")) {
      reasoning = { effort: "high" };
      if (request.model === "o3" || request.model === "o4-mini") {
        reasoning.summary = "auto";
      }
    }
    
    try {
      // Use the responses API which provides more detailed events
      const stream = await this.oai.responses.create({
        model: request.model,
        instructions: mergedInstructions,
        input: [], // This will be populated by the agent loop
        stream: true,
        parallel_tool_calls: false,
        reasoning,
        tools,
        temperature: request.temperature ?? 0.7,
      });
      
      // Process the stream and normalize to our ChatDelta format
      for await (const event of stream) {
        if (event.type === "response.output_item.done" && event.item) {
          const item = event.item;
          
          if (item.type === "message") {
            // For text content, yield content deltas
            const content = item.content;
            if (Array.isArray(content)) {
              for (const part of content) {
                if (part.type === "output_text" && part.text) {
                  yield { kind: "content", text: part.text };
                }
              }
            }
          } else if (item.type === "function_call") {
            // For function calls, yield toolCall deltas - convert to plain object first
            const plainObject: Record<string, unknown> = {};
            // Copy all properties to a plain object
            Object.entries(item).forEach(([key, value]) => {
              plainObject[key] = value;
            });
            yield { kind: "toolCall", call: plainObject };
          }
        }
        
        if (event.type === "response.completed") {
          yield { kind: "done" };
        }
      }
    } catch (error) {
      log(`Error streaming from OpenAI: ${error}`);
      throw error;
    }
  }
  
  /**
   * Process stream events from OpenAI
   */
  processStreamEvent(
    event: Record<string, unknown>,
    _responseId: string,
    thinkingStart: number
  ): ResponseItem | null {
    if (!event || !event['type']) {
      return null;
    }
    
    // Handle individual item events
    if (event['type'] === "response.output_item.done" && event['item']) {
      const item = event['item'] as ResponseItem;
      
      // If it's a reasoning item, annotate it with thinking time
      // Use a safe check for reasoning type
      if ((item as any).type === "reasoning") {
        (item as any).duration_ms = Date.now() - thinkingStart;
      }
      
      return item;
    }
    
    // Handle completed events - these contain the full output
    if (event['type'] === "response.completed" && 
        (event as any)['response'] && 
        (event as any)['response']['output']) {
      // This is handled separately in the agent loop
      return null;
    }
    
    return null;
  }
  
  /**
   * Process tool calls from OpenAI
   */
  async processToolCall(
    item: ResponseItem,
    handleFunctionCall: (item: any) => Promise<Array<ResponseInputItem>>
  ): Promise<Array<ResponseInputItem>> {
    if (item.type !== "function_call") {
      return [];
    }
    
    try {
      // Convert item to an object type accepted by the handleFunctionCall method
      // Use a plain object with same properties to avoid type issues
      const functionCallItem: Record<string, unknown> = {};
      
      // Copy all enumerable properties to plain object
      Object.entries(item).forEach(([key, value]) => {
        functionCallItem[key] = value;
      });
      
      // Process function call
      return await handleFunctionCall(functionCallItem);
    } catch (error) {
      log(`Error processing tool call: ${error}`);
      return [{
        type: "function_call_output",
        call_id: (item as any).call_id || (item as any).id,
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
    const isTimeout = error instanceof APIConnectionTimeoutError;
    
    // Get OpenAI's API Connection Error constructor if available
    const ApiConnErrCtor = (OpenAI as any).APIConnectionError as
      | (new (...args: any) => Error)
      | undefined;
    const isConnectionError = ApiConnErrCtor
      ? error instanceof ApiConnErrCtor
      : false;
      
    const errCtx = error as any;
    const status = errCtx?.status ?? errCtx?.httpStatus ?? errCtx?.statusCode;
    const isServerError = typeof status === "number" && status >= 500;
    
    if (isTimeout || isServerError || isConnectionError) {
      // These errors can be retried, so we don't handle them here
      return false;
    }
    
    const isTooManyTokensError =
      (errCtx.param === "max_tokens" ||
        (typeof errCtx.message === "string" &&
          /max_tokens is too large/i.test(errCtx.message))) &&
      errCtx.type === "invalid_request_error";
      
    if (isTooManyTokensError) {
      // Handle token limit error
      onItem({
        id: `error-${Date.now()}`,
        type: "message",
        role: "system",
        content: [
          {
            type: "input_text",
            text: "⚠️  The current request exceeds the maximum context length supported by the chosen model. Please shorten the conversation, run /clear, or switch to a model with a larger context window and try again.",
          },
        ],
      });
      onLoading(false);
      return true;
    }
    
    const isRateLimit =
      status === 429 ||
      errCtx.code === "rate_limit_exceeded" ||
      errCtx.type === "rate_limit_exceeded" ||
      /rate limit/i.test(errCtx.message ?? "");
      
    if (isRateLimit) {
      // Handle rate limit error
      const errorDetails = [
        `Status: ${status || "unknown"}`,
        `Code: ${errCtx.code || "unknown"}`,
        `Type: ${errCtx.type || "unknown"}`,
        `Message: ${errCtx.message || "unknown"}`,
      ].join(", ");
      
      onItem({
        id: `error-${Date.now()}`,
        type: "message",
        role: "system",
        content: [
          {
            type: "input_text",
            text: `⚠️  Rate limit reached. Error details: ${errorDetails}. Please try again later.`,
          },
        ],
      });
      onLoading(false);
      return true;
    }
    
    const isClientError =
      (typeof status === "number" &&
        status >= 400 &&
        status < 500 &&
        status !== 429) ||
      errCtx.code === "invalid_request_error" ||
      errCtx.type === "invalid_request_error";
      
    if (isClientError) {
      // Handle client error (400-range)
      const reqId =
        (errCtx as Partial<{
          request_id?: string;
          requestId?: string;
        }>)?.request_id ??
        (errCtx as Partial<{
          request_id?: string;
          requestId?: string;
        }>)?.requestId;
        
      const errorDetails = [
        `Status: ${status || "unknown"}`,
        `Code: ${errCtx.code || "unknown"}`,
        `Type: ${errCtx.type || "unknown"}`,
        `Message: ${errCtx.message || "unknown"}`,
      ].join(", ");
      
      onItem({
        id: `error-${Date.now()}`,
        type: "message",
        role: "system",
        content: [
          {
            type: "input_text",
            text: `⚠️  OpenAI rejected the request${
              reqId ? ` (request ID: ${reqId})` : ""
            }. Error details: ${errorDetails}. Please verify your settings and try again.`,
          },
        ],
      });
      onLoading(false);
      return true;
    }
    
    return false;
  }
  
  /**
   * Get the API key for OpenAI from environment variables or config
   */
  getApiKey(configApiKey?: string): string {
    return configApiKey ?? process.env["OPENAI_API_KEY"] ?? "";
  }
  
  /**
   * Helper method to prepare tool definitions for OpenAI
   */
  private prepareTools(tools: Array<ModelTool>): Array<any> {
    // If no tools were provided, return the default shell tool
    if (tools.length === 0) {
      return [{
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
      }];
    }
    
    // Otherwise, convert the provided tools to OpenAI's format
    return tools.map(tool => {
      if (tool.name === "shell") {
        // Use our predefined shell tool definition
        return {
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
        };
      }
      
      // Convert a generic tool to OpenAI's format
      return {
        type: "function",
        name: tool.name,
        description: tool.description || "",
        parameters: tool.parameters || {},
      };
    });
  }
}