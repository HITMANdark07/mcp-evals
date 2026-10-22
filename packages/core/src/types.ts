export type JsonObject = Record<string, unknown>;

// ---- Suites --------------------------------------------------------------
export interface FixtureSpec {
  git: string;
  ref: string;
}

export interface ServerSpec {
  command?: string;
  args: string[];
  env: Record<string, string>;
  url?: string;
  headers: Record<string, string>;
  setup?: string;
}

/** The JSON Schema subset supported by answer_json_schema. */
export interface JsonSchema {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  minItems?: number;
  additionalProperties?: boolean;
}

interface GraderBase {
  /** When set, the grader only applies to runs against this server; otherwise it is skipped. */
  server?: string;
}

export type GraderSpec =
  | (GraderBase & { type: 'answer_contains_all'; values: string[]; caseSensitive: boolean })
  | (GraderBase & { type: 'answer_matches'; pattern: string; flags: string })
  | (GraderBase & { type: 'answer_json_schema'; schema: JsonSchema })
  | (GraderBase & { type: 'llm_judge'; rubric: string; passThreshold?: number })
  | (GraderBase & { type: 'tool_called'; tool: string })
  | (GraderBase & { type: 'tool_not_called'; tool: string })
  | (GraderBase & { type: 'tool_args_match'; tool: string; args: JsonObject })
  | (GraderBase & { type: 'fs_state'; path: string; exists?: boolean; contains?: string; unchanged?: boolean })
  | (GraderBase & { type: 'max_steps'; value: number; strict: boolean })
  | (GraderBase & { type: 'max_context_tokens'; value: number; strict: boolean });

export type GraderType = GraderSpec['type'];

export interface TaskSpec {
  id: string;
  prompt: string;
  servers?: string[];
  maxSteps?: number;
  timeoutS?: number;
  /** Substituted as {name} into the server's command, args, env and setup, and into the prompt. */
  vars?: Record<string, string>;
  graders: GraderSpec[];
}

export interface RunDefaults {
  repeats: number;
  maxSteps: number;
  timeoutS: number;
  temperature: number;
  /** Per-call MCP tool timeout (suite defaults.tool_timeout_s, default 60). Hitting it is a model fail. */
  toolTimeoutS: number;
}

/** A model pinned to one OpenRouter provider slug. */
export interface ModelSpec {
  id: string;
  provider: string;
}

export interface Suite {
  name: string;
  version: number;
  /** Path (or label) the suite was loaded from. */
  source: string;
  fixture?: FixtureSpec;
  servers: Record<string, ServerSpec>;
  /** Model ids in suite order. */
  models: string[];
  /** OpenRouter provider slug per model id, for `{ id, provider }` entries. Plain-string entries (mock) have none. */
  modelPins: Record<string, string>;
  /** Pinned judge model for llm_judge graders (the suite's `judge:` block). */
  judge?: ModelSpec;
  defaults: RunDefaults;
  tasks: TaskSpec[];
}

// ---- Models --------------------------------------------------------------
export interface ToolCall {
  id: string;
  /** Function name as the model sees it (sanitized). */
  name: string;
  /** Raw JSON string exactly as the model produced it. */
  arguments: string;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: JsonObject;
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls?: ToolCall[]; providerMetadata?: unknown }
  | { role: 'tool'; toolCallId: string; content: string };

export interface ChatRequest {
  model: string;
  /** OpenRouter provider slug that must serve this request (no fallbacks). */
  providerPin?: string;
  messages: ChatMessage[];
  tools: ToolDef[];
  temperature: number;
  signal?: AbortSignal;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

export interface ChatResponse {
  content: string | null;
  toolCalls: ToolCall[];
  usage: Usage;
  latencyMs: number;
  /** Provider that actually served the call, when the API reports it. */
  servedBy?: string;
  /**
   * Opaque provider data that must travel back with this assistant message on later turns
   * (OpenRouter: `reasoning` / `reasoning_details`). Never interpreted, traced or graded.
   */
  providerMetadata?: unknown;
}

export interface ModelProvider {
  readonly name: string;
  chat(req: ChatRequest): Promise<ChatResponse>;
}

// ---- MCP -----------------------------------------------------------------
export interface McpTool {
  name: string;
  description?: string;
  inputSchema: JsonObject;
}

export interface ToolCallResult {
  text: string;
  isError: boolean;
}

export interface McpConnection {
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args: JsonObject, timeoutMs: number): Promise<ToolCallResult>;
  /** Captured server stderr (stdio servers only; '' otherwise). */
  stderr(): string;
  /** MCP serverInfo.version from initialize, when the server reported one. */
  serverVersion?(): string | undefined;
  /** Never throws. */
  close(): Promise<void>;
}

export interface ConnectContext {
  cwd: string;
  vars: Record<string, string>;
}

export type Connector = (server: ServerSpec, ctx: ConnectContext) => Promise<McpConnection>;

// ---- Traces & records ----------------------------------------------------
/** `t` is milliseconds since the run started. `step` is the 1-based model-call number. */
export type TraceEvent =
  | { type: 'model_call'; step: number; t: number; latencyMs: number; promptTokens: number; completionTokens: number; costUsd: number; servedBy?: string }
  | { type: 'tool_call'; step: number; t: number; callId: string; tool: string; args: JsonObject | null; rawArgs: string }
  | { type: 'tool_result'; step: number; t: number; callId: string; tool: string; isError: boolean; tokens: number; latencyMs: number; preview: string }
  | { type: 'final_answer'; step: number; t: number; text: string }
  | { type: 'error'; step: number; t: number; kind: string; message: string };

export type LoopEnd = 'final_answer' | 'max_steps' | 'timeout' | 'tool_timeout' | 'budget' | 'invalid_tool_call' | 'infra_error';

export interface GraderResult {
  type: GraderType;
  pass: boolean;
  /** Not applicable to this run's server. */
  skipped: boolean;
  /** Budget graders are recorded but do not decide pass/fail unless strict. */
  budget: boolean;
  detail: string;
  /** Spend of model-graded checks (llm_judge); added to the run's cost. */
  costUsd?: number;
}

export type Outcome = 'pass' | 'fail' | 'error';

/** One line of traces.jsonl: the run's identity, why it ended, and its events. */
export interface Trace {
  runKey: string;
  suite: string;
  server: string;
  model: string;
  task: string;
  repeat: number;
  outcome: Outcome;
  end: LoopEnd | null;
  failReason?: string;
  graders: GraderResult[];
  attempts: number;
  costUsd: number;
  steps: number;
  contextTokens: number;
  latencyMs: number;
  events: TraceEvent[];
  serverStderr: string;
}

export interface RunRecord {
  runKey: string;
  suite: string;
  server: string;
  model: string;
  task: string;
  repeat: number;
  outcome: Outcome;
  end: LoopEnd | null;
  failReason?: string;
  graders: GraderResult[];
  toolSelectionOk: boolean | null;
  steps: number;
  contextTokens: number;
  latencyMs: number;
  costUsd: number;
  attempts: number;
  /** MCP serverInfo.version of the server this run used. */
  serverVersion?: string;
  trace: Trace;
}

/** Runs the plan scheduled for one suite × server × model cell. */
export interface PlannedCell {
  suite: string;
  server: string;
  model: string;
  runs: number;
}
