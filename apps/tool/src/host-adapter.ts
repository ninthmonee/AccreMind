import { spawnSync } from 'node:child_process';
export type HostDetection = {
  host: 'claude-code';
  status: 'detected' | 'unsupported';
  version: string | null;
  configInstallation: 'not_verified';
};
export interface HostAdapter {
  detect(): HostDetection;
}
export class ClaudeCodeAdapter implements HostAdapter {
  detect(): HostDetection {
    const result = spawnSync('claude', ['--version'], {
      encoding: 'utf8',
      timeout: 3000,
      maxBuffer: 8192,
    });
    const version = result.status === 0 ? result.stdout.trim().slice(0, 120) : null;
    return {
      host: 'claude-code',
      status: version ? 'detected' : 'unsupported',
      version,
      configInstallation: 'not_verified',
    };
  }
}
