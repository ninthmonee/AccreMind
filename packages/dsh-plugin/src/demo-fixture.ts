import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { extractSymbolAnchor } from '@accremind/core';

const paymentPath = 'src/payment/webhook.ts';
const sessionPath = 'src/auth/session-cache.ts';
const reportPath = 'src/report/exporter.ts';
const orderPath = 'src/order/order.service.ts';
const paymentSource = `export class PaymentWebhookController {
  async handleCallback(request, db, verifySignature) {
    await verifySignature(request.rawBody, request.signature);
    return db.insertEventIfAbsent(request.idempotencyKey);
  }
}
`;
const orderSource = `export class OrderService {
  async createOrder(order, tx) {
    await tx.save(order);
    tx.afterCommit(() => tx.sendEvent(order.id));
  }
}
`;
const files: Record<string, string> = {
  [paymentPath]: paymentSource,
  [orderPath]: orderSource,
  [sessionPath]:
    "export function sessionKeys(id) {\n  return ['sess:{' + id + '}:meta', 'sess:{' + id + '}:rt'];\n}\n",
  [reportPath]:
    'export async function exportRows(db, write) {\n  for await (const row of db.cursor({ batch: 500 })) await write(row);\n}\n',
  'src/common/errors/error-codes.ts':
    'export const statusByError = { duplicate: 409, invalidSignature: 401 };\n',
  'docs/adr/001-finance-redlines.md':
    '# 示例项目账务规范\n\n以最小货币单位存储整数金额，日志只保留脱敏标识。\n',
  'README.md':
    '# 本地支付示例项目\n\n这是用于演练 AccreMind 工作流的虚构项目。提交、文件位置和符号指纹均可在此仓库核对。\n',
  'docs/demo-evidence.md':
    '# 演示场景记录\n\n以下数值用于演练，均为虚构场景参数。\n\n支付渠道在 1 秒超时后重放时要保留原始报文、按唯一键去重。\nRedis 多键脚本需使用同一用户的哈希标签。\n订单写入与事件发送的时间差曾造成消费者先于事务完成。示例将这条订单履约约束归入业务领域，其实现仍位于本仓库。\n大报表通过每批 500 行的游标限制内存使用。\n',
  'tests/scenarios.test.mjs': `import assert from 'node:assert/strict';
import {test} from 'node:test';
import {PaymentWebhookController} from '../${paymentPath}';
import {OrderService} from '../${orderPath}';
import {sessionKeys} from '../${sessionPath}';
import {exportRows} from '../${reportPath}';

test('payment', async () => {
  const stored = new Set();
  const db = { insertEventIfAbsent: id => { stored.add(id); } };
  const request = { rawBody: Buffer.from('original'), signature:'sample', idempotencyKey:'event-1' };
  const verify = body => assert.equal(body, request.rawBody);
  const controller = new PaymentWebhookController();
  await Promise.all(Array.from({length:50}, () => controller.handleCallback(request, db, verify)));
  assert.equal(stored.size, 1);
});
test('order', async () => {
  const history = [];
  await new OrderService().createOrder({id:'one'}, {
    save: async () => history.push('saved'), afterCommit: f => f(), sendEvent: () => history.push('event'),
    enqueueOutbox: () => history.push('outbox'),
  });
  assert.equal(history[0], 'saved');
  assert.ok(['event','outbox'].includes(history[1]));
});
test('session', () => assert.deepEqual(sessionKeys('one'), ['sess:{one}:meta','sess:{one}:rt']));
test('report', async () => {
  const rows = [];
  await exportRows({cursor: options => { assert.equal(options.batch,500); return [1,2]; }}, row => rows.push(row));
  assert.deepEqual(rows,[1,2]);
});
`,
};

function git(project: string, args: string[]) {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=AccreMind Demo',
      '-c',
      'user.email=demo@accremind.invalid',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    {
      cwd: project,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    },
  ).trim();
}

export function initializeDemoProject(project: string) {
  fs.mkdirSync(project);
  git(project, ['init', '--template=']);
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(project, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  git(project, ['add', '--', ...Object.keys(files)]);
  git(project, ['commit', '-m', 'hotfix(payment): prevent duplicate credits on webhook retry']);
}

export function readDemoBaseline(project: string) {
  const payment = extractSymbolAnchor(
    paymentPath,
    paymentSource,
    'PaymentWebhookController.handleCallback',
  )!;
  const order = extractSymbolAnchor(orderPath, orderSource, 'OrderService.createOrder')!;
  return {
    commit: git(project, ['rev-list', '--max-parents=0', 'HEAD']),
    payment,
    order,
    paymentLocator: paymentPath + '#L' + payment.start_line + '-L' + payment.end_line,
    orderLocator: orderPath + '#L' + order.start_line + '-L' + order.end_line,
  };
}

export function advanceDemoOrder(project: string) {
  const target = path.join(project, orderPath);
  const next = orderSource.replace(
    'tx.afterCommit(() => tx.sendEvent(order.id));',
    'await tx.enqueueOutbox(order.id);',
  );
  if (fs.readFileSync(target, 'utf8') === next) return;
  fs.writeFileSync(target, next);
  git(project, ['add', '--', orderPath]);
  git(project, [
    'commit',
    '-m',
    'fix(order): replace afterCommit with a transactional outbox to avoid a delivery race',
  ]);
}
