import { Client } from '@modelcontextprotocol/sdk/client';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, McpServerConfig, ProviderEvent, ProviderOptions, QueryInput } from './types.js';

function log(msg: string): void {
  console.error(`[openai-provider] ${msg}`);
}

const ACTIVITY_PULSE_MS = 1000;
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_MAX_ROUNDS = 16;
const DEFAULT_MAX_TOOL_CALLS_TOTAL = 64;
const DEFAULT_MAX_TOOL_CALLS_PER_ROUND = 8;
const DEFAULT_TOOL_TIMEOUT_MS = 120000;
const SESSION_INVALID_RE = /session.*not found|unknown session|invalid session|conversation.*not found|thread.*not found/i;
const OPENAI_TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

type OpenAIMessageRole = 'system' | 'user' | 'assistant' | 'tool';

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenAIMessage {
  role: OpenAIMessageRole;
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

interface OpenAIToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

interface ChatCompletionChoice {
  message?: {
    content?: string | Array<{ type?: string; text?: string }> | null;
    tool_calls?: OpenAIToolCall[];
  };
}

type ChatCompletionChoiceMessage = NonNullable<ChatCompletionChoice['message']>;

interface ChatCompletionResponse {
  choices?: ChatCompletionChoice[];
  error?: {
    message?: string;
  };
}

interface OpenAIErrorPayload {
  error?: {
    message?: string;
  };
}

interface McpToolMapping {
  openaiToolName: string;
  originalToolName: string;
  serverName: string;
}

interface McpToolSpec extends McpToolMapping {
  description?: string;
  inputSchema: Record<string, unknown>;
}

interface McpServerSession {
  name: string;
  client: Client;
  transport: StdioClientTransport;
}

interface McpRuntime {
  servers: McpServerSession[];
  tools: OpenAIToolDefinition[];
  toolMap: Map<string, McpToolMapping>;
}

interface ToolLoopLimits {
  maxRounds: number;
  maxToolCallsTotal: number;
  maxToolCallsPerRound: number;
  toolTimeoutMs: number;
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

function extractAssistantText(content: ChatCompletionChoiceMessage['content']): string | null {
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

function normalizeSchema(schema: unknown): Record<string, unknown> {
  if (schema && typeof schema === 'object') return schema as Record<string, unknown>;
  return { type: 'object', properties: {} };
}

function stringifyToolResult(result: unknown): string {
  if (!result || typeof result !== 'object') {
    return typeof result === 'string' ? result : JSON.stringify(result);
  }

  const obj = result as Record<string, unknown>;
  const textParts: string[] = [];

  if (Array.isArray(obj.content)) {
    for (const part of obj.content) {
      if (!part || typeof part !== 'object') continue;
      const contentPart = part as Record<string, unknown>;
      if (contentPart.type === 'text' && typeof contentPart.text === 'string') {
        textParts.push(contentPart.text);
      }
    }
  }

  if (textParts.length > 0) {
    return textParts.join('\n\n');
  }

  if (obj.structuredContent !== undefined) {
    try {
      return JSON.stringify(obj.structuredContent);
    } catch {
      return String(obj.structuredContent);
    }
  }

  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

function getMessageFromResponse(payload: ChatCompletionResponse): ChatCompletionChoice['message'] {
  return payload.choices?.[0]?.message;
}

function buildStdioEnv(serverEnv?: Record<string, string>): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) merged[key] = value;
  }
  if (serverEnv) {
    for (const [key, value] of Object.entries(serverEnv)) {
      merged[key] = value;
    }
  }
  return merged;
}

function toOpenAIToolName(serverName: string, toolName: string): string {
  const base = `${serverName}__${toolName}`
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!base) return 'tool';
  return base.slice(0, 64);
}

function hashString(input: string): string {
  // FNV-1a 32-bit; deterministic suffix for collision handling.
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function resolveToolLoopLimits(env: Record<string, string | undefined>): ToolLoopLimits {
  const maxRounds = parseOptionalPositiveInt(env, 'OPENAI_MAX_TOOL_ROUNDS') ?? DEFAULT_MAX_ROUNDS;
  const maxToolCallsTotal = parseOptionalPositiveInt(env, 'OPENAI_MAX_TOOL_CALLS_TOTAL') ?? DEFAULT_MAX_TOOL_CALLS_TOTAL;
  const maxToolCallsPerRound =
    parseOptionalPositiveInt(env, 'OPENAI_MAX_TOOL_CALLS_PER_ROUND') ?? DEFAULT_MAX_TOOL_CALLS_PER_ROUND;
  const toolTimeoutMs = parseOptionalPositiveInt(env, 'OPENAI_TOOL_TIMEOUT_MS') ?? DEFAULT_TOOL_TIMEOUT_MS;
  return { maxRounds, maxToolCallsTotal, maxToolCallsPerRound, toolTimeoutMs };
}

export class OpenAIProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  private readonly env: Record<string, string | undefined>;
  private readonly mcpServers: Record<string, McpServerConfig>;
  private readonly sessions = new Map<string, OpenAIMessage[]>();

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
    const continuation = this.resolveContinuation(input.continuation);
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
      let limits: ToolLoopLimits;
      let mcpRuntime: McpRuntime;

      try {
        baseUrl = normalizeBaseUrl(self.requireEnv('OPENAI_BASE_URL'));
        apiKey = self.requireEnv('OPENAI_API_KEY');
        model = self.requireEnv('OPENAI_MODEL');
        timeoutMs = parseOptionalPositiveInt(self.env, 'OPENAI_TIMEOUT_MS') ?? DEFAULT_TIMEOUT_MS;
        maxTokens = parseOptionalPositiveInt(self.env, 'OPENAI_MAX_TOKENS');
        temperature = parseOptionalNumber(self.env, 'OPENAI_TEMPERATURE');
        limits = resolveToolLoopLimits(self.env);
        // Query-scoped MCP clients/transports: build at query start, close in
        // finally. This avoids cross-query leaked subprocesses.
        mcpRuntime = await self.connectMcpServers();
      } catch (err) {
        yield { type: 'error', message: extractErrorMessage(err) || 'Invalid openai provider configuration', retryable: false };
        return;
      }

      try {
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

          const turnCheckpoint = history.length;
          history.push({ role: 'user', content: userPrompt });

          let toolRounds = 0;
          let toolCallsTotal = 0;
          let turnDone = false;

          while (!turnDone && !aborted) {
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
              tools: mcpRuntime.tools,
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
                history.length = turnCheckpoint;
                nextPrompt = pendingFollowUps.join('\n\n');
                pendingFollowUps = [];
                turnDone = true;
                continue;
              }

              if (isAbortError(requestError)) {
                return;
              }

              history.length = turnCheckpoint;
              yield {
                type: 'error',
                message: extractErrorMessage(requestError) || 'OpenAI-compatible request failed',
                retryable: false,
              };
              return;
            }

            if (!response) {
              history.length = turnCheckpoint;
              yield { type: 'error', message: 'OpenAI-compatible provider returned an empty response', retryable: false };
              return;
            }

            if (response.error?.message) {
              history.length = turnCheckpoint;
              yield { type: 'error', message: response.error.message, retryable: false };
              return;
            }

            const message = getMessageFromResponse(response);
            if (!message) {
              history.length = turnCheckpoint;
              yield { type: 'error', message: 'OpenAI-compatible provider returned no message choice', retryable: false };
              return;
            }

            const assistantText = extractAssistantText(message.content);
            const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];

            if (toolCalls.length === 0) {
              if (assistantText === null) {
                history.length = turnCheckpoint;
                yield {
                  type: 'error',
                  message: 'OpenAI-compatible provider returned an empty assistant response',
                  retryable: false,
                };
                return;
              }
              history.push({ role: 'assistant', content: assistantText });
              yield { type: 'result', text: assistantText };
              turnDone = true;
              continue;
            }

            toolRounds += 1;
            if (toolRounds > limits.maxRounds) {
              history.length = turnCheckpoint;
              yield {
                type: 'error',
                message: `Exceeded maximum tool-call rounds (${limits.maxRounds})`,
                retryable: false,
              };
              return;
            }
            if (toolCalls.length > limits.maxToolCallsPerRound) {
              history.length = turnCheckpoint;
              yield {
                type: 'error',
                message: `Exceeded maximum tool calls in a single round (${limits.maxToolCallsPerRound})`,
                retryable: false,
              };
              return;
            }
            if (toolCallsTotal + toolCalls.length > limits.maxToolCallsTotal) {
              history.length = turnCheckpoint;
              yield {
                type: 'error',
                message: `Exceeded maximum total tool calls (${limits.maxToolCallsTotal})`,
                retryable: false,
              };
              return;
            }

            history.push({
              role: 'assistant',
              content: assistantText,
              tool_calls: toolCalls,
            });

            let interruptedDuringTools = false;

            for (const toolCall of toolCalls) {
              if (aborted) return;
              if (interruptRequested) {
                interruptedDuringTools = true;
                break;
              }

              const parsedTool = self.prepareToolCall(toolCall, mcpRuntime);
              if (!parsedTool.ok) {
                history.push({
                  role: 'tool',
                  tool_call_id: toolCall.id,
                  content: parsedTool.message,
                });
                toolCallsTotal += 1;
                continue;
              }

              const callPromise = parsedTool.server.client.callTool(
                {
                  name: parsedTool.originalToolName,
                  arguments: parsedTool.args,
                },
                undefined,
                { timeout: limits.toolTimeoutMs },
              );
              log(`Tool call requested: ${parsedTool.server.name}:${parsedTool.originalToolName}`);

              let settled = false;
              let toolResult: unknown;
              let toolError: unknown;
              const callStart = Date.now();

              while (!settled) {
                if (aborted) return;
                if (interruptRequested) {
                  interruptedDuringTools = true;
                  break;
                }
                if (Date.now() - callStart >= limits.toolTimeoutMs) {
                  toolError = new Error(`Tool execution timed out after ${limits.toolTimeoutMs}ms`);
                  break;
                }

                const remainingMs = limits.toolTimeoutMs - (Date.now() - callStart);
                const pulseMs = Math.max(1, Math.min(ACTIVITY_PULSE_MS, remainingMs));
                const tick = await Promise.race([
                  callPromise.then((value) => ({ kind: 'result' as const, value })).catch((error: unknown) => ({
                    kind: 'error' as const,
                    error,
                  })),
                  sleep(pulseMs).then(() => ({ kind: 'pulse' as const })),
                ]);

                if (tick.kind === 'pulse') {
                  yield { type: 'activity' };
                  continue;
                }

                settled = true;
                if (tick.kind === 'error') {
                  toolError = tick.error;
                } else {
                  toolResult = tick.value;
                }
              }

              if (interruptedDuringTools) {
                void callPromise.catch(() => {});
                break;
              }

              const toolOutput = toolError
                ? `Tool execution failed: ${extractErrorMessage(toolError)}`
                : stringifyToolResult(toolResult);
              if (!toolError) {
                log(`Tool call succeeded: ${parsedTool.server.name}:${parsedTool.originalToolName}`);
              }
              history.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                content: toolOutput,
              });
              toolCallsTotal += 1;
            }

            if (interruptedDuringTools && pendingFollowUps.length > 0) {
              history.length = turnCheckpoint;
              nextPrompt = pendingFollowUps.join('\n\n');
              pendingFollowUps = [];
              turnDone = true;
              continue;
            }
            if (interruptedDuringTools) {
              return;
            }
          }

          if (pendingFollowUps.length === 0) return;
          nextPrompt = pendingFollowUps.join('\n\n');
          pendingFollowUps = [];
        }
      } finally {
        await self.closeMcpRuntime(mcpRuntime);
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

  private ensureSessionHistory(sessionId: string): OpenAIMessage[] {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const history: OpenAIMessage[] = [];
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

  private async connectMcpServers(): Promise<McpRuntime> {
    const servers: McpServerSession[] = [];
    const discoveredTools: McpToolSpec[] = [];

    for (const [serverName, config] of Object.entries(this.mcpServers).sort(([a], [b]) => a.localeCompare(b))) {
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args ?? [],
        env: buildStdioEnv(config.env),
      });

      const client = new Client({
        name: `nanoclaw-openai-${serverName}`,
        version: '1.0.0',
      });

      try {
        await client.connect(transport);
        servers.push({ name: serverName, client, transport });

        const listed = await client.listTools();
        for (const tool of listed.tools ?? []) {
          const originalToolName = tool.name;
          const openaiToolName = toOpenAIToolName(serverName, originalToolName);
          discoveredTools.push({
            openaiToolName,
            originalToolName,
            serverName,
            description: tool.description,
            inputSchema: normalizeSchema(tool.inputSchema),
          });
        }

        log(`Connected MCP server '${serverName}' (${listed.tools?.length ?? 0} tools)`);
      } catch (err) {
        log(`Failed to initialize MCP server '${serverName}': ${extractErrorMessage(err)}`);
      }
    }

    const toolMap = new Map<string, McpToolMapping>();
    const tools: OpenAIToolDefinition[] = [];

    for (const spec of discoveredTools) {
      const key = `${spec.serverName}:${spec.originalToolName}`;
      let name = spec.openaiToolName;
      if (toolMap.has(name)) {
        const suffix = hashString(key).slice(0, 8);
        name = `${name.slice(0, Math.max(1, 64 - (suffix.length + 1)))}_${suffix}`;
      }
      if (!OPENAI_TOOL_NAME_RE.test(name)) {
        log(`Skipping MCP tool '${spec.serverName}:${spec.originalToolName}' (invalid OpenAI tool name)`);
        continue;
      }

      toolMap.set(name, {
        openaiToolName: name,
        originalToolName: spec.originalToolName,
        serverName: spec.serverName,
      });

      tools.push({
        type: 'function',
        function: {
          name,
          description: spec.description,
          parameters: spec.inputSchema,
        },
      });
    }

    return { servers, tools, toolMap };
  }

  private async closeMcpRuntime(runtime: McpRuntime): Promise<void> {
    for (const server of runtime.servers) {
      try {
        await server.client.close();
      } catch {
        // Best effort.
      }
      try {
        await server.transport.close();
      } catch {
        // Best effort.
      }
    }
  }

  private prepareToolCall(
    toolCall: OpenAIToolCall,
    mcpRuntime: McpRuntime,
  ):
    | { ok: true; server: McpServerSession; originalToolName: string; args: Record<string, unknown> }
    | { ok: false; message: string } {
    if (toolCall.type !== 'function' || !toolCall.function?.name) {
      return { ok: false, message: 'Invalid tool call: missing function name' };
    }

    const mapped = mcpRuntime.toolMap.get(toolCall.function.name);
    if (!mapped) {
      return { ok: false, message: `Unknown tool: ${toolCall.function.name}` };
    }

    const server = mcpRuntime.servers.find((candidate) => candidate.name === mapped.serverName);
    if (!server) {
      return { ok: false, message: `Tool server unavailable: ${mapped.serverName}` };
    }

    let args: Record<string, unknown> = {};
    const rawArgs = toolCall.function.arguments?.trim();
    if (rawArgs) {
      try {
        const parsed = JSON.parse(rawArgs) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>;
        } else {
          return { ok: false, message: 'Tool arguments must be a JSON object' };
        }
      } catch (err) {
        return { ok: false, message: `Invalid tool arguments JSON: ${extractErrorMessage(err)}` };
      }
    }

    return {
      ok: true,
      server,
      originalToolName: mapped.originalToolName,
      args,
    };
  }

  private async requestChatCompletion(args: {
    baseUrl: string;
    apiKey: string;
    model: string;
    messages: OpenAIMessage[];
    timeoutMs: number;
    maxTokens?: number;
    temperature?: number;
    tools: OpenAIToolDefinition[];
    signal: AbortSignal;
  }): Promise<ChatCompletionResponse> {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, args.timeoutMs);

    const abortHandler = (): void => controller.abort();
    args.signal.addEventListener('abort', abortHandler, { once: true });

    try {
      const payload: Record<string, unknown> = {
        model: args.model,
        messages: args.messages,
      };
      if (typeof args.maxTokens === 'number') payload.max_tokens = args.maxTokens;
      if (typeof args.temperature === 'number') payload.temperature = args.temperature;
      if (args.tools.length > 0) payload.tools = args.tools;

      let response: Response;
      try {
        response = await fetch(`${args.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${args.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } catch (err) {
        if (timedOut) {
          throw new Error(`OpenAI-compatible request timed out after ${args.timeoutMs}ms`);
        }
        throw err;
      }

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
