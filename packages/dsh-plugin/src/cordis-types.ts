import type { LlmInferenceAdapter } from '@accremind/core';

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
  assistantReply?: string;
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
 * Native `@deepseek-ai/dsh` `tools/post-execute` waterfall execution context
 */
export interface DshNativeToolPostExecuteContext {
  sessionId?: string;
  tool: string;
  args: Record<string, unknown>;
  output: DshToolResult;
}

export interface DshProjectedMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

/**
 * Full Cordis Context interface aligned with `@deepseek-ai/cordis` & `@deepseek-ai/dsh`:
 * - `ctx.tools.register(...)` (`@deepseek-ai/dsh-tools`)
 * - `ctx.systemPrompt.section(...)` (`@deepseek-ai/dsh-system-prompt`)
 * - `ctx.sessions.registerMessageProjection(...)`
 * - `ctx.on('tools/post-execute', ...)` & turn lifecycle hooks
 * - `ctx.provide('accremind', ...)`
 * - `ctx.webui.registerRpc(...)`
 */
export interface CordisContext {
  effect(setup: () => () => void): void;
  provide?(serviceName: string, instance?: unknown): void;
  on?(event: string, listener: (...args: any[]) => unknown): () => void;
  tools?: {
    register(tool: DshToolDefinition<any>): (() => void) | void;
  };
  systemPrompt?: {
    section(spec: {
      name: string;
      order?: number;
      text: () => string | Promise<string>;
    }): (() => void) | void;
  };
  sessions?: {
    registerMessageProjection?(
      projector: (ctx: {
        sessionId: string;
        messages: DshProjectedMessage[];
      }) => DshProjectedMessage[] | Promise<DshProjectedMessage[]>,
    ): (() => void) | void;
  };
  llm?: LlmInferenceAdapter;
  webui?: {
    registerRpc?(
      method: string,
      handler: (params: Record<string, unknown>) => Promise<unknown> | unknown,
    ): (() => void) | void;
    registerSlot?(slotSpec: {
      slot: 'turn-footer' | 'sidebar-panel';
      id: string;
      title: string;
      renderHtml?: () => string;
    }): (() => void) | void;
  };
}
