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
    // For debugging - always log API requests when using Claude 3.7
    const isClaude37 = request.model.includes("claude-3-7") || request.model.includes("claude-3.7");
    
    if (isLoggingEnabled()) {
      log(`AnthropicProvider.stream: Streaming from model ${request.model}`);
      log(`AnthropicProvider.stream: Claude version check - isClaude37=${isClaude37}`);
    }
    
    if (isClaude37) {
      console.error(`[DEBUG] Using Claude 3.7: ${request.model}`);
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
      
      // Keep track of previous messages for the conversation history
      const previousMessages: Array<{role: string, content: any[]}> = [];
      let lastToolUseId: string | null = null;
      
      // First scan to check if we're sending multiple tool results for the same tool
      for (const msg of request.messages) {
        if ((msg as any).tool_result === true && (msg as any).call_id) {
          if (lastToolUseId === (msg as any).call_id) {
            console.error(`[WARNING] Multiple tool results for the same tool ID: ${(msg as any).call_id} - Claude may get confused`);
          }
          lastToolUseId = (msg as any).call_id;
        }
      }
      
      // Convert chat messages to Anthropic format
      for (const msg of request.messages) {
        // Convert to Anthropic's role format
        const role = msg.role === "system" ? "user" : msg.role;
        
        // Check if this is a duplicate of the previous message (prevent message loops)
        const isDuplicate = previousMessages.length > 0 && 
                          previousMessages[previousMessages.length - 1].role === role &&
                          JSON.stringify(previousMessages[previousMessages.length - 1].content) === 
                          JSON.stringify([{ type: "text", text: msg.content }]);
        
        if (isDuplicate && isClaude37) {
          console.error(`[DEBUG] Claude 3.7: Skipping duplicate message with role=${role}`);
          continue;
        }
        
        // Check if this message contains our tool_result flag
        if ((msg as any).tool_result === true && 
            (msg as any).call_id && 
            (msg as any).output) {
          
          // This is a tool result that needs special formatting for Claude
          if (isLoggingEnabled()) {
            log(`AnthropicProvider: Converting tool_result message to Claude format`);
          }
          
          try {
            // Parse the output - may be JSON with output and metadata fields
            const outputStr = (msg as any).output;
            let outputContent = outputStr;
            
            // For Claude 3.7, we need very specific formatting based on the tool used
            if (isClaude37) {
              console.error(`[DEBUG] Claude 3.7: Processing tool result for call_id=${(msg as any).call_id}`);
              console.error(`[DEBUG] Claude 3.7: Raw output=${outputStr}`);
            }
            
            // Try to parse as JSON if it's a JSON string
            if (typeof outputStr === 'string' && outputStr.trim().startsWith('{')) {
              try {
                const parsed = JSON.parse(outputStr);
                
                // For shell commands, we need to extract command.stdout specifically
                if (parsed.output && (msg as any).name === 'shell') {
                  // Extract the exact command output for a shell command
                  const commandOutput = parsed.output;
                  
                  // Format exactly as Claude expects for shell commands 
                  outputContent = commandOutput;
                  
                  if (isClaude37) {
                    console.error(`[DEBUG] Claude 3.7: Extracted shell command output: ${outputContent.substring(0, 100)}...`);
                  }
                } else {
                  // Use the output field if available, otherwise use the whole thing
                  outputContent = parsed.output || outputStr;
                }
              } catch (e) {
                // Not valid JSON, use the string as-is
                if (isClaude37) {
                  console.error(`[DEBUG] Claude 3.7: Failed to parse JSON: ${e}`);
                }
                outputContent = outputStr;
              }
            }
            
            // Create a message with tool_result content block according to Claude's spec
            // NOTE: Claude requires this exact format with tool_use_id matching the original tool call
            const toolResultMessage = {
              role: "user",
              content: [
                {
                  type: "tool_result", 
                  tool_use_id: (msg as any).call_id,
                  content: outputContent,
                  // According to Anthropic documentation, we need to explicitly flag errors
                  // This helps Claude understand when a tool call has failed
                  ...(typeof outputContent === 'string' && 
                      (outputContent.toLowerCase().includes('error') || 
                       outputContent.toLowerCase().includes('not found') || 
                       outputContent.toLowerCase().includes('failed')) 
                    ? { is_error: true }
                    : {})
                }
              ]
            };
            
            messages.push(toolResultMessage);
            previousMessages.push(toolResultMessage);
            
            // According to Anthropic docs, we should NOT add an extra message after tool results
            // Claude 3.7's model is designed to continue automatically when provided with proper tool_result format
            
            console.error(`[DEBUG] Claude 3.7: Added tool_result message for call_id=${(msg as any).call_id}`);
            console.error(`[DEBUG] Claude 3.7: Tool result message: ${JSON.stringify(toolResultMessage)}`);
            // NO additional message after tool_result - this was causing the infinite loop
          } catch (e) {
            // If anything goes wrong, fall back to simple format
            const fallbackMessage = {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: (msg as any).call_id,
                  content: (msg as any).output
                }
              ]
            };
            
            messages.push(fallbackMessage);
            previousMessages.push(fallbackMessage);
          }
        } else {
          // Regular message, just add it normally
          const regularMessage = {
            role: role as "user" | "assistant",
            content: [
              { type: "text", text: msg.content }
            ]
          };
          
          messages.push(regularMessage);
          previousMessages.push(regularMessage);
          
          if (isClaude37) {
            console.error(`[DEBUG] Claude 3.7: Added regular message with role=${role}`);
          }
        }
      }
      
      // Prepare tools if provided
      const tools: Array<Anthropic.Tool> = [];
      
      if (request.tools && request.tools.length > 0) {
        // Always add shell tool
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
        
        // Add the proper str_replace_editor tool based on Anthropic documentation
        tools.push({
          name: "str_replace_editor",
          description: "Edit text files using commands like view, str_replace, create, and insert.",
          input_schema: {
            type: "object",
            properties: {
              command: {
                type: "string",
                enum: ["view", "str_replace", "create", "insert", "undo_edit"],
                description: "The operation to perform"
              },
              path: {
                type: "string",
                description: "The absolute path to the file or directory"
              },
              view_range: {
                type: "array",
                items: {
                  type: "integer",
                },
                description: "Optional range of lines to view [start, end] (for view command)"
              },
              file_text: {
                type: "string",
                description: "The content to write to the file (for create command)"
              },
              old_str: {
                type: "string",
                description: "The text to be replaced (for str_replace command)"
              },
              new_str: {
                type: "string",
                description: "The replacement text (for str_replace and insert commands)"
              },
              insert_line: {
                type: "integer",
                description: "The line number to insert text at (for insert command)"
              }
            },
            required: ["command", "path"]
          }
        });
      }
      
      // Create message parameters for Anthropic API
      const params: Anthropic.MessageCreateParams = {
        model: request.model,
        max_tokens: 4096,
        messages,
        stream: true,
      };
      
      // Add tools if available - with correct tool_choice format
      if (tools.length > 0) {
        // Check if this is a Claude 3.7 model
        const isClaude37 = request.model.includes("claude-3-7") || request.model.includes("claude-3.7");
        
        // Add tools to params
        params.tools = tools;
        
        // According to Anthropic docs, tool_choice can be one of:
        // - "auto" (default): Claude decides whether to use provided tools
        // - "any": Claude must use one of the provided tools
        // - {"type": "tool", "name": "TOOL_NAME"}: Forces Claude to use a specific tool
        // - "none": Prevents Claude from using any tools
        
        // The error suggests we need to use an object format for tool_choice
        if (isLoggingEnabled()) {
          log(`AnthropicProvider: Setting tool_choice as object for ${isClaude37 ? 'Claude 3.7' : 'Claude'}`);
        }
        
        // Use object format for tool_choice auto
        params.tool_choice = { type: "auto" };
        
        if (isLoggingEnabled()) {
          // Log the request for debugging
          const debugRequestInfo = JSON.stringify(params, null, 2);
          log(`AnthropicProvider: Full request params: ${debugRequestInfo}`);
        }
      }
      
      // Add temperature if provided
      if (request.temperature !== undefined) {
        params.temperature = request.temperature;
      }
      
      // Add system prompt based on the model
      if (request.model.includes("claude-3-7") || request.model.includes("claude-3.7")) {
        // Claude 3.7-specific system prompt based on Anthropic's documentation guidance
        params.system = 
          "You are Claude 3.7, a helpful AI assistant integrated with a CLI tool called Codex. " + 
          "You have access to tools for viewing files and executing commands. " +
          "CRITICAL INSTRUCTION: " +
          "1. When you use a tool and receive results, you MUST incorporate that information and continue the conversation. " +
          "2. You should NOT send additional tool messages in sequence without processing the previous tool results. " +
          "3. If you request a tool action, wait for the results and use them to inform your next response. " +
          "4. Provide complete, helpful responses that incorporate information from tool results. " +
          "5. Only make additional tool calls when necessary to answer the user's question or complete their request.";
      } else {
        // Default Claude system prompt
        params.system = "You are Claude, a helpful AI assistant integrated with a CLI tool. You can use tools to help the user.";
      }
      
      if (isLoggingEnabled()) {
        log(`AnthropicProvider.stream: params = ${JSON.stringify(params, null, 2)}`);
      }
      
      // Enhanced logging for all Claude 3.7 requests
      if (isClaude37) {
        console.error(`[DEBUG] Claude 3.7 request params: ${JSON.stringify({ 
          model: params.model, 
          tools: params.tools?.map(t => t.name),
          tool_choice: params.tool_choice,
          message_count: messages.length
        }, null, 2)}`);
        console.error(`[DEBUG] Claude 3.7 message count: ${messages.length}`);
        
        // Log message roles and types to detect patterns
        const messageInfo = messages.map(m => {
          const contentTypes = (m.content || []).map((c: any) => c.type).join(',');
          return `${m.role}:${contentTypes}`;
        }).join(" → ");
        console.error(`[DEBUG] Claude 3.7 message flow: ${messageInfo}`);
        
        // Check if we have any tool_result messages
        const toolResultCount = messages.filter(m => 
          m.content && m.content.some((c: any) => c.type === 'tool_result')
        ).length;
        console.error(`[DEBUG] Claude 3.7 tool_result messages: ${toolResultCount}`);
        
        // Check for potential loop triggers based on Anthropic's docs
        if (messages.length >= 4) {
          // Pattern: tool_use → tool_result → tool_use → tool_result without assistant responses
          const lastMessages = messages.slice(-4);
          const toolUseFollowedByResult = lastMessages.some((m, i) => {
            if (i < lastMessages.length - 1) {
              const currentIsAssistant = m.role === 'assistant';
              const nextIsToolResult = lastMessages[i+1].role === 'user' && 
                lastMessages[i+1].content && 
                lastMessages[i+1].content.some((c: any) => c.type === 'tool_result');
              
              return currentIsAssistant && nextIsToolResult;
            }
            return false;
          });
          
          if (toolUseFollowedByResult) {
            console.error(`[DEBUG] Claude 3.7 WARNING: Tool use followed immediately by another tool use detected!`);
          }
        }
      }
      
      // Create the message stream
      const stream = await this.anthropic.messages.create(params);
      
      if (isClaude37) {
        console.error(`[DEBUG] Claude 3.7 stream created successfully`);
      }
      
      // Variables to track the current state
      // This maintains the current tool use being constructed from stream events
      let currentToolUse: { 
        id: string; 
        name: string; 
        input: any;
        partialJson?: string;
      } | null = null;
      
      // This accumulates text content
      let contentBuffer = "";
      
      // This stores the message ID for the response
      let messageId = "";
      
      if (isClaude37) {
        console.error(`[DEBUG] Claude 3.7 beginning to process stream events`);
      }
      
      // Process the stream
      try {
        if (isLoggingEnabled()) {
          log(`AnthropicProvider: Starting to process stream events`);
        }
        
        // TypeScript fix: assert that stream has Symbol.asyncIterator as in OpenAI implementation
        const asyncIterable = stream as unknown as AsyncIterable<any>;
        
        if (isClaude37) {
          console.error(`[DEBUG] Claude 3.7 beginning for-await loop`);
        }
        
        let eventCount = 0;
        for await (const event of asyncIterable) {
          eventCount++;
          
          if (isClaude37) {
            console.error(`[DEBUG] Claude 3.7 event #${eventCount}: ${event.type}`);
            console.error(`[DEBUG] Claude 3.7 event data: ${JSON.stringify(event, null, 2)}`);
          }
          
          if (isLoggingEnabled()) {
            log(`AnthropicProvider: Event received: ${event.type}`);
          }
          
          // Type assertion for specific event types
          if (event.type === "content_block_delta") {
            // Cast to avoid TypeScript errors
            const delta = event.delta as any;
            
            if (delta && delta.type === "text_delta" && typeof delta.text === "string") {
              // Text content
              contentBuffer += delta.text;
              
              if (isLoggingEnabled()) {
                log(`AnthropicProvider: Text content: "${delta.text}"`);
              }
              
              yield { kind: "content", text: delta.text };
            } else if (delta && delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
              // Process tool call JSON deltas - Claude sends these incrementally
              if (currentToolUse && delta.partial_json) {
                // Initialize partial JSON accumulator if needed
                if (!currentToolUse.partialJson) {
                  currentToolUse.partialJson = '';
                }
                
                // Add this fragment to our accumulated JSON
                currentToolUse.partialJson += delta.partial_json;
                
                // Only attempt parsing if we have what looks like complete JSON
                if (currentToolUse.partialJson.includes("}")) {
                  try {
                    // Ensure we have valid JSON structure before parsing
                    const jsonString = currentToolUse.partialJson.replace(/^{/, '{').replace(/}$/, '}');
                    const parsedInput = JSON.parse(jsonString);
                    
                    // Update the tool input with the parsed data
                    currentToolUse.input = parsedInput;
                    
                    if (isClaude37) {
                      console.error(`[DEBUG] Claude 3.7 parsed tool input: ${JSON.stringify(parsedInput)}`);
                    }
                  } catch (e) {
                    // Not complete/valid JSON yet - we'll keep accumulating
                    if (isClaude37 && isLoggingEnabled()) {
                      log(`AnthropicProvider: JSON still accumulating: ${currentToolUse.partialJson}`);
                    }
                  }
                }
              }
            } else {
              if (isLoggingEnabled()) {
                log(`AnthropicProvider: Unhandled content_block_delta: ${JSON.stringify(delta)}`);
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
                log(`AnthropicProvider: Stream complete with stop_reason=${event.delta.stop_reason}, yielding done event with messageId: ${messageId}`);
              }
              
              // Handle different stop reasons
              if (event.delta.stop_reason === "tool_use" && currentToolUse) {
                // Claude 3.7 stops with "tool_use" when it wants to execute a tool
                if (isLoggingEnabled()) {
                  log(`AnthropicProvider: Received tool_use stop_reason with tool: ${currentToolUse.name}`);
                }
                
                // Process arguments for tool compatibility
                let processedArgs = currentToolUse.input;
                
                // Ensure shell commands are in the format expected by our tools
                if (currentToolUse.name === "shell" && processedArgs && processedArgs.command) {
                  if (typeof processedArgs.command === 'string') {
                    processedArgs = {
                      ...processedArgs,
                      command: processedArgs.command.split(' ')
                    };
                  }
                }
                
                // Create a standardized tool call format for the agent loop
                const toolCall = {
                  type: "function_call",
                  id: currentToolUse.id,
                  call_id: currentToolUse.id,
                  name: currentToolUse.name,
                  arguments: JSON.stringify(processedArgs),
                  status: "incomplete" // Mark as incomplete since Claude will need a follow-up
                };
                
                // First emit the tool call
                if (isLoggingEnabled()) {
                  log(`AnthropicProvider: Emitting toolCall for Claude: ${currentToolUse.name}`);
                }
                
                yield { kind: "toolCall", call: toolCall };
                
                // Then emit done with special stop reason so the agent loop knows Claude needs a follow-up
                yield { 
                  kind: "done", 
                  responseId: messageId,
                  stopReason: "tool_use"  // This special stopReason will be handled in agent-loop
                };
              } else {
                // Standard completion - normal response end
                yield { 
                  kind: "done", 
                  responseId: messageId,
                  stopReason: event.delta.stop_reason 
                };
              }
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
              // Process arguments specially for shell command to ensure compatibility
              let processedArgs = currentToolUse.input;
              
              // Convert the shell command input format for compatibility
              if (currentToolUse.name === "shell" && processedArgs && processedArgs.command) {
                // Claude 3.7 may return command as a single string - convert to array if needed
                if (typeof processedArgs.command === 'string') {
                  processedArgs = {
                    ...processedArgs,
                    command: processedArgs.command.split(' ')
                  };
                }
              }
              
              // No need to convert file_editor to str_replace_editor anymore,
              // as we're using the correct name (str_replace_editor) from the start
              
              // Ensure the tool call is in the expected format with the right fields
              if (currentToolUse.name === "str_replace_editor") {
                // Check if we need to convert format
                if (currentToolUse.input && !currentToolUse.input.command && 
                    (currentToolUse.input.operation || currentToolUse.input.content)) {
                  // Convert from old format to correct str_replace_editor format
                  const newInput: any = {
                    path: currentToolUse.input.path
                  };
                  
                  // Map operation to command
                  if (currentToolUse.input.operation === "view") {
                    newInput.command = "view";
                  } else if (currentToolUse.input.operation === "edit") {
                    newInput.command = "str_replace";
                    newInput.old_str = ""; // Will need to be filled by actual text
                    newInput.new_str = currentToolUse.input.content || "";
                  } else if (currentToolUse.input.operation === "create") {
                    newInput.command = "create";
                    newInput.file_text = currentToolUse.input.content || "";
                  }
                  
                  // Update the input
                  currentToolUse.input = newInput;
                  
                  if (isLoggingEnabled()) {
                    log(`AnthropicProvider: Converted text editor format: ${JSON.stringify(currentToolUse.input)}`);
                  }
                }
              }
              
              // Use the same structure as OpenAI for maximum compatibility
              const toolCall = {
                type: "function_call",
                id: currentToolUse.id,
                call_id: currentToolUse.id,
                name: currentToolUse.name,
                arguments: JSON.stringify(processedArgs),
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
          if (isClaude37) {
            console.error(`[DEBUG] Claude 3.7 stream ended with eventCount=${eventCount}, no messageId`);
            console.error(`[DEBUG] Claude 3.7 contentBuffer="${contentBuffer}"`);
          }
          
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
      } catch (streamError) {
        log(`Error processing Anthropic stream events: ${streamError}`);
        
        if (isClaude37) {
          console.error(`[DEBUG] Claude 3.7 stream processing error: ${streamError}`);
          console.error(`[DEBUG] Claude 3.7 error details: ${JSON.stringify(streamError, null, 2)}`);
          console.error(`[DEBUG] Claude 3.7 stack trace: ${(streamError as any)?.stack || 'No stack trace'}`);
          
          // For Claude 3.7, yield some content if we have it
          if (contentBuffer && contentBuffer.trim().length > 0) {
            console.error(`[DEBUG] Claude 3.7 yielding content buffer on error: "${contentBuffer}"`);
            yield { kind: "content", text: contentBuffer };
          } else {
            console.error(`[DEBUG] Claude 3.7 no content buffer to yield on error`);
            // Yield minimal content to prevent hanging
            yield { kind: "content", text: "I encountered an error processing your request." };
          }
        }
        
        // Make sure we yield a done event even on error, so the client doesn't hang
        yield { 
          kind: "done", 
          responseId: `anthropic-error-${Date.now()}`
        };
        
        // Log but don't rethrow for Claude 3.7 to prevent crashes
        if (isClaude37) {
          console.error(`[DEBUG] Claude 3.7 suppressing error throw to prevent crash`);
        } else {
          throw streamError;
        }
      }
    } catch (error) {
      log(`Error streaming from Anthropic: ${error}`);
      
      if (isClaude37) {
        console.error(`[DEBUG] Claude 3.7 outer error: ${error}`);
        console.error(`[DEBUG] Claude 3.7 outer error details: ${JSON.stringify(error, null, 2)}`);
        console.error(`[DEBUG] Claude 3.7 outer stack trace: ${(error as any)?.stack || 'No stack trace'}`);
        
        // Yield minimal content to prevent hanging
        yield { kind: "content", text: "I encountered an error communicating with the Anthropic API." };
        yield { kind: "done", responseId: `anthropic-outer-error-${Date.now()}` };
      } else {
        throw error;
      }
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
      
      // We're now consistently using str_replace_editor, but handle any older format conversions
      if (toolCallItem.name === 'str_replace_editor') {
        try {
          const args = typeof toolCallItem.arguments === 'string' 
            ? JSON.parse(toolCallItem.arguments) 
            : toolCallItem.arguments;
            
          // Check if we need to convert from old format to new
          if (args && args.operation && !args.command) {
            // Convert from old format (operation, content) to new format (command, file_text, etc.)
            const newArgs: any = {
              path: args.path
            };
            
            // Map operation to command
            if (args.operation === "view") {
              newArgs.command = "view";
            } else if (args.operation === "edit") {
              newArgs.command = "str_replace";
              newArgs.old_str = ""; // This will be problematic without actual text
              newArgs.new_str = args.content || "";
            } else if (args.operation === "create") {
              newArgs.command = "create";
              newArgs.file_text = args.content || "";
            }
            
            // Update the arguments
            toolCallItem.arguments = JSON.stringify(newArgs);
            
            if (isLoggingEnabled()) {
              log(`AnthropicProvider.processToolCall: Converted str_replace_editor args format: ${JSON.stringify(newArgs)}`);
            }
          }
        } catch (e) {
          // If parsing fails, leave as is
          if (isLoggingEnabled()) {
            log(`AnthropicProvider.processToolCall: Error parsing str_replace_editor args: ${e}`);
          }
        }
      }
      
      // File editor name mapping would have been here, but we're now using str_replace_editor directly
      
      // Handle shell tool arguments format
      if (toolCallItem.name === 'shell' && toolCallItem.arguments) {
        try {
          const argsObj = typeof toolCallItem.arguments === 'string' 
            ? JSON.parse(toolCallItem.arguments) 
            : toolCallItem.arguments;
            
          // Fix command format if it's a string
          if (argsObj.command && typeof argsObj.command === 'string') {
            const fixedArgs = {
              ...argsObj,
              command: argsObj.command.split(' ')
            };
            
            toolCallItem.arguments = JSON.stringify(fixedArgs);
            
            if (isLoggingEnabled()) {
              log(`AnthropicProvider.processToolCall: Fixed shell command format from string to array`);
            }
          }
        } catch (e) {
          // If parsing fails, leave as is
          if (isLoggingEnabled()) {
            log(`AnthropicProvider.processToolCall: Failed to parse arguments: ${e}`);
          }
        }
      }
      
      // Handle the function call
      const result = await handleFunctionCall(toolCallItem);
      
      if (isLoggingEnabled()) {
        log(`AnthropicProvider.processToolCall: handleFunctionCall returned ${result.length} items`);
      }
      
      // For Claude, we need to transform the function_call_output to match Claude's expected format
      // This follows Claude docs where tool results need to be in a user message with tool_result content
      const finalResults = result.map(outputItem => {
        if (outputItem.type === "function_call_output") {
          if (isLoggingEnabled()) {
            log(`AnthropicProvider.processToolCall: Transforming function_call_output to Claude format`);
          }
          
          // Create a modified item that Claude will understand
          const transformedItem = {
            ...outputItem,
            call_id: callId,     // Ensure call_id is set properly
            name: toolCallItem.name, // Include the tool name for better processing
            role: "user",        // Tool results should be in a user message for Claude
            tool_result: true    // Flag to mark this as special tool result for Claude
          };
          
          if (isClaude37) {
            console.error(`[DEBUG] Claude 3.7: Creating tool result for ${toolCallItem.name} with call_id=${callId}`);
          }
          
          return transformedItem;
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
    // Common tool definition that works across all Claude models
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
      // Standard editor tool using the proper Anthropic str_replace_editor format
      {
        type: "function",
        name: "str_replace_editor",
        description: "Edit text files using commands like view, str_replace, create, and insert.",
        parameters: {
          type: "object",
          properties: {
            command: {
              type: "string",
              enum: ["view", "str_replace", "create", "insert", "undo_edit"],
              description: "The operation to perform"
            },
            path: {
              type: "string",
              description: "The absolute path to the file or directory"
            },
            view_range: {
              type: "array",
              items: {
                type: "integer",
              },
              description: "Optional range of lines to view [start, end] (for view command)"
            },
            file_text: {
              type: "string",
              description: "The content to write to the file (for create command)"
            },
            old_str: {
              type: "string",
              description: "The text to be replaced (for str_replace command)"
            },
            new_str: {
              type: "string",
              description: "The replacement text (for str_replace and insert commands)"
            },
            insert_line: {
              type: "integer",
              description: "The line number to insert text at (for insert command)"
            }
          },
          required: ["command", "path"]
        }
      }
    ];
  }
}