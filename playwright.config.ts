import { defineConfig } from '@playwright/test';

// 默认使用随 Playwright 安装的 Chromium；系统 Chrome 启动异常时不要依赖 channel。
// 需要固定在系统 Chrome 上验证时：PW_CHANNEL=chrome pnpm test:e2e
const channel = process.env.PW_CHANNEL as 'chrome' | 'msedge' | undefined;

export default defineConfig({
  testDir: 'frontend/tests',
  timeout: 60000,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:5173',
    ...(channel ? { channel } : {}),
    headless: true,
    trace: 'retain-on-failure',
  },
  reporter: 'list',
});
