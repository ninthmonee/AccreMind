import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { root } from './generate-contracts.mjs';
import { loadDevelopmentConfig } from '@accremind/domain';
if (existsSync(`${root}.env`)) process.loadEnvFile(`${root}.env`);
loadDevelopmentConfig(process.env);
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) child.kill('SIGTERM');
  const deadline = setTimeout(() => {
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
  }, 5000);
  deadline.unref();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => stop());
const commands = [
  { args: ['--import', 'tsx', 'apps/api/src/main.ts'], cwd: root },
  { args: ['--import', 'tsx', 'apps/worker/src/main.ts'], cwd: root },
  {
    args: [`${root}apps/web/node_modules/vite/bin/vite.js`, '--host', '127.0.0.1'],
    cwd: `${root}apps/web`,
  },
];
for (const command of commands) {
  const child = spawn(process.execPath, command.args, {
    cwd: command.cwd,
    stdio: 'inherit',
    env: { ...process.env, AKB_MODE: process.env.AKB_MODE ?? 'synthetic' },
  });
  children.push(child);
  child.on('error', () => stop(1));
  child.on('exit', (code) => {
    if (!stopping) stop(code ?? 1);
  });
}
