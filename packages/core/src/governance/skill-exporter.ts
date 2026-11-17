import * as path from 'node:path';
import { writeFileAtomicSync } from '../codec/atomic-fs.ts';
import type { KnowledgeEntry } from '../contracts/types.ts';
import type { LocalMarkdownSqliteStore } from '../store/local-store.ts';
import { sanitizeKnowledgeText } from '../view/sanitizer.ts';

const SAFE_SLUG_REGEX = /^[a-z0-9][a-z0-9-_]{1,62}$/;

/**
 * Exports a `verified` or `proven` engineering experience entry into a native
 * DeepSeek Harness skill file (`<repo>/.dsh/skills/<slug>/SKILL.md`), bridging
 * `dsh-mnemon` Self-Evolving Skills with PRD §6.8.7 Enforcement!
 */
export function exportEntryToDshSkill(options: {
  store: LocalMarkdownSqliteStore;
  entryId: string;
  skillSlug: string;
}): { skillRelPath: string; updatedEntry: KnowledgeEntry } {
  if (!SAFE_SLUG_REGEX.test(options.skillSlug)) {
    throw new Error(
      `非法技能目录标识 "${options.skillSlug}"：仅允许小写字母、数字、连字符与下划线`,
    );
  }

  const outcome = options.store.getEntry(options.entryId, { recordUsage: false });
  if (!outcome.found || !outcome.servable) {
    throw new Error(`无法导出不可服务或不存在的条目: ${options.entryId}`);
  }

  const entry = outcome.entry;
  if (entry.maturity !== 'verified' && entry.maturity !== 'proven') {
    throw new Error(
      `仅允许将已验证 (verified/proven) 的经验导出为 DSH Skill，当前 ${entry.id} 成熟度为 ${entry.maturity}`,
    );
  }

  const skillRelPath = path.posix.join('.dsh', 'skills', options.skillSlug, 'SKILL.md');
  const absSkillPath = path.join(options.store.paths.projectRoot, skillRelPath);

  const content = [
    '---',
    `name: ${JSON.stringify(options.skillSlug)}`,
    `description: ${JSON.stringify(`${entry.title} (Derived from AccreMind ${entry.id}@r${entry.revision})`)}`,
    '---',
    '',
    `# ${sanitizeKnowledgeText(entry.title)}`,
    '',
    `> 来源经验：\`${entry.id}@r${entry.revision}\` · 成熟度：\`${entry.maturity}\` · 优先级：\`${entry.priority}\``,
    '',
    '## 适用前置条件',
    ...entry.preconditions.map((p) => `- ${sanitizeKnowledgeText(p)}`),
    '',
    '## 核心执行准则',
    sanitizeKnowledgeText(entry.claim),
    '',
    '## 为什么必须遵守（代码外背景增量）',
    sanitizeKnowledgeText(entry.knowledge_delta || entry.rationale),
    '',
    '## 验证方法',
    sanitizeKnowledgeText(entry.verification_method),
    '',
    '## 失效与复核触发条件',
    ...entry.invalidation_triggers.map((t) => `- ${sanitizeKnowledgeText(t)}`),
    '',
  ].join('\n');

  writeFileAtomicSync(absSkillPath, content);

  const updated: KnowledgeEntry = {
    ...entry,
    enforcement: {
      kind: 'skill',
      status: 'implemented',
      ref: skillRelPath,
    },
    updated_at: new Date().toISOString(),
  };

  const persisted = options.store.updateExistingEntryDirect(updated);
  return { skillRelPath, updatedEntry: persisted };
}
