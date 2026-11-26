import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createAccreMindRuntime } from '../packages/dsh-plugin/src/index.ts';

/**
 * share:false 的仓库（带客户数据的临时脚本之类）不该把自己提炼的领域/通用技术条目写进
 * 机器级目录：那是全机共享的层，写进去等于间接共享。项目层条目照常写自己的目录。
 */
describe('share switch covers machine-wide writes', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'accremind-share-write-'));
  const mk = (name: string) => {
    const root = path.join(base, name);
    fs.mkdirSync(root, { recursive: true });
    return createAccreMindRuntime({ projectRoot: root, globalDir: path.join(base, 'global') });
  };

  const candidate = (workspaceId: string, layer: 'project' | 'shared_tech' | 'domain', suffix: number) => {
    const id = 'K-' + suffix;
    return {
      assessment: {
        id: 'CA-' + suffix,
        workspace_id: workspaceId,
        source_fingerprint: 'fp-' + suffix,
        question: layer + ' 条目里并发写入为什么必须先取文件锁再落盘？',
        checked_context: {
          head_commit: null,
          checked_files: ['src/a.ts'],
          checked_docs: [],
          method: 'single_pass_check',
          token_used: 12,
          duration_ms: 40,
        },
        discoverability: 'missing_context',
        baseline_answer: '代码直接 writeFile，没有说明两个进程同时写会怎样。',
        knowledge_delta: '两个进程同时 writeFile 会互相覆盖，先取文件锁再落盘。',
        claim_evidence_map: [
          { assertion: '写入前必须取文件锁', evidence_locator: 'src/a.ts#L1-L5', verified_fact: true },
        ],
        omission_consequence: '线上会出现静默丢写，且没有任何报错。',
        priority: 'P1',
        disposition: 'knowledge_candidate',
        created_at: new Date().toISOString(),
      },
      candidateEntry: {
        id,
        revision: 1,
        type: 'pitfall',
        knowledge_role: 'experience',
        layer,
        domains: layer === 'domain' ? ['payment'] : [],
        title: layer + ' 并发写入必须先取文件锁再落盘',
        search_aliases: ['丢写', '文件锁'],
        claim: '写入前取文件锁。',
        knowledge_delta: '两个进程同时 writeFile 会互相覆盖，先取文件锁再落盘。',
        rationale: '两个进程同时写同一文件会互相覆盖。',
        preconditions: ['同时写同一个文件'],
        exclusions: [],
        dependency_constraints: [],
        watch_paths: ['src/**/*.ts'],
        symbol_anchors: [],
        invalidation_triggers: ['改用数据库后复核'],
        verification_method: 'node --test tests/lock.test.mjs',
        alternatives: [],
        enforcement: { kind: 'test', status: 'verified', ref: 'tests/lock.test.mjs' },
        status: 'active',
        maturity: 'draft',
        freshness: 'current',
        serving: 'enabled',
        priority: 'P1',
        capture_assessment_id: 'CA-' + suffix,
        supersedes: null,
        evidence: [
          { id: 'EV-' + suffix, source_type: 'git_commit', source_ref: 'S-1', locator: 'src/a.ts#L1-L5', summary: '两个进程同时写互相覆盖的复现' },
        ],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        last_validated_at: null,
        review_due_at: new Date(Date.now() + 86400000).toISOString(),
      },
    };
  };

  it('refuses machine-wide writes once sharing is off, and keeps project writes working', () => {
    const runtime = mk('quiet');
    try {
      assert.deepEqual(runtime.store.repoSettings(), { capture: true, share: true }, '未写开关时两边都开');

      const open = runtime.triageEngine.processCandidate(candidate(runtime.store.workspaceId, 'shared_tech', 9001) as never);
      assert.equal(open.persistedEntry?.id, 'K-9001');
      assert.equal(open.persistedZone, 'probation', '默认先写试用区，与写入闸门无关');

      runtime.store.setRepoSettings({ share: false });
      assert.equal(runtime.store.repoSettings().share, false);

      assert.throws(() => runtime.triageEngine.processCandidate(candidate(runtime.store.workspaceId, 'shared_tech', 9002) as never), /share: false/);
      assert.throws(() => runtime.triageEngine.processCandidate(candidate(runtime.store.workspaceId, 'domain', 9003) as never), /share: false/);

      const project = runtime.triageEngine.processCandidate(candidate(runtime.store.workspaceId, 'project', 9004) as never);
      assert.equal(project.persistedEntry?.id, 'K-9004', '项目层条目仍写进本仓库，不受 share 影响');
      assert.equal(runtime.store.getEntry('K-9004').found, true);
    } finally {
      runtime.dispose();
    }
  });
});
