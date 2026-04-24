import { createOpencodeClient } from '@opencode-ai/sdk';

import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, McpServerConfig, ProviderEvent, ProviderOptions, QueryInput } from './types.js';

function log(msg: string): void {
  console.error(`[opencode-provider] ${msg}`);
}

const STALE_SESSION_RE = /session.*not found|unknown session|invalid session|404/i;
const ACTIVITY_PULSE_MS = 1000;

interface AssistantMessage {
  id: string;
}

interface MessagePart {
  type: string;
  text?: string;
}

interface SessionMessageResult {
  parts: MessagePart[];
}

interface ResultEnvelope<T> {
  data?: T;
  error?: unknown;
}

interface OpenCodeClient {
  session: {
    create: () => Promise<ResultEnvelope<{ id: string }>>;
    get: (args: { path: { id: string } }) => Promise<ResultEnvelope<unknown>>;
    chat: (args: { path: { id: string }; body: Record<string, unknown> }) => Promise<ResultEnvelope<AssistantMessage>>;
    message: (args: { path: { id: string; messageID: string } }) => Promise<ResultEnvelope<SessionMessageResult>>;
    abort: (args: { path: { id: string } }) => Promise<ResultEnvelope<unknown>>;
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function unwrapResult<T>(result: ResultEnvelope<T>): T {
  if (result.data !== undefined) return result.data;
  const message = extractErrorMessage(result.error);
  throw new Error(message || 'OpenCode request failed');
}

function extractErrorMessage(err: unknown): string {
  if (!err) return '';
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (typeof err !== 'object') return String(err);
  const obj = err as Record<string, unknown>;
  const direct = obj.message;
  if (typeof direct === 'string') return direct;
  const nested = obj.data;
  if (nested && typeof nested === 'object' && typeof (nested as Record<string, unknown>).message === 'string') {
    return String((nested as Record<string, unknown>).message);
  }
  return JSON.stringify(err);
}

function extractMessageText(message: SessionMessageResult): string | null {
  const chunks = message.parts
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text?.trim())
    .filter((txt): txt is string => Boolean(txt));
  if (chunks.length === 0) return null;
  return chunks.join('\n\n');
}

export class OpenCodeProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  private readonly mcpServers: Record<string, McpServerConfig>;
  private readonly env: Record<string, string | undefined>;

  private client: OpenCodeClient | null = null;

  constructor(options: ProviderOptions = {}) {
    this.mcpServers = options.mcpServers ?? {};
    this.env = options.env ?? {};
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return STALE_SESSION_RE.test(msg);
  }

  query(input: QueryInput): AgentQuery {
    let aborted = false;
    let sessionId: string | null = null;
    let pendingFollowUps: string[] = [];
    let interruptRequested = false;

    const requestInterrupt = (): void => {
      interruptRequested = true;
      if (!sessionId) return;
      void this.abortSession(sessionId);
    };

    const run = async function* (self: OpenCodeProvider): AsyncGenerator<ProviderEvent> {
      const client = self.ensureClient();
      const providerID = self.requireEnv('OPENCODE_PROVIDER');
      const modelID = self.requireEnv('OPENCODE_MODEL');
      const agentID = self.env.OPENCODE_AGENT?.trim();

      if (Object.keys(self.mcpServers).length > 0) {
        log('MCP server injection is not configurable through @opencode-ai/sdk session APIs; relying on OpenCode server-side config.');
      }

      sessionId = await self.ensureSession(input.continuation);
      yield { type: 'init', continuation: sessionId };

      let includeSystem = true;
      let nextPrompt = input.prompt;

      while (!aborted) {
        interruptRequested = false;
        let done = false;
        let error: unknown;
        let assistant: AssistantMessage | null = null;

        const system = includeSystem ? input.systemContext?.instructions?.trim() : '';
        includeSystem = false;

        const turnPromise = client.session
          .chat({
            path: { id: sessionId },
            body: {
              providerID,
              modelID,
              agent: agentID || undefined,
              system: system || undefined,
              parts: [{ type: 'text', text: nextPrompt }],
            },
          })
          .then((res) => {
            assistant = unwrapResult(res);
          })
          .catch((err) => {
            error = err;
          })
          .finally(() => {
            done = true;
          });

        while (!done && !aborted) {
          yield { type: 'activity' };
          await sleep(ACTIVITY_PULSE_MS);
        }

        await turnPromise;
        if (aborted) return;

        if (error) {
          if (interruptRequested && pendingFollowUps.length > 0) {
            nextPrompt = pendingFollowUps.join('\n\n');
            pendingFollowUps = [];
            continue;
          }
          yield { type: 'error', message: extractErrorMessage(error) || 'OpenCode turn failed', retryable: false };
          return;
        }

        if (!assistant) {
          yield { type: 'error', message: 'OpenCode did not return an assistant message', retryable: false };
          return;
        }
        const assistantMessage = assistant as AssistantMessage;

        const messageRes = await client.session.message({
          path: { id: sessionId, messageID: assistantMessage.id },
        });
        const message = unwrapResult(messageRes);
        yield { type: 'result', text: extractMessageText(message) };

        if (pendingFollowUps.length === 0) return;
        nextPrompt = pendingFollowUps.join('\n\n');
        pendingFollowUps = [];
      }
    };

    return {
      push: (message) => {
        if (!message.trim()) return;
        pendingFollowUps.push(message);
        requestInterrupt();
      },
      end: () => {
        // Discrete turn API; no stream termination hook.
      },
      abort: () => {
        aborted = true;
        requestInterrupt();
      },
      events: run(this),
    };
  }

  private ensureClient(): OpenCodeClient {
    if (this.client) return this.client;

    const baseUrl = this.env.OPENCODE_BASE_URL?.trim();
    const client = createOpencodeClient(baseUrl ? { baseUrl } : undefined) as unknown as OpenCodeClient;
    this.client = client;
    return client;
  }

  private requireEnv(key: 'OPENCODE_PROVIDER' | 'OPENCODE_MODEL'): string {
    const value = this.env[key]?.trim();
    if (value) return value;
    throw new Error(`${key} is required for opencode provider`);
  }

  private async ensureSession(continuation?: string): Promise<string> {
    const client = this.ensureClient();
    const cont = continuation?.trim();
    if (cont) {
      try {
        const result = await client.session.get({ path: { id: cont } });
        unwrapResult(result);
        return cont;
      } catch (err) {
        log(`Continuation ${cont} unavailable (${extractErrorMessage(err)}), creating a new session`);
      }
    }
    const created = await client.session.create();
    const session = unwrapResult(created);
    return session.id;
  }

  private async abortSession(sessionId: string): Promise<void> {
    try {
      const client = this.ensureClient();
      await client.session.abort({ path: { id: sessionId } });
    } catch {
      // Best effort only.
    }
  }
}

registerProvider('opencode', (opts) => new OpenCodeProvider(opts));
