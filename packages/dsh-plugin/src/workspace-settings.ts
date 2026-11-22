import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256Hex, writeFileAtomicSync, type AccreMindConfig, type StoreLayoutPaths } from '@accremind/core';

type Gate = AccreMindConfig['writeGate'];

interface StoredSettings {
  writeGate?: unknown;
  shareLedger?: unknown;
  /** Explicit, per-workspace consent to send conversation excerpts to the configured model. */
  modelUpload?: unknown;
}

function settingsFile(paths: StoreLayoutPaths): string {
  return join(paths.globalRoot, 'workspaces', sha256Hex(paths.workspaceId), 'write-gate.json');
}

function readStored(file: string): StoredSettings {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as StoredSettings;
  } catch {
    return {};
  }
}

export function workspaceGate(paths: StoreLayoutPaths, defaultGate: Gate) {
  const file = settingsFile(paths);
  return {
    read(): Gate {
      const value = readStored(file).writeGate;
      if (value === 'probation' || value === 'review') return value;
      return defaultGate;
    },
    save(value: unknown) {
      if (value !== 'probation' && value !== 'review') throw new Error('请选择先试用或先审核。');
      writeFileAtomicSync(file, JSON.stringify({ ...readStored(file), writeGate: value }) + '\n');
    },
  };
}

export function workspaceModelConsent(paths: StoreLayoutPaths, defaultConsent: boolean) {
  const file = settingsFile(paths);
  return {
    read(): boolean {
      const value = readStored(file).modelUpload;
      return typeof value === 'boolean' ? value : defaultConsent;
    },
    save(value: unknown) {
      if (typeof value !== 'boolean') throw new Error('请选择是否允许发送给模型。');
      writeFileAtomicSync(file, JSON.stringify({ ...readStored(file), modelUpload: value }) + '\n');
    },
  };
}

/**
 * Whether the validation ledger is shared through the repository. Unlike the personal settings above,
 * this lives in the repository (`.accremind/team.json`), so once committed every teammate's plugin
 * writes confirmations to the same place and applies the same “second person” rule.
 */
export function repositoryLedgerSharing(paths: StoreLayoutPaths) {
  const file = join(paths.projectAccreMindDir, 'team.json');
  return {
    file,
    read(): boolean {
      return readStored(file).shareLedger === true;
    },
    save(value: unknown) {
      if (typeof value !== 'boolean') throw new Error('请选择是否共享验证记录。');
      writeFileAtomicSync(file, JSON.stringify({ ...readStored(file), shareLedger: value }, null, 2) + '\n');
    },
  };
}
