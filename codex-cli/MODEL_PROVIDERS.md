# Model Provider Architecture in Codex CLI

This document describes the modular architecture used to support multiple model providers in Codex CLI.

## Overview

Codex CLI uses a pluggable provider architecture to support multiple AI model providers. Each provider implements the `ModelProviderInterface`, which defines how the agent loop communicates with different AI models.

The key benefits of this architecture are:
- **Provider-agnostic agent loop**: The main agent loop doesn't need to know the specific details of each provider's API
- **Easy extensibility**: New providers can be added by implementing the interface
- **Consistent behavior**: All providers can be used interchangeably with the same core functionality

## Provider Interface

The core interface that all providers must implement:

```typescript
export interface ModelProviderInterface {
  provider: ModelProvider;
  
  // Main message sending method
  sendMessage(
    input: Array<ResponseInputItem>,
    options: {
      reasoning?: unknown;
      system?: string;
      temperature?: number;
      previousResponseId?: string;
      conversationId?: string;
      thinking?: { budgetTokens: number };
    },
  ): Promise<{
    items: Array<ResponseItem>;
    response_id: string;
  }>;
  
  // Optional method to determine if a response requires additional tool processing
  requiresToolProcessing?(response: {
    items: Array<ResponseItem>;
    response_id: string;
  }): boolean;
}
```

## Provider Registry

The provider registry is a singleton that manages provider implementations and helps with:
- Registering provider factories
- Detecting which provider to use based on model name
- Creating provider instances with the correct configuration

```typescript
providerRegistry.registerProvider(
  ModelProvider.ANTHROPIC,
  createAnthropicProvider,
  [/^claude/, /anthropic/] // Model name patterns for Anthropic
);
```

## Tool Processing Flow

Different providers handle tool/function calls differently. For example:
- **OpenAI**: Handles the complete tool use cycle on their side
- **Anthropic**: Requires the agent to explicitly send tool results back to continue the conversation

The `requiresToolProcessing` method allows each provider to tell the agent loop whether a response needs additional tool processing before continuing. This allows the agent loop to remain provider-agnostic while still handling the specific needs of each provider.

## Available Providers

Currently, Codex CLI supports:

1. **OpenAI** - Uses the OpenAI Responses API
   - API Key: `OPENAI_API_KEY`
   - Models: All models supported by the Responses API (e.g., `gpt-4`, `o4-mini`)

2. **Anthropic** - Uses the Anthropic Messages API 
   - API Key: `ANTHROPIC_API_KEY`
   - Models: Claude models (e.g., `claude-3-sonnet`, `claude-3-7-sonnet-20250219`)

## Adding a New Provider

To add a new provider:

1. Create a new file in `src/utils/model-providers/`
2. Implement the `ModelProviderInterface`
3. Register the provider with the registry
4. Update the model detection patterns

## Best Practices

When modifying the provider architecture:

1. Keep provider-specific behavior encapsulated in the provider implementations
2. Maintain a provider-agnostic approach in the agent loop
3. Use the provider registry for consistent provider creation and detection
4. Add thorough logging for debugging provider-specific issues