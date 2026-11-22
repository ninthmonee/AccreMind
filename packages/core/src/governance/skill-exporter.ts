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
  /** Shared-tech entries are machine-wide; writing one into this repository must be confirmed explicitly. */
  confirmRepositoryCopy?: boolean;
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
  if (entry.layer === 'personal') {
    throw new Error('个人经验只属于你自己，不能导出为仓库技能（导出的文件会随 Git 分享给团队）');
  }
  if (entry.layer === 'shared_tech' && options.confirmRepositoryCopy !== true) {
    throw new Error('这是本机所有仓库共用的通用技术经验，导出会把一份副本写进当前仓库并随 Git 分享。确认后请带上 confirm_repository_copy=true 再导出');
  }
  const owner = options.store.findOwner(entry.id);
  if (owner && !options.store.isOwnedSource(owner)) {
    throw new Error(`该经验属于仓库 ${owner}，请在该仓库中导出技能`);
  }
  if (entry.status !== 'active' || entry.freshness !== 'current' || entry.serving !== 'enabled') {
    throw new Error('请先确认条目已转正、仍然适用且已启用检索，再导出技能');
  }
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
