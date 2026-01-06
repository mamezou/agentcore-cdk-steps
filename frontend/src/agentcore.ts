import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore';
import { fromCognitoIdentityPool } from '@aws-sdk/credential-providers';

const CONFIG = {
  region: import.meta.env.VITE_AWS_REGION || 'ap-northeast-1',
  identityPoolId: import.meta.env.VITE_IDENTITY_POOL_ID || '',
  userPoolId: import.meta.env.VITE_USER_POOL_ID || '',
  agentRuntimeArn: import.meta.env.VITE_AGENT_RUNTIME_ARN || ''
};

export interface Message {
  role: 'user' | 'assistant';
  content: string;
}

export interface InvokeOptions {
  message: string;
  history: Message[];
  idToken: string;
  actorId?: string;  // User identifier for Memory
  sessionId?: string;  // Session identifier for conversation grouping
  onChunk?: (chunk: string) => void;
}

export function isDirectCallConfigured(): boolean {
  return Boolean(CONFIG.identityPoolId && CONFIG.agentRuntimeArn);
}

export async function invokeAgentCoreDirect(options: InvokeOptions): Promise<string> {
  const { message, history, idToken, actorId, sessionId, onChunk } = options;

  // Cognito Identity Pool provider name
  const providerName = `cognito-idp.${CONFIG.region}.amazonaws.com/${CONFIG.userPoolId}`;

  // Create client with Cognito credentials
  const client = new BedrockAgentCoreClient({
    region: CONFIG.region,
    credentials: fromCognitoIdentityPool({
      identityPoolId: CONFIG.identityPoolId,
      logins: {
        [providerName]: idToken
      },
      clientConfig: { region: CONFIG.region }
    })
  });

  // Build payload with actorId and sessionId for Memory
  const payload = JSON.stringify({
    prompt: message,
    history: history.slice(-20), // Last 20 messages
    actorId: actorId || 'anonymous',  // User identifier for Memory persistence
    sessionId: sessionId || ''  // Session identifier for conversation grouping
  });

  const command = new InvokeAgentRuntimeCommand({
    agentRuntimeArn: CONFIG.agentRuntimeArn,
    contentType: 'application/json',
    accept: 'text/event-stream',  // Request streaming response
    payload: new TextEncoder().encode(payload)
  });

  const response = await client.send(command);

  // Handle streaming response
  if (!response.response) {
    throw new Error('No response from AgentCore');
  }

  // Check content type
  const contentType = response.contentType || '';
  console.log('AgentCore response contentType:', contentType);

  if (contentType.includes('text/event-stream')) {
    // SSE streaming response
    return await processSSEStream(response.response, onChunk);
  } else {
    // Non-streaming response (JSON or plain text)
    return await processNonStreamingResponse(response.response, onChunk);
  }
}

async function processNonStreamingResponse(
  stream: { transformToByteArray: () => Promise<Uint8Array> },
  onChunk?: (chunk: string) => void
): Promise<string> {
  const bytes = await stream.transformToByteArray();
  const text = new TextDecoder().decode(bytes);

  try {
    const json = JSON.parse(text);
    const content = json.response || json.content || text;
    if (onChunk) onChunk(content);
    return content;
  } catch {
    if (onChunk) onChunk(text);
    return text;
  }
}

async function processSSEStream(
  stream: { transformToWebStream: () => ReadableStream<Uint8Array> },
  onChunk?: (chunk: string) => void
): Promise<string> {
  const reader = stream.transformToWebStream().getReader();
  const decoder = new TextDecoder();
  let fullResponse = '';
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process SSE events (split by double newline)
      const events = buffer.split('\n\n');
      buffer = events.pop() || ''; // Keep incomplete event

      for (const event of events) {
        const lines = event.split('\n');
        for (const line of lines) {
          if (line.startsWith('data:')) {
            const data = line.slice(5).trim();
            if (data && data !== '[DONE]') {
              try {
                // Try parsing as JSON
                const parsed = JSON.parse(data);
                const chunk = parsed.delta?.text || parsed.text || parsed.content || parsed;
                if (typeof chunk === 'string' && chunk) {
                  fullResponse += chunk;
                  if (onChunk) onChunk(fullResponse);
                }
              } catch {
                // Plain text chunk - append directly
                fullResponse += data;
                if (onChunk) onChunk(fullResponse);
              }
            }
          } else if (line && !line.startsWith('event:') && !line.startsWith('id:')) {
            // Raw text line (not an SSE field)
            fullResponse += line;
            if (onChunk) onChunk(fullResponse);
          }
        }
      }
    }

    // Process any remaining buffer
    if (buffer.trim()) {
      const lines = buffer.split('\n');
      for (const line of lines) {
        if (line.startsWith('data:')) {
          const data = line.slice(5).trim();
          if (data && data !== '[DONE]') {
            fullResponse += data;
            if (onChunk) onChunk(fullResponse);
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return fullResponse;
}
