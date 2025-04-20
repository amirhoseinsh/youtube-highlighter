import axios from 'axios';
export async function analyzeWithGrok(subtitles, prompt, apiKey, numHighlights) {
  try {
    const messages = [
      {
        role: "user",
        content: `Analyze these video subtitles and identify the ${numHighlights} most ${prompt} moments. Each moment should ideally be between 1-2 minutes long to capture the full context. You must respond with ONLY a JSON array in this exact format, with no additional text or explanation:

[
  {
    "startTime": "HH:mm:ss",
    "endTime": "HH:mm:ss",
    "description": "Brief description of the moment"
  }
]

Requirements:
1. Timestamps must be in HH:mm:ss format and match times from the subtitles
2. Each moment should span multiple subtitle entries to capture complete context
3. Try to identify moments that naturally span 1-2 minutes
4. If a key moment is shorter, include more context before and after
5. Ensure the description explains why this moment is significant

Here are the subtitles to analyze: ${JSON.stringify(subtitles)}`
      }
    ];

    const response = await axios.post('https://api.x.ai/v1/chat/completions', {
      model: 'grok-1',
      messages: messages,
      temperature: 0.7,
      response_format: { type: "json_object" }
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      }
    });

    const content = response.data?.choices?.[0]?.message?.content || '';
    console.log('Grok API response:', content);
    let highlights;
    
    try {
      // Parse the JSON response
      const jsonContent = typeof content === 'string' ? content : JSON.stringify(content);
      console.log('Cleaned JSON content:', jsonContent);
      highlights = JSON.parse(jsonContent);

      // If the response is wrapped in an object, extract the array
      if (highlights && !Array.isArray(highlights) && highlights.highlights) {
        highlights = highlights.highlights;
      }
    } catch (e) {
      throw new Error('Failed to parse Grok API response as JSON');
    }

    if (!Array.isArray(highlights)) {
      throw new Error('Grok API response is not an array');
    }

    // Validate highlight format
    highlights.forEach((highlight, index) => {
      if (!highlight.startTime || !highlight.endTime || !highlight.description) {
        throw new Error(`Invalid highlight format at index ${index}`);
      }
    });

    return highlights;
  } catch (error) {
    console.error('Grok API error details:', error);
    
    if (error.response) {
      const errorMessage = error.response.data?.error?.message || 
                         error.response.data?.error || 
                         error.response.statusText || 
                         'Unknown API error';
      throw new Error(`Grok API error: ${errorMessage}`);
    }
    
    // Handle network errors or other issues
    throw new Error(`Grok API error: ${error.message || 'Unknown error occurred'}`);
  }
}
