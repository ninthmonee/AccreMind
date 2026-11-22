import {
  Boxes,
  Bug,
  GitFork,
  type LucideIcon,
  ScrollText,
  Workflow,
} from 'lucide-react';
import type { AttentionKind, EntryStatus, Freshness, KnowledgeLayer, KnowledgeType, Maturity, Priority, ScopeVerdict, Serving, StorageZone } from './types';

export type Tone = 'primary' | 'success' | 'warning' | 'danger' | 'info' | 'neutral';

export const LAYERS: { value: KnowledgeLayer; label: string; hint: string }[] = [
  { value: 'domain', label: '领域知识', hint: '业务规则，同业务领域的仓库共享' },
  { value: 'project', label: '项目知识', hint: '只在本仓库生效的实现与约束' },
  { value: 'shared_tech', label: '通用技术', hint: '语言/框架/依赖本身的经验，同技术栈仓库共享' },
  { value: 'team_rule', label: '团队规范', hint: '常驻提示的强约束，只能经审核产生' },
  { value: 'personal', label: '个人技术', hint: '只对你本人生效，跟随你到每个仓库' },
];
export const layerLabel = (v: KnowledgeLayer) => LAYERS.find((l) => l.value === v)?.label ?? v;

export const TYPES: { value: KnowledgeType; label: string; icon: LucideIcon; fields: string }[] = [
  { value: 'pitfall', label: '排障陷阱', icon: Bug, fields: '故障现象 · 根因 · 验证范围' },
  { value: 'decision', label: '架构决策', icon: GitFork, fields: '约束 · 备选方案 · 取舍' },
  { value: 'guideline', label: '规范', icon: ScrollText, fields: '判定规则 · 正反例 · 例外' },
  { value: 'model', label: '领域模型', icon: Boxes, fields: '核心实体 · 不变量 · 边界' },
  { value: 'process', label: '操作流程', icon: Workflow, fields: '触发条件 · 顺序 · 失败恢复' },
];
export const typeMeta = (v: KnowledgeType) => TYPES.find((t) => t.value === v) ?? TYPES[0]!;

export const STATUS: Record<EntryStatus, { label: string; tone: Tone }> = {
  candidate: { label: '待审核', tone: 'info' },
  probation: { label: '试用中', tone: 'warning' },
  active: { label: '已入库', tone: 'success' },
  archived: { label: '已归档', tone: 'neutral' },
  withdrawn: { label: '已撤回', tone: 'danger' },
};
export const MATURITY: Record<Maturity, { label: string; tone: Tone; rank: number }> = {
  draft: { label: '草稿', tone: 'neutral', rank: 0 },
  verified: { label: '已验证', tone: 'info', rank: 1 },
  proven: { label: '多次验证', tone: 'success', rank: 2 },
};
export const FRESHNESS: Record<Freshness, { label: string; tone: Tone }> = {
  current: { label: '当前适用', tone: 'success' },
  review_due: { label: '待复核', tone: 'warning' },
  stale: { label: '已失效', tone: 'danger' },
};
export const SERVING: Record<Serving, { label: string; tone: Tone }> = {
  enabled: { label: '检索启用', tone: 'success' },
  suspended: { label: '检索暂停', tone: 'danger' },
};
export const PRIORITY: Record<Priority, { label: string; tone: Tone }> = {
  P0: { label: '严重事故', tone: 'danger' },
  P1: { label: '重复排障', tone: 'warning' },
  P2: { label: '辅助理解', tone: 'neutral' },
};
export const ZONE: Record<StorageZone, string> = {
  project: '项目经验库',
  rules: '团队规范',
  probation: '本机试用池',
  personal: '个人知识',
  shared_tech: '通用技术库',
  domain: '本机领域库',
};

/** Server-side applicability verdicts shown next to search hits and reminders. */
export const SCOPE_VERDICT: Record<ScopeVerdict, { label: string; tone: Tone }> = {
  own_repo: { label: '本仓库', tone: 'neutral' },
  domain_match: { label: '同领域', tone: 'primary' },
  stack_match: { label: '同技术栈', tone: 'info' },
  owner_match: { label: '个人经验', tone: 'neutral' },
  cross_ref: { label: '跨仓库参考', tone: 'warning' },
};

export const ATTENTION: Record<AttentionKind, { label: string; hint: string }> = {
  probation_silent: { label: '试用期满', hint: '试用期满仍没有人反馈，决定是否保留' },
  inapplicable: { label: '不适用', hint: '多次被标记为“不适用”，已暂停提醒' },
  rule_conflict: { label: '与规范冲突', hint: '与团队规范相反且没有登记豁免，已停止提醒' },
};
export const EVIDENCE_SOURCE: Record<string, string> = {
  git_commit: 'Git 提交',
  file_lines: '代码片段',
  test_run: '测试运行',
  doc_ref: '文档',
  session_turn: '对话回合',
};
export const DISCOVERABILITY: Record<string, { label: string; tone: Tone }> = {
  code_recoverable: { label: '代码可直接恢复', tone: 'neutral' },
  authoritative_source: { label: '已有权威文档', tone: 'info' },
  missing_context: { label: '代码外缺失上下文', tone: 'primary' },
  inconclusive: { label: '证据不足', tone: 'warning' },
};
export const CHECK_METHOD: Record<string, string> = {
  human_review: '人工审核',
  single_pass_check: '单次评估',
  isolated_check: '隔离双检',
};
