export type StrongSignalKind =
  | 'explicit_trigger'
  | 'causal_user_correction'
  | 'error_to_green_recovery'
  | 'architecture_decision';

export interface SessionSignalSnapshot {
  userMessages: string[];
  assistantMessages: string[];
  editedFiles: string[];
  hadCommandFailure: boolean;
  hadSubsequentCommandSuccess: boolean;
  totalToolCalls: number;
  maxEditsOnSingleFile: number;
}

export interface SignalDetectionResult {
  shouldCapture: boolean;
  strongSignals: StrongSignalKind[];
  weakScore: number;
  weakReasons: string[];
}

const EXPLICIT_TRIGGER_REGEX =
  /(?:^|\s)\/capture\b|(?:把这个坑记下来|记下这个坑|沉淀(?:一下|本轮)?经验|记录到经验库|save\s+this\s+(?:pitfall|lesson))/i;

const CAUSAL_CORRECTION_REGEX =
  /(?:不对|不能这样(?:写|改|做)|不要这样(?:写|用)|这样会出问题|这里有个坑)[\s\S]{0,60}(?:因为|否则会|会导致|是由于|必须先|当初)|(?:曾经试过|之前试过)[\s\S]{0,40}(?:回滚|撤回|放弃)|(?:必须先[\s\S]{1,30}再[\s\S]{1,30}否则)|(?:\bcannot\s+use\b[\s\S]{0,50}\bbecause\b|\bmust\s+run\s+before\b)/i;

const ARCH_DECISION_REGEX =
  /(?:最终决定采用|选型结论|之所以不采用|放弃方案)[\s\S]{1,80}(?:原因|因为|取舍|约束)/i;

function isPersonalDotfileOnly(files: string[]): boolean {
  if (files.length === 0) return false;
  return files.every(
    (f) =>
      f.startsWith('~/') ||
      f.includes('/.zshrc') ||
      f.includes('/.bashrc') ||
      f.includes('/.gitconfig'),
  );
}

/**
 * Deterministic 0-Token Session Signal Detector (PRD §6.2 & §6.8.2):
 * Triggers capture when ANY strong causal/recovery signal is present, or when
 * combined weak signals reach `weakThreshold` (default 3).
 * Repeated edits or tool call counts NEVER qualify alone!
 */
export function evaluateSessionSignals(
  snapshot: SessionSignalSnapshot,
  weakThreshold = 3,
): SignalDetectionResult {
  if (isPersonalDotfileOnly(snapshot.editedFiles)) {
    return {
      shouldCapture: false,
      strongSignals: [],
      weakScore: 0,
      weakReasons: ['仅涉及个人环境配置文件，按隐私边界跳过团队经验采集'],
    };
  }

  const strongSignals: StrongSignalKind[] = [];
  const joinedUser = snapshot.userMessages.join('\n');
  const joinedAll = `${joinedUser}\n${snapshot.assistantMessages.join('\n')}`;

  if (EXPLICIT_TRIGGER_REGEX.test(joinedUser)) {
    strongSignals.push('explicit_trigger');
  }
  if (CAUSAL_CORRECTION_REGEX.test(joinedUser)) {
    strongSignals.push('causal_user_correction');
  }
  if (
    snapshot.hadCommandFailure &&
    snapshot.editedFiles.length > 0 &&
    snapshot.hadSubsequentCommandSuccess
  ) {
    strongSignals.push('error_to_green_recovery');
  }
  if (ARCH_DECISION_REGEX.test(joinedAll)) {
    strongSignals.push('architecture_decision');
  }

  let weakScore = 0;
  const weakReasons: string[] = [];

  if (snapshot.hadCommandFailure) {
    weakScore += 1;
    weakReasons.push('出现命令或测试执行报错 (+1)');
  }
  if (snapshot.maxEditsOnSingleFile >= 3) {
    weakScore += 1;
    weakReasons.push(`单文件反复修改 ${snapshot.maxEditsOnSingleFile} 次 (+1)`);
  }
  if (snapshot.totalToolCalls >= 6 && snapshot.editedFiles.length > 0) {
    weakScore += 1;
    weakReasons.push(`多轮工具排查共 ${snapshot.totalToolCalls} 次且含代码变更 (+1)`);
  }

  const shouldCapture = strongSignals.length > 0 || weakScore >= weakThreshold;

  return {
    shouldCapture,
    strongSignals,
    weakScore,
    weakReasons,
  };
}
