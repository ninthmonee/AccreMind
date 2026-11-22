import { ENTRY_ID_PATTERN as ID_PATTERN } from './ids.ts';
import {
  DISCOVERABILITY_STATES,
  DISPOSITIONS,
  ENTRY_STATUSES,
  FRESHNESS_STATES,
  KNOWLEDGE_LAYERS,
  KNOWLEDGE_TYPES,
  MATURITY_LEVELS,
  PRIORITIES,
  SERVING_STATUSES,
  type CaptureAssessment,
  type Discoverability,
  type Disposition,
  type KnowledgeEntry,
} from './types.ts';

const WINDOWS_ABS_PATH = /^[A-Za-z]:[\\/]/;

export interface ValidationIssue {
  field: string;
  message: string;
}

export type GateCheckResult =
  | { ok: true }
  | { ok: false; missingFields: string[]; issues: ValidationIssue[] };

export function isAbsoluteMachinePath(locator: string): boolean {
  const trimmed = locator.trim();
  return (
    trimmed.startsWith('/') ||
    trimmed.startsWith('~/') ||
    WINDOWS_ABS_PATH.test(trimmed) ||
    trimmed.startsWith('file://')
  );
}

/**
 * Enforces closed mapping between `discoverability` (4 states) and `disposition` (5 states),
 * resolving PRD V2.1 Gap #2 deterministically.
 */
export function validateDispositionClosure(
  discoverability: Discoverability,
  disposition: Disposition,
  options: { isAuthoritativeMirror?: boolean; hasUnverifiedAssertions?: boolean } = {},
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!DISCOVERABILITY_STATES.includes(discoverability)) {
    issues.push({ field: 'discoverability', message: `非法可发现性枚举: ${String(discoverability)}` });
    return issues;
  }
  if (!DISPOSITIONS.includes(disposition)) {
    issues.push({ field: 'disposition', message: `非法分流枚举: ${String(disposition)}` });
    return issues;
  }

  switch (discoverability) {
    case 'code_recoverable':
      if (disposition !== 'index_only' && disposition !== 'discard') {
        issues.push({
          field: 'disposition',
          message: '当前代码已可恢复该事实（code_recoverable），必须分流至 index_only 或 discard，禁止作为新增经验发布',
        });
      }
      break;
    case 'authoritative_source':
      if (disposition !== 'link_existing' && !(options.isAuthoritativeMirror && disposition === 'knowledge_candidate')) {
        issues.push({
          field: 'disposition',
          message: '已有权威文档回答（authoritative_source），必须分流至 link_existing（除非经批准作为规范镜像）',
        });
      }
      break;
    case 'inconclusive':
      if (disposition !== 'needs_confirmation' && disposition !== 'discard') {
        issues.push({
          field: 'disposition',
          message: '查阅未完成或证据不足（inconclusive），强制进入 needs_confirmation 或 discard，禁止伪装为 missing_context 发布',
        });
      }
      break;
    case 'missing_context':
      if (options.hasUnverifiedAssertions && disposition === 'knowledge_candidate') {
        issues.push({
          field: 'claim_evidence_map',
          message: '存在未经证实的推测断言（verified_fact=false），必须转入 needs_confirmation 或剥离推测后再提交',
        });
      }
      break;
  }

  return issues;
}

export function validateCaptureAssessment(assessment: CaptureAssessment): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!assessment.id?.trim()) {
    issues.push({ field: 'id', message: '缺少判定记录 ID' });
  }
  if (!assessment.question || assessment.question.trim().length < 6) {
    issues.push({ field: 'question', message: 'question 必须为独立且不少于 6 个字符的中立场景问题' });
  }
  if (!assessment.source_fingerprint?.trim()) {
    issues.push({ field: 'source_fingerprint', message: '缺少源事件幂等指纹 source_fingerprint' });
  }
  if (!PRIORITIES.includes(assessment.priority)) {
    issues.push({ field: 'priority', message: `非法优先级: ${String(assessment.priority)}` });
  }

  const hasUnverified = assessment.claim_evidence_map.some((item) => !item.verified_fact);
  issues.push(
    ...validateDispositionClosure(assessment.discoverability, assessment.disposition, {
      hasUnverifiedAssertions: hasUnverified,
    }),
  );

  if (assessment.disposition === 'knowledge_candidate') {
    if (!assessment.knowledge_delta?.trim()) {
      issues.push({
        field: 'knowledge_delta',
        message: '分流为 knowledge_candidate 时 knowledge_delta 不能为空',
      });
    }
    if (
      assessment.claim_evidence_map.length === 0 ||
      assessment.claim_evidence_map.some((m) => !m.evidence_locator?.trim())
    ) {
      issues.push({
        field: 'claim_evidence_map',
        message: '分流为 knowledge_candidate 时每条增量断言必须绑定真实 evidence_locator',
      });
    }
  }

  return issues;
}

export function validateKnowledgeEntrySchema(entry: KnowledgeEntry): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!ID_PATTERN.test(entry.id)) {
    issues.push({ field: 'id', message: `条目 ID 须为 K-/R-/P- 加 4–6 位数字或 14 位编号，当前: ${entry.id}` });
  }
  if (!Number.isInteger(entry.revision) || entry.revision < 1) {
    issues.push({ field: 'revision', message: 'revision 必须为正整数' });
  }
  if (!KNOWLEDGE_TYPES.includes(entry.type)) {
    issues.push({ field: 'type', message: `非法知识主类型: ${String(entry.type)}` });
  }
  if (entry.type === 'guideline' && entry.polarity !== 'recommend' && entry.polarity !== 'avoid') {
    issues.push({ field: 'polarity', message: 'guideline 类型必须指定 polarity (recommend | avoid)' });
  }
  if (!KNOWLEDGE_LAYERS.includes(entry.layer)) {
    issues.push({ field: 'layer', message: `非法知识层级: ${String(entry.layer)}` });
  }
  if (!ENTRY_STATUSES.includes(entry.status)) {
    issues.push({ field: 'status', message: `非法状态枚举: ${String(entry.status)}` });
  }
  // Machine-wide entries are served in other repositories: nothing in them may only make sense in one.
  if ((entry.layer === 'shared_tech' || entry.layer === 'personal') && entry.symbol_anchors.length > 0) {
    issues.push({ field: 'symbol_anchors', message: '通用技术和个人经验会在其他仓库使用，不能绑定某个仓库的代码符号；请改为项目知识或去掉锚点' });
  }
  if (entry.layer === 'personal' && entry.visibility && entry.visibility !== 'private') {
    issues.push({ field: 'visibility', message: '个人经验只能是 private' });
  }
  for (const o of entry.overrides ?? []) {
    if (!o.rule_id || !o.reason?.trim() || !o.approver?.trim() || !Number.isFinite(Date.parse(o.expires_at))) {
      issues.push({ field: 'overrides', message: '豁免团队规范需要写明规范编号、理由、批准人和到期日' });
    }
  }
  if (entry.overrides?.length && entry.layer !== 'project') {
    issues.push({ field: 'overrides', message: '只有项目知识可以登记对团队规范的豁免' });
  }
  if (!MATURITY_LEVELS.includes(entry.maturity)) {
    issues.push({ field: 'maturity', message: `非法成熟度枚举: ${String(entry.maturity)}` });
  }
  if (!FRESHNESS_STATES.includes(entry.freshness)) {
    issues.push({ field: 'freshness', message: `非法时效枚举: ${String(entry.freshness)}` });
  }
  if (!SERVING_STATUSES.includes(entry.serving)) {
    issues.push({ field: 'serving', message: `非法检索开关枚举: ${String(entry.serving)}` });
  }
  if (!PRIORITIES.includes(entry.priority)) {
    issues.push({ field: 'priority', message: `非法优先级枚举: ${String(entry.priority)}` });
  }
  if (!entry.title || entry.title.trim().length < 4) {
    issues.push({ field: 'title', message: '标题至少 4 个字符' });
  }
  if (!entry.claim || entry.claim.trim().length < 6) {
    issues.push({ field: 'claim', message: '核心结论 claim 不能为空且须具备可操作内容' });
  }
  if (!entry.rationale?.trim()) {
    issues.push({ field: 'rationale', message: '结论依据 rationale 不能为空（未知须写原因待确认并留待确认态）' });
  }
  if (!entry.verification_method?.trim()) {
    issues.push({ field: 'verification_method', message: '验证方法 verification_method 不能为空' });
  }

  return issues;
}

/**
 * S03 Hard Publish / Probation Gate (PRD §4.5, §6.8.5, §11.5).
 * Cannot be bypassed even if a caller invokes the store API directly without going through LLM prompts.
 */
export function enforceHardPublishGate(
  entry: KnowledgeEntry,
  assessment: CaptureAssessment | null,
): GateCheckResult {
  const issues: ValidationIssue[] = [...validateKnowledgeEntrySchema(entry)];

  if (!Array.isArray(entry.preconditions) || entry.preconditions.every((p) => !p.trim())) {
    issues.push({ field: 'preconditions', message: '缺少适用前置条件 preconditions' });
  }
  if (
    !Array.isArray(entry.invalidation_triggers) ||
    entry.invalidation_triggers.every((t) => !t.trim())
  ) {
    issues.push({ field: 'invalidation_triggers', message: '缺少失效触发条件 invalidation_triggers' });
  }
  if (!Array.isArray(entry.evidence) || entry.evidence.length === 0) {
    issues.push({ field: 'evidence', message: '缺少可追踪证据列表 evidence' });
  } else {
    for (const ev of entry.evidence) {
      if (!ev.locator?.trim() || !ev.source_ref?.trim()) {
        issues.push({ field: 'evidence.locator', message: `证据 ${ev.id} 缺少 source_ref 或 locator` });
      } else if (isAbsoluteMachinePath(ev.locator) || isAbsoluteMachinePath(ev.source_ref)) {
        issues.push({
          field: 'evidence.locator',
          message: `证据 ${ev.id} 禁止使用本机绝对路径 (${ev.locator})，必须使用仓库相对路径或稳定引用`,
        });
      }
    }
  }

  for (const anchor of entry.symbol_anchors ?? []) {
    if (isAbsoluteMachinePath(anchor.file_path)) {
      issues.push({
        field: 'symbol_anchors.file_path',
        message: `符号锚点禁止使用本机绝对路径: ${anchor.file_path}`,
      });
    }
  }

  if (entry.knowledge_role === 'experience') {
    if (!entry.knowledge_delta?.trim()) {
      issues.push({
        field: 'knowledge_delta',
        message: '经验条目 knowledge_delta 不能为空（无代码外新增信息的内容应转为 index_only）',
      });
    }
    if (!entry.capture_assessment_id || !assessment) {
      issues.push({
        field: 'capture_assessment_id',
        message: '经验条目必须关联有效的 CaptureAssessment 判定记录，禁止跳过增量评估直接发布',
      });
    } else {
      issues.push(...validateCaptureAssessment(assessment));
      if (assessment.disposition !== 'knowledge_candidate') {
        issues.push({
          field: 'disposition',
          message: `关联判定记录分流结果为 ${assessment.disposition}，不允许作为经验条目入库`,
        });
      }
    }
  }

  if (issues.length === 0) {
    return { ok: true };
  }

  return {
    ok: false,
    missingFields: issues.map((i) => `${i.field}: ${i.message}`),
    issues,
  };
}
