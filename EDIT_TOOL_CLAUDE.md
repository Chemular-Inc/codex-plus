Tool use (function calling)
Text editor tool
Claude can use an Anthropic-defined text editor tool to view and modify text files, helping you debug, fix, and improve your code or other text documents. This allows Claude to directly interact with your files, providing hands-on assistance rather than just suggesting changes.

​
Before using the text editor tool
​
Use a compatible model
Anthropic’s text editor tool is only available for Claude 3.5 Sonnet and Claude 3.7 Sonnet:

Claude 3.7 Sonnet: text_editor_20250124
Claude 3.5 Sonnet: text_editor_20241022
Both versions provide identical capabilities - the version you use should match the model you’re working with.

​
Assess your use case fit
Some examples of when to use the text editor tool are:

Code debugging: Have Claude identify and fix bugs in your code, from syntax errors to logic issues.
Code refactoring: Let Claude improve your code structure, readability, and performance through targeted edits.
Documentation generation: Ask Claude to add docstrings, comments, or README files to your codebase.
Test creation: Have Claude create unit tests for your code based on its understanding of the implementation.
​
Use the text editor tool
Provide the text editor tool (named str_replace_editor) to Claude using the Messages API:

Python

Shell

Java

curl https://api.anthropic.com/v1/messages \
 -H "content-type: application/json" \
 -H "x-api-key: $ANTHROPIC_API_KEY" \
 -H "anthropic-version: 2023-06-01" \
 -d '{
"model": "claude-3-7-sonnet-20250219",
"max_tokens": 1024,
"tools": [
{
"type": "text_editor_20250124",
"name": "str_replace_editor"
}
],
"messages": [
{
"role": "user",
"content": "There'\''s a syntax error in my primes.py file. Can you help me fix it?"
}
]
}'
The text editor tool can be used in the following way:

1
Provide Claude with the text editor tool and a user prompt

Include the text editor tool in your API request
Provide a user prompt that may require examining or modifying files, such as “Can you fix the syntax error in my code?”
2
Claude uses the tool to examine files or directories

Claude assesses what it needs to look at and uses the view command to examine file contents or list directory contents
The API response will contain a tool_use content block with the view command
3
Execute the view command and return results

Extract the file or directory path from Claude’s tool use request
Read the file’s contents or list the directory contents and return them to Claude
Return the results to Claude by continuing the conversation with a new user message containing a tool_result content block
4
Claude uses the tool to modify files

After examining the file or directory, Claude may use a command such as str_replace to make changes or insert to add text at a specific line number.
If Claude uses the str_replace command, Claude constructs a properly formatted tool use request with the old text and new text to replace it with
5
Execute the edit and return results

Extract the file path, old text, and new text from Claude’s tool use request
Perform the text replacement in the file
Return the results to Claude
6
Claude provides its analysis and explanation

After examining and possibly editing the files, Claude provides a complete explanation of what it found and what changes it made
​
Text editor tool commands
The text editor tool supports several commands for viewing and modifying files:

​
view
The view command allows Claude to examine the contents of a file or list the contents of a directory. It can read the entire file or a specific range of lines.

Parameters:

command: Must be “view”
path: The path to the file or directory to view
view_range (optional): An array of two integers specifying the start and end line numbers to view. Line numbers are 1-indexed, and -1 for the end line means read to the end of the file. This parameter only applies when viewing files, not directories.

Example view commands

// Example for viewing a file
{
"type": "tool_use",
"id": "toolu_01A09q90qw90lq917835lq9",
"name": "str_replace_editor",
"input": {
"command": "view",
"path": "primes.py"
}
}

// Example for viewing a directory
{
"type": "tool_use",
"id": "toolu_02B19r91rw91mr917835mr9",
"name": "str_replace_editor",
"input": {
"command": "view",
"path": "src/"
}
}
​
str_replace
The str_replace command allows Claude to replace a specific string in a file with a new string. This is used for making precise edits.

Parameters:

command: Must be “str_replace”
path: The path to the file to modify
old_str: The text to replace (must match exactly, including whitespace and indentation)
new_str: The new text to insert in place of the old text

Example str_replace command

{
"type": "tool_use",
"id": "toolu_01A09q90qw90lq917835lq9",
"name": "str_replace_editor",
"input": {
"command": "str_replace",
"path": "primes.py",
"old_str": "for num in range(2, limit + 1)",
"new_str": "for num in range(2, limit + 1):"
}
}
​
create
The create command allows Claude to create a new file with specified content.

Parameters:

command: Must be “create”
path: The path where the new file should be created
file_text: The content to write to the new file

Example create command

{
"type": "tool_use",
"id": "toolu_01A09q90qw90lq917835lq9",
"name": "str_replace_editor",
"input": {
"command": "create",
"path": "test_primes.py",
"file_text": "import unittest\nimport primes\n\nclass TestPrimes(unittest.TestCase):\n def test_is_prime(self):\n self.assertTrue(primes.is_prime(2))\n self.assertTrue(primes.is_prime(3))\n self.assertFalse(primes.is_prime(4))\n\nif **name** == '**main**':\n unittest.main()"
}
}
​
insert
The insert command allows Claude to insert text at a specific location in a file.

Parameters:

command: Must be “insert”
path: The path to the file to modify
insert_line: The line number after which to insert the text (0 for beginning of file)
new_str: The text to insert

Example insert command

{
"type": "tool_use",
"id": "toolu_01A09q90qw90lq917835lq9",
"name": "str_replace_editor",
"input": {
"command": "insert",
"path": "primes.py",
"insert_line": 0,
"new_str": "\"\"\"Module for working with prime numbers.\n\nThis module provides functions to check if a number is prime\nand to generate a list of prime numbers up to a given limit.\n\"\"\"\n"
}
}
​
undo_edit
The undo_edit command allows Claude to revert the last edit made to a file.

Parameters:

command: Must be “undo_edit”
path: The path to the file whose last edit should be undone

Example undo_edit command

{
"type": "tool_use",
"id": "toolu_01A09q90qw90lq917835lq9",
"name": "str_replace_editor",
"input": {
"command": "undo_edit",
"path": "primes.py"
}
}
​
Example: Fixing a syntax error with the text editor tool
This example demonstrates how Claude uses the text editor tool to fix a syntax error in a Python file.

First, your application provides Claude with the text editor tool and a prompt to fix a syntax error:

Python

Java

import anthropic

client = anthropic.Anthropic()

response = client.messages.create(
model="claude-3-7-sonnet-20250219",
max_tokens=1024,
tools=[
{
"type": "text_editor_20250124",
"name": "str_replace_editor"
}
],
messages=[
{
"role": "user",
"content": "There's a syntax error in my primes.py file. Can you help me fix it?"
}
]
)

print(response)
Claude will use the text editor tool first to view the file:

{
"id": "msg_01XAbCDeFgHiJkLmNoPQrStU",
"model": "claude-3-7-sonnet-20250219",
"stop_reason": "tool_use",
"role": "assistant",
"content": [
{
"type": "text",
"text": "I'll help you fix the syntax error in your primes.py file. First, let me take a look at the file to identify the issue."
},
{
"type": "tool_use",
"id": "toolu_01AbCdEfGhIjKlMnOpQrStU",
"name": "str_replace_editor",
"input": {
"command": "view",
"path": "primes.py"
}
}
]
}
Your application should then read the file and return its contents to Claude:

Python

Java

response = client.messages.create(
model="claude-3-7-sonnet-20250219",
max_tokens=1024,
tools=[
{
"type": "text_editor_20250124",
"name": "str_replace_editor"
}
],
messages=[
{
"role": "user",
"content": "There's a syntax error in my primes.py file. Can you help me fix it?"
},
{
"role": "assistant",
"content": [
{
"type": "text",
"text": "I'll help you fix the syntax error in your primes.py file. First, let me take a look at the file to identify the issue."
},
{
"type": "tool_use",
"id": "toolu_01AbCdEfGhIjKlMnOpQrStU",
"name": "str_replace_editor",
"input": {
"command": "view",
"path": "primes.py"
}
}
]
},
{
"role": "user",
"content": [
{
"type": "tool_result",
"tool_use_id": "toolu_01AbCdEfGhIjKlMnOpQrStU",
"content": "1: def is_prime(n):\n2: \"\"\"Check if a number is prime.\"\"\"\n3: if n <= 1:\n4: return False\n5: if n <= 3:\n6: return True\n7: if n % 2 == 0 or n % 3 == 0:\n8: return False\n9: i = 5\n10: while i \* i <= n:\n11: if n % i == 0 or n % (i + 2) == 0:\n12: return False\n13: i += 6\n14: return True\n15: \n16: def get_primes(limit):\n17: \"\"\"Generate a list of prime numbers up to the given limit.\"\"\"\n18: primes = []\n19: for num in range(2, limit + 1)\n20: if is_prime(num):\n21: primes.append(num)\n22: return primes\n23: \n24: def main():\n25: \"\"\"Main function to demonstrate prime number generation.\"\"\"\n26: limit = 100\n27: prime_list = get_primes(limit)\n28: print(f\"Prime numbers up to {limit}:\")\n29: print(prime_list)\n30: print(f\"Found {len(prime_list)} prime numbers.\")\n31: \n32: if **name** == \"**main**\":\n33: main()"
}
]
}
]
)
Line numbers

In the example above, the view tool result includes file contents with line numbers prepended to each line (e.g., “1: def is_prime(n):”). Line numbers are not required, but they are essential for successfully using the view_range parameter to examine specific sections of files and the insert_line parameter to add content at precise locations.

Claude will identify the syntax error and use the str_replace command to fix it:

{
"id": "msg_01VwXyZAbCdEfGhIjKlMnO",
"model": "claude-3-7-sonnet-20250219",
"stop_reason": "tool_use",
"role": "assistant",
"content": [
{
"type": "text",
"text": "I found the syntax error in your primes.py file. In the `get_primes` function, there is a missing colon (:) at the end of the for loop line. Let me fix that for you."
},
{
"type": "tool_use",
"id": "toolu_01PqRsTuVwXyZAbCdEfGh",
"name": "str_replace_editor",
"input": {
"command": "str_replace",
"path": "primes.py",
"old_str": " for num in range(2, limit + 1)",
"new_str": " for num in range(2, limit + 1):"
}
}
]
}
Your application should then make the edit and return the result:

Python

Java

response = client.messages.create(
model="claude-3-7-sonnet-20250219",
max_tokens=1024,
tools=[
{
"type": "text_editor_20250124",
"name": "str_replace_editor"
}
],
messages=[ # Previous messages...
{
"role": "assistant",
"content": [
{
"type": "text",
"text": "I found the syntax error in your primes.py file. In the `get_primes` function, there is a missing colon (:) at the end of the for loop line. Let me fix that for you."
},
{
"type": "tool_use",
"id": "toolu_01PqRsTuVwXyZAbCdEfGh",
"name": "str_replace_editor",
"input": {
"command": "str_replace",
"path": "primes.py",
"old_str": " for num in range(2, limit + 1)",
"new_str": " for num in range(2, limit + 1):"
}
}
]
},
{
"role": "user",
"content": [
{
"type": "tool_result",
"tool_use_id": "toolu_01PqRsTuVwXyZAbCdEfGh",
"content": "Successfully replaced text at exactly one location."
}
]
}
]
)
Finally, Claude will provide a complete explanation of the fix:

{
"id": "msg_01IjKlMnOpQrStUvWxYzAb",
"model": "claude-3-7-sonnet-20250219",
"stop_reason": "end_turn",
"role": "assistant",
"content": [
{
"type": "text",
"text": "I've fixed the syntax error in your primes.py file. The issue was in the `get_primes` function at line 19. There was a missing colon (:) at the end of the for loop line.\n\nHere's what I changed:\n\nFrom:\n```python\nfor num in range(2, limit + 1)\n```\n\nTo:\n```python\nfor num in range(2, limit + 1):\n```\n\nIn Python, a colon is required at the end of statements that start a new code block, such as for loops, if statements, function definitions, etc. Without the colon, Python raises a syntax error because it doesn't know where the code block begins.\n\nYour code should now run correctly. The function will properly generate a list of prime numbers up to the specified limit."
}
]
}
​
Implement the text editor tool
The text editor tool is implemented as a schema-less tool, identified by type: "text_editor_20250124". When using this tool, you don’t need to provide an input schema as with other tools; the schema is built into Claude’s model and can’t be modified.

1
Initialize your editor implementation

Create helper functions to handle file operations like reading, writing, and modifying files. Consider implementing backup functionality to recover from mistakes.

2
Handle editor tool calls

Create a function that processes tool calls from Claude based on the command type:

def handle_editor_tool(tool_call):
input_params = tool_call.input
command = input_params.get('command', '')
file_path = input_params.get('path', '')

    if command == 'view':
        # Read and return file contents
        pass
    elif command == 'str_replace':
        # Replace text in file
        pass
    elif command == 'create':
        # Create new file
        pass
    elif command == 'insert':
        # Insert text at location
        pass
    elif command == 'undo_edit':
        # Restore from backup
        pass

3
Implement security measures

Add validation and security checks:

Validate file paths to prevent directory traversal
Create backups before making changes
Handle errors gracefully
Implement permissions checks
4
Process Claude's responses

Extract and handle tool calls from Claude’s responses:

# Process tool use in Claude's response

for content in response.content:
if content.type == "tool_use": # Execute the tool based on command
result = handle_editor_tool(content)

        # Return result to Claude
        tool_result = {
            "type": "tool_result",
            "tool_use_id": content.id,
            "content": result
        }

When implementing the text editor tool, keep in mind:

Security: The tool has access to your local filesystem, so implement proper security measures.
Backup: Always create backups before allowing edits to important files.
Validation: Validate all inputs to prevent unintended changes.
Unique matching: Make sure replacements match exactly one location to avoid unintended edits.
​
Handle errors
When using the text editor tool, various errors may occur. Here is guidance on how to handle them:

File not found

If Claude tries to view or modify a file that doesn’t exist, return an appropriate error message in the tool_result:

{
"role": "user",
"content": [
{
"type": "tool_result",
"tool_use_id": "toolu_01A09q90qw90lq917835lq9",
"content": "Error: File not found",
"is_error": true
}
]
}

Multiple matches for replacement

If Claude’s str_replace command matches multiple locations in the file, return an appropriate error message:

{
"role": "user",
"content": [
{
"type": "tool_result",
"tool_use_id": "toolu_01A09q90qw90lq917835lq9",
"content": "Error: Found 3 matches for replacement text. Please provide more context to make a unique match.",
"is_error": true
}
]
}

No matches for replacement

If Claude’s str_replace command doesn’t match any text in the file, return an appropriate error message:

{
"role": "user",
"content": [
{
"type": "tool_result",
"tool_use_id": "toolu_01A09q90qw90lq917835lq9",
"content": "Error: No match found for replacement. Please check your text and try again.",
"is_error": true
}
]
}

Permission errors

If there are permission issues with creating, reading, or modifying files, return an appropriate error message:

{
"role": "user",
"content": [
{
"type": "tool_result",
"tool_use_id": "toolu_01A09q90qw90lq917835lq9",
"content": "Error: Permission denied. Cannot write to file.",
"is_error": true
}
]
}
​
Follow implementation best practices

Provide clear context

When asking Claude to fix or modify code, be specific about what files need to be examined or what issues need to be addressed. Clear context helps Claude identify the right files and make appropriate changes.

Less helpful prompt: “Can you fix my code?”

Better prompt: “There’s a syntax error in my primes.py file that prevents it from running. Can you fix it?”

Be explicit about file paths

Specify file paths clearly when needed, especially if you’re working with multiple files or files in different directories.

Less helpful prompt: “Review my helper file”

Better prompt: “Can you check my utils/helpers.py file for any performance issues?”

Create backups before editing

Implement a backup system in your application that creates copies of files before allowing Claude to edit them, especially for important or production code.

def backup_file(file_path):
"""Create a backup of a file before editing."""
backup_path = f"{file_path}.backup"
if os.path.exists(file_path):
with open(file_path, 'r') as src, open(backup_path, 'w') as dst:
dst.write(src.read())

Handle unique text replacement carefully

The str_replace command requires an exact match for the text to be replaced. Your application should ensure that there is exactly one match for the old text or provide appropriate error messages.

def safe_replace(file_path, old_text, new_text):
"""Replace text only if there's exactly one match."""
with open(file_path, 'r') as f:
content = f.read()

    count = content.count(old_text)
    if count == 0:
        return "Error: No match found"
    elif count > 1:
        return f"Error: Found {count} matches"
    else:
        new_content = content.replace(old_text, new_text)
        with open(file_path, 'w') as f:
            f.write(new_content)
        return "Successfully replaced text"

Verify changes

After Claude makes changes to a file, verify the changes by running tests or checking that the code still works as expected.

def verify_changes(file_path):
"""Run tests or checks after making changes."""
try: # For Python files, check for syntax errors
if file_path.endswith('.py'):
import ast
with open(file_path, 'r') as f:
ast.parse(f.read())
return "Syntax check passed"
except Exception as e:
return f"Verification failed: {str(e)}"
​
EDIT_TOOL_CLAUDE.md
