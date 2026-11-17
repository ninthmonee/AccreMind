export interface DshToolContentBlock {
  type: 'text';
  text: string;
}

export interface DshToolResult {
  content: DshToolContentBlock[];
  isError?: boolean;
}

export interface DshToolDefinition<TArgs = Record<string, unknown>> {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  execute(args: TArgs, execContext?: { sessionId?: string }): Promise<DshToolResult> | DshToolResult;
}

export interface DshTurnHookPayload {
  sessionId: string;
  userPrompt?: string;
  activeFiles?: string[];
  errorOutput?: string;
  injectSystemStablePrefix?: (prefix: string) => void;
  injectTurnEphemeralContext?: (block: string) => void;
}

export interface DshToolAfterHookPayload {
  sessionId: string;
  toolName: string;
  args: Record<string, unknown>;
  result: DshToolResult;
}

/**
 * Structural Cordis Context seam compatible with `@deepseek-ai/cordis`
 * without requiring external registry access during offline builds or unit tests.
 */
export interface CordisContext {
  effect(setup: () => () => void): void;
  on?(event: string, listener: (...args: unknown[]) => unknown): () => void;
  tools?: {
    register(tool: DshToolDefinition<any>): (() => void) | void;
  };
  webui?: {
    registerRpc?(
      method: string,
      handler: (params: Record<string, unknown>) => Promise<unknown> | unknown,
    ): (() => void) | void;
  };
}
