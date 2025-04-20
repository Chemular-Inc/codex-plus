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
    
    // Prepare reasoning for Opus models (o1/o2/o3/o4)
    let reasoning: Reasoning | undefined;
    if (request.model.startsWith("o")) {
      reasoning = { effort: "high" };
      if (request.model === "o3" || request.model === "o4-mini") {
        reasoning.summary = "auto";
      }
    }
    
    try {
      // Convert the input to ResponseInputItems
      // The request.messages are our internal format, but we need to pass ResponseInputItems to the OpenAI API
      const input = request.extras && 'input' in request.extras ? request.extras['input'] : [];
      
      // Create options object with only supported parameters per model
      const options: Record<string, any> = {
        model: request.model,
        instructions: mergedInstructions,
        stream: true,
        parallel_tool_calls: false,
        tools,
      };
      
      // Add reasoning parameter only for Opus models
      if (reasoning) {
        options['reasoning'] = reasoning;
      }
      
      // Add temperature only for non-Opus models that support it
      if (this.modelSupportsTemperature(request.model)) {
        options['temperature'] = this.getModelSpecificTemperature(request.model, request.temperature);
      }
      
      // Handle previous_response_id regardless of input
      if (request.extras && 'previous_response_id' in request.extras) {
        const respId = request.extras['previous_response_id'] as string || '';
        
        console.error(`PROVIDER received previous_response_id: ${respId}`);
        
        // OpenAI requires response IDs to start with 'resp'
        if (typeof respId === 'string' && respId.startsWith('resp_')) {
          options['previous_response_id'] = respId;
          console.error(`Using previous_response_id: ${respId}`);
        } else if (typeof respId === 'string' && respId.startsWith('resp')) {
          options['previous_response_id'] = respId;
          console.error(`Using previous_response_id: ${respId}`);
        } else {
          console.error(`WARNING: Invalid previous_response_id format: ${respId} (should start with 'resp')`);
          
          // Try to create a valid ID by adding a prefix
          const fixedId = `resp_${respId}`;
          console.error(`Attempting with fixed ID: ${fixedId}`);
          options['previous_response_id'] = fixedId;
        }
      }
      
      // Add input array (even if empty)
      options['input'] = input;
      
      // Diagnostic logging for function call outputs
      for (const item of input as Array<Record<string, any>>) {
        if (typeof item === 'object' && item && 'type' in item && item['type'] === 'function_call_output') {
          console.error(`OPENAI PROVIDER - function_call_output in input: call_id=${item['call_id']}`);
        } else if ('function_call' in item) {
          console.error(`OPENAI PROVIDER - function_call in input`);
        }
      }
      
      if (isLoggingEnabled()) {
        log(`OpenAI request options: ${JSON.stringify(options, null, 2)}`);
      }
      
      // Use the responses API which provides more detailed events
      // Use the rate limiter to prevent hitting API limits
      let stream;
      try {
        stream = await import('../rate-limiter-lite.js').then(({ rateLimited }) =>
          rateLimited('openai', () => this.oai.responses.create(options as any))
        );
      } catch (error) {
        if (
          error && 
          typeof error === 'object' &&
          'response' in error && 
          error.response && 
          typeof error.response === 'object' &&
          'data' in error.response && 
          error.response.data && 
          typeof error.response.data === 'object' &&
          'code' in error.response.data &&
          error.response.data.code === 'previous_response_not_found'
        ) {
          log(`Previous response not found (${error.response.data.code}). Clearing previous_response_id and retrying.`);
          delete options['previous_response_id'];
          stream = await import('../rate-limiter-lite.js').then(({ rateLimited }) =>
            rateLimited('openai', () => this.oai.responses.create(options as any))
          );
        } else {
          throw error;
        }
      }
      
      // Process the stream and normalize to our ChatDelta format
      // TypeScript fix: assert that stream has Symbol.asyncIterator
      const asyncIterable = stream as unknown as AsyncIterable<any>;
      for await (const event of asyncIterable) {
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
            
            // Extract the call ID - critical for matching with function_call_output
            const callId = (item as any).call_id || (item as any).id;
            
            if (isLoggingEnabled()) {
              log(`Received function_call with ID: ${callId}`);
            }
            
            // Copy all properties to a plain object
            Object.entries(item).forEach(([key, value]) => {
              plainObject[key] = value;
            });
            
            // Always include BOTH id and call_id properties for maximum compatibility
            // This ensures the agent loop will have a valid ID to use
            plainObject['id'] = callId;
            plainObject['call_id'] = callId;
            
            if (isLoggingEnabled()) {
              log(`Emitting tool call with ID: ${callId}`);
            }
            
            yield { kind: "toolCall", call: plainObject };
          }
        }
        
        if (event.type === "response.completed") {
          // Pass along the OpenAI response ID - critical for chaining
          const responseId = event.response?.id;
          if (responseId) {
            console.error(`OpenAI completed response with ID: ${responseId}`);
            yield { kind: "done", responseId };
          } else {
            yield { kind: "done" };
          }
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
      // Extract the call ID - CRITICAL for matching with function_call_output
      // In OpenAI responses API, the ID can be either in call_id (preferred) or id fields
      const callId = (item as any).call_id || (item as any).id;
      
      console.error(`\n\n*** CALL ID CHECK ***`);
      console.error(`Processing function call:`);
      console.error(`- Item type: ${item.type}`);
      console.error(`- Raw call_id: ${(item as any).call_id}`);
      console.error(`- Raw id: ${(item as any).id}`);
      console.error(`- Using call ID: ${callId}`);
      
      // Copy the entire item to a new object to avoid type issues
      // This ensures we aren't modifying the original item
      const functionCallItem = JSON.parse(JSON.stringify(item));
      
      // ALWAYS explicitly set both call_id and id fields
      // OpenAI may be expecting a specific format for the call ID
      functionCallItem.call_id = callId;
      functionCallItem.id = callId;
      
      // Handle the function call
      const result = await handleFunctionCall(functionCallItem);
      
      // Final verification that ALL function_call_output items have the EXACT same call_id
      // This is absolutely critical for OpenAI to match function calls with their outputs
      const finalResults = result.map(outputItem => {
        if (outputItem.type === "function_call_output") {
          console.error(`Function call output before fix: call_id=${outputItem.call_id}`);
          
          // Always force the exact same call_id from the original function call
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
      console.error(`Error in processToolCall: ${error}`);
      
      // Get the call ID for the error response
      const callId = (item as any).call_id || (item as any).id;
      
      if (!callId) {
        console.error(`WARNING: No call_id found in function call item`);
      }
      
      // Create an error response with the correct call_id
      return [{
        type: "function_call_output",
        call_id: callId,
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
      // For now, just surface the error to the user
      // In the agent-loop.ts, the retry logic is handled with exponential backoff
      // This could be improved to parse suggested retry times from the error message
      const errorDetails = [
        `Status: ${status || "unknown"}`,
        `Code: ${errCtx.code || "unknown"}`,
        `Type: ${errCtx.type || "unknown"}`,
        `Message: ${errCtx.message || "unknown"}`,
      ].join(", ");
      
      // Check if the error message contains a suggested retry time
      const msg = errCtx?.message ?? "";
      const retryMatch = /(?:retry|try) again in ([\d.]+)s/i.exec(msg);
      if (retryMatch && retryMatch[1]) {
        const suggestedRetrySeconds = parseFloat(retryMatch[1]);
        if (!Number.isNaN(suggestedRetrySeconds)) {
          // Log the suggested retry time - the agent loop will handle actual retries
          log(`Rate limit error with suggested retry time: ${suggestedRetrySeconds}s`);
        }
      }
      
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
   * Check if a given model supports the temperature parameter
   * Some models like the Opus line (o1/o2/o3/o4) don't support temperature
   */
  private modelSupportsTemperature(model: string): boolean {
    // Opus models don't support temperature
    if (model.startsWith("o")) {
      return false;
    }
    
    // All other models should support temperature
    return true;
  }
  
  /**
   * Get model-specific temperature settings
   * Different models may benefit from different default temperature settings
   * 
   * Note: Some models (like o1/o2/o3/o4) don't support the temperature parameter at all
   * This method should only be called for models that support temperature
   */
  private getModelSpecificTemperature(model: string, requestTemperature?: number): number {
    // If a specific temperature was requested, use that
    if (requestTemperature !== undefined) {
      return requestTemperature;
    }
    
    // Model-specific default temperatures
    if (model.includes("gpt-4")) {
      // Use a moderate temperature for GPT-4 family
      return 0.7;
    } else if (model.includes("gpt-3.5")) {
      // Use a slightly higher temperature for GPT-3.5 for more variety
      return 0.8;
    }
    
    // Default fallback for any other models
    return 0.7;
  }

  /**
   * Helper method to prepare tool definitions for OpenAI
   * Uses a consistent tool definition that matches the original agent-loop implementation
   */
  private prepareTools(_tools: Array<ModelTool>): Array<any> {
    // We always return the same shell tool definition regardless of input
    // This ensures compatibility with the original agent-loop implementation
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
    
    // Note: The original implementation only supported the shell tool
    // If we need to support multiple tools in the future, we can expand this method
  }
}