// Simple test script for Claude API

async function testClaude() {
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-3-7-sonnet-20250219',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Hello! How are you?'
              }
            ]
          }
        ],
        max_tokens: 1000,
        thinking: {
          type: 'enabled',
          budget_tokens: 3000
        }
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('API Error:', errorText);
      return;
    }

    const data = await response.json();
    console.log('Success! Response:', JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('Error:', error);
  }
}

testClaude();