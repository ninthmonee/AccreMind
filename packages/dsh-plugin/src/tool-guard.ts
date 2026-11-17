import * as path from 'node:path';
import type { ViewCompiler } from '@accremind/core';
import type { DshToolResult } from './cordis-types.ts';

const FILE_TOOL_NAMES = new Set([
  'read_file',
  'edit_file',
  'write_file',
  'replace_in_file',
  'multi_edit',
  'patch_file',
]);

export function extractTargetRelativePath(
  projectRoot: string,
  toolName: string,
  args: Record<string, unknown>,
): string | null {
  if (!FILE_TOOL_NAMES.has(toolName)) return null;

  const rawCandidate =
    args.path ?? args.file_path ?? args.filePath ?? args.Path ?? args.target_file;
  if (typeof rawCandidate !== 'string' || !rawCandidate.trim()) {
    return null;
  }

  const resolvedProject = path.resolve(projectRoot);
  const resolvedTarget = path.isAbsolute(rawCandidate)
    ? path.resolve(rawCandidate)
    : path.resolve(resolvedProject, rawCandidate);

  const rel = path.relative(resolvedProject, resolvedTarget).replace(/\\/g, '/');
  if (!rel || rel.startsWith('..')) {
    return null;
  }
  return rel;
}

/**
 * Optimization #1: Mid-turn Just-in-Time Tool Guard!
 * Appends `<accremind-guard>` to file read/edit tool responses when touching a high-priority
 * anchored file that was NOT surfaced during `beforeTurn`.
 */
export function interceptFileToolResult(options: {
  projectRoot: string;
  viewCompiler: ViewCompiler;
  sessionId: string;
  sessionSurfacedIds: Set<string>;
  toolName: string;
  args: Record<string, unknown>;
  result: DshToolResult;
  workspaceDependencies?: Record<string, string>;
}): { result: DshToolResult; newlySurfacedIds: string[] } {
  const relPath = extractTargetRelativePath(options.projectRoot, options.toolName, options.args);
  if (!relPath) {
    return { result: options.result, newlySurfacedIds: [] };
  }

  const { guardBlock, newlySurfacedIds } = options.viewCompiler.compileFileToolGuard({
    sessionId: options.sessionId,
    filePath: relPath,
    sessionSurfacedIds: options.sessionSurfacedIds,
    workspaceDependencies: options.workspaceDependencies,
  });

  if (!guardBlock) {
    return { result: options.result, newlySurfacedIds: [] };
  }

  return {
    newlySurfacedIds,
    result: {
      ...options.result,
      content: [
        ...options.result.content,
        {
          type: 'text',
          text: `\n\n${guardBlock}`,
        },
      ],
    },
  };
}
