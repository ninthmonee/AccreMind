import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256Hex, writeFileAtomicSync, type AccreMindConfig, type StoreLayoutPaths } from '@accremind/core';

type Gate = AccreMindConfig['writeGate'];
export function workspaceGate(paths: StoreLayoutPaths, defaultGate: Gate) {
  const file = join(paths.globalRoot, 'workspaces', sha256Hex(paths.workspaceId), 'write-gate.json');
  return {
    read(): Gate {
      if (!existsSync(file)) return defaultGate;
      const value = JSON.parse(readFileSync(file, 'utf8')).writeGate;
      if (value === 'probation' || value === 'review') return value;
      return defaultGate;
    },
    save(value: unknown) {
      if (value !== 'probation' && value !== 'review') throw new Error('请选择先试用或先审核。');
      writeFileAtomicSync(file, JSON.stringify({ writeGate: value }) + '\n');
    },
  };
}
