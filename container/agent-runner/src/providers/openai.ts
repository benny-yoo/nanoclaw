import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, McpServerConfig, ProviderEvent, ProviderOptions, QueryInput } from './types.js';

function log(msg: string): void {
  console.error(`[openai-provider] ${msg}`);
}

const ACTIVITY_PULSE_MS = 1000;
const DEFAULT_TIMEOUT_MS = 120000;
const SESSION_INVALID_RE = /session.*not found|unknown session|invalid session|conversation.*not found|thread.*not found/i;

type ChatRole = 'system' | 'user' | 'assistant';

interface ChatMessage {
  role: ChatRole;
  content: string;
}

interface ChatCompletionChoice {
  message?: {
    content?: string | Array<{ type?: string; text?: string }> | null;
  };
}

interface ChatCompletionResponse {
  choices?: ChatCompletionChoice[];
  error?: {
    message?: string;
  };
}

interface OpenAIErrorPayload {
  error?: {
    message?: string;
    type?: string;
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function generateSessionId(): string {
  return `openai-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function extractErrorMessage(err: unknown): string {
  if (!err) return '';
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (typeof err !== 'object') return String(err);

  const obj = err as Record<string, unknown>;
  if (typeof obj.message === 'string') return obj.message;

  const nestedError = obj.error;
  if (nestedError && typeof nestedError === 'object' && typeof (nestedError as Record<string, unknown>).message === 'string') {
    return String((nestedError as Record<string, unknown>).message);
  }

  return JSON.stringify(err);
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('OPENAI_BASE_URL is required for openai provider');
  }
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
}

function parseOptionalNumber(env: Record<string, string | undefined>, key: string): number | undefined {
  const raw = env[key]?.trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${key} must be a valid number`);
  }
  return parsed;
}

function parseOptionalPositiveInt(env: Record<string, string | undefined>, key: string): number | undefined {
  const value = parseOptionalNumber(env, key);
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${key} must be a positive integer`);
  }
  return value;
}

function extractAssistantText(payload: ChatCompletionResponse): string | null {
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content === 'string') {
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (Array.isArray(content)) {
    const chunks = content
      .map((part) => (part && typeof part.text === 'string' ? part.text.trim() : ''))
      .filter((text) => text.length > 0);
    if (chunks.length > 0) return chunks.join('\n\n');
  }

  return null;
}

export class OpenAIProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  private readonly env: Record<string, string | undefined>;
  private readonly mcpServers: Record<string, McpServerConfig>;
  private readonly sessions = new Map<string, ChatMessage[]>();

  constructor(options: ProviderOptions = {}) {
    this.env = options.env ?? {};
    this.mcpServers = options.mcpServers ?? {};
  }

  isSessionInvalid(err: unknown): boolean {
    const message = extractErrorMessage(err);
    return SESSION_INVALID_RE.test(message);
  }

  query(input: QueryInput): AgentQuery {
    let aborted = false;
    let continuation = this.resolveContinuation(input.continuation);
    let pendingFollowUps: string[] = [];
    let interruptRequested = false;
    let activeController: AbortController | null = null;

    const requestInterrupt = (): void => {
      interruptRequested = true;
      activeController?.abort();
    };

    const run = async function* (self: OpenAIProvider): AsyncGenerator<ProviderEvent> {
      let baseUrl: string;
      let apiKey: string;
      let model: string;
      let timeoutMs: number;
      let maxTokens: number | undefined;
      let temperature: number | undefined;

      try {
        baseUrl = normalizeBaseUrl(self.requireEnv('OPENAI_BASE_URL'));
        apiKey = self.requireEnv('OPENAI_API_KEY');
        model = self.requireEnv('OPENAI_MODEL');
        timeoutMs = parseOptionalPositiveInt(self.env, 'OPENAI_TIMEOUT_MS') ?? DEFAULT_TIMEOUT_MS;
        maxTokens = parseOptionalPositiveInt(self.env, 'OPENAI_MAX_TOKENS');
        temperature = parseOptionalNumber(self.env, 'OPENAI_TEMPERATURE');
      } catch (err) {
        yield { type: 'error', message: extractErrorMessage(err) || 'Invalid openai provider configuration', retryable: false };
        return;
      }

      if (Object.keys(self.mcpServers).length > 0) {
        log('MCP server wiring is handled by agent-runner; openai provider does not pass MCP config to upstream API directly.');
      }

      const history = self.ensureSessionHistory(continuation);
      const systemInstruction = input.systemContext?.instructions?.trim();
      if (systemInstruction && !history.some((msg) => msg.role === 'system')) {
        history.push({ role: 'system', content: systemInstruction });
      }

      yield { type: 'init', continuation };

      let nextPrompt = input.prompt;
      while (!aborted) {
        interruptRequested = false;

        const userPrompt = nextPrompt.trim();
        if (!userPrompt) {
          if (pendingFollowUps.length === 0) return;
          nextPrompt = pendingFollowUps.join('\n\n');
          pendingFollowUps = [];
          continue;
        }

        history.push({ role: 'user', content: userPrompt });

        let response: ChatCompletionResponse | undefined;
        let requestError: unknown;

        const controller = new AbortController();
        activeController = controller;

        const turnPromise = self.requestChatCompletion({
          baseUrl,
          apiKey,
          model,
          messages: history,
          timeoutMs,
          maxTokens,
          temperature,
          signal: controller.signal,
        });

        let settled = false;
        while (!settled && !aborted) {
          const tick = await Promise.race([
            turnPromise.then((payload) => ({ kind: 'response' as const, payload })).catch((error: unknown) => ({
              kind: 'error' as const,
              error,
            })),
            sleep(ACTIVITY_PULSE_MS).then(() => ({ kind: 'pulse' as const })),
          ]);

          if (tick.kind === 'pulse') {
            yield { type: 'activity' };
            continue;
          }

          settled = true;
          if (tick.kind === 'error') {
            requestError = tick.error;
          } else {
            response = tick.payload;
          }
        }

        if (!settled) {
          await turnPromise.catch(() => {});
          activeController = null;
          return;
        }
        activeController = null;

        if (aborted) return;

        if (requestError) {
          if (interruptRequested && pendingFollowUps.length > 0) {
            history.pop(); // drop interrupted user message
            nextPrompt = pendingFollowUps.join('\n\n');
            pendingFollowUps = [];
            continue;
          }

          if (isAbortError(requestError)) {
            // Best-effort cancel from abort(); no further events needed.
            return;
          }

          history.pop(); // drop failed user message
          yield {
            type: 'error',
            message: extractErrorMessage(requestError) || 'OpenAI-compatible request failed',
            retryable: false,
          };
          return;
        }

        if (!response) {
          history.pop();
          yield { type: 'error', message: 'OpenAI-compatible provider returned an empty response', retryable: false };
          return;
        }

        if (response.error?.message) {
          history.pop();
          yield { type: 'error', message: response.error.message, retryable: false };
          return;
        }

        const text = extractAssistantText(response);
        if (text) {
          history.push({ role: 'assistant', content: text });
        }
        yield { type: 'result', text };

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
        // Discrete turn API; no stream completion signal to upstream.
      },
      abort: () => {
        aborted = true;
        requestInterrupt();
      },
      events: run(this),
    };
  }

  private ensureSessionHistory(sessionId: string): ChatMessage[] {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const history: ChatMessage[] = [];
    this.sessions.set(sessionId, history);
    return history;
  }

  private resolveContinuation(continuation?: string): string {
    const sessionId = continuation?.trim();
    if (!sessionId) return generateSessionId();
    if (!this.sessions.has(sessionId)) {
      log(`Continuation ${sessionId} not found in provider memory, starting a new session`);
      return generateSessionId();
    }
    return sessionId;
  }

  private requireEnv(key: 'OPENAI_BASE_URL' | 'OPENAI_API_KEY' | 'OPENAI_MODEL'): string {
    const value = this.env[key]?.trim();
    if (!value) {
      throw new Error(`${key} is required for openai provider`);
    }
    return value;
  }

  private async requestChatCompletion(args: {
    baseUrl: string;
    apiKey: string;
    model: string;
    messages: ChatMessage[];
    timeoutMs: number;
    maxTokens?: number;
    temperature?: number;
    signal: AbortSignal;
  }): Promise<ChatCompletionResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), args.timeoutMs);

    const abortHandler = (): void => controller.abort();
    args.signal.addEventListener('abort', abortHandler, { once: true });

    try {
      const payload: Record<string, unknown> = {
        model: args.model,
        messages: args.messages.map((msg) => ({ role: msg.role, content: msg.content })),
      };
      if (typeof args.maxTokens === 'number') payload.max_tokens = args.maxTokens;
      if (typeof args.temperature === 'number') payload.temperature = args.temperature;

      const response = await fetch(`${args.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${args.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      const raw = await response.text();
      if (!response.ok) {
        let errorPayload: OpenAIErrorPayload | undefined;
        try {
          errorPayload = raw ? (JSON.parse(raw) as OpenAIErrorPayload) : undefined;
        } catch {
          errorPayload = undefined;
        }
        const detail = errorPayload?.error?.message || raw || 'Unknown error';
        throw new Error(`OpenAI-compatible request failed (${response.status}): ${detail}`);
      }

      if (!raw.trim()) return {};
      return JSON.parse(raw) as ChatCompletionResponse;
    } finally {
      clearTimeout(timeout);
      args.signal.removeEventListener('abort', abortHandler);
    }
  }
}

registerProvider('openai', (opts) => new OpenAIProvider(opts));
