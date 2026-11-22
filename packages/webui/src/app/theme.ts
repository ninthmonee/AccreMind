import { useEffect, useState } from 'react';

export type ThemePref = 'system' | 'dark' | 'light' | 'contrast';
const KEY = 'accremind_theme';

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'dark' || v === 'light' || v === 'contrast' || v === 'system') return v;
  } catch {
    /* sandbox iframe 可能禁用存储，退回默认 */
  }
  return 'system';
}

function apply(pref: ThemePref) {
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = pref === 'system' ? (dark ? 'dark' : 'light') : pref;
}

/** 主题偏好：跟随系统 / 石墨 / 纸白 / 高对比，写入 localStorage 并实时响应系统切换。 */
export function useTheme() {
  const [pref, setPref] = useState<ThemePref>(readPref);
  useEffect(() => {
    apply(pref);
    try {
      localStorage.setItem(KEY, pref);
    } catch {
      /* ignore */
    }
    if (pref !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => apply('system');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [pref]);
  return { pref, setPref };
}
