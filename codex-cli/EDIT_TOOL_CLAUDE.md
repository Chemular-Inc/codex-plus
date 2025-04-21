# Anthropic Claude Code Edit Tool Integration

## Overview

Claude 3.7 includes a new tool specifically designed for code editing operations. This is highly relevant for our codex-cli tool as it allows Claude to perform more precise code manipulations. We need to implement support for this specialized tool in our Anthropic provider.

## Requirements

1. Integrate the Claude code editing tool into the Anthropic provider
2. Update the tool definitions to include the code editing capabilities
3. Implement proper handling of the code edit tool results
4. Add appropriate tests for the new functionality

## Claude Code Edit Tool Specification

The tool definition should follow this format:

```json
{
  "name": "code_edit", 
  "description": "Edit code files with specified operations",
  "input_schema": {
    "type": "object",
    "properties": {
      "file_path": {
        "type": "string",
        "description": "Path to the file to edit"
      },
      "operation": {
        "type": "string",
        "enum": ["insert", "replace", "delete"],
        "description": "Type of edit operation"
      },
      "position": {
        "type": "object",
        "description": "Where to apply the edit",
        "properties": {
          "start_line": {
            "type": "integer",
            "description": "Start line number (1-indexed)"
          },
          "end_line": {
            "type": "integer",
            "description": "End line number (1-indexed)"
          }
        },
        "required": ["start_line"]
      },
      "content": {
        "type": "string",
        "description": "New content for insert/replace operations"
      }
    },
    "required": ["file_path", "operation", "position"]
  }
}
```

## Implementation Steps

1. Add the code_edit tool definition to the Anthropic provider
2. Implement translation between Claude's code_edit tool format and our internal representation
3. Test the integration with real code editing scenarios
4. Ensure proper error handling and reporting

## Examples

Sample code_edit tool use from Claude:
```json
{
  "type": "tool_use",
  "id": "toolu_01AbCdEfGhIjKlMnOpQrStUv",
  "name": "code_edit",
  "input": {
    "file_path": "/path/to/file.js",
    "operation": "replace",
    "position": {
      "start_line": 10,
      "end_line": 15
    },
    "content": "// New code to replace the original lines\nfunction improvedFunction() {\n  return 'better implementation';\n}"
  }
}
```

Expected result (successful edit):
```json
{
  "type": "tool_result",
  "tool_use_id": "toolu_01AbCdEfGhIjKlMnOpQrStUv",
  "content": "Successfully edited file.js, replaced lines 10-15."
}
```

Expected result (failed edit):
```json
{
  "type": "tool_result",
  "tool_use_id": "toolu_01AbCdEfGhIjKlMnOpQrStUv",
  "content": "Failed to edit file: File not found or permission denied.",
  "is_error": true
}
```