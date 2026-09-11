import { test, expect } from "@playwright/test";

test("create, review, publish, export and token lifecycle", async ({ page }) => {
  const org = `e2e-${Date.now()}`;
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.getByRole("tab", { name: "本地开发" }).click();
  await page.getByLabel("组织", { exact: true }).fill(org);
  // Ant Design paints the selected value above the search input, so click the select box itself.
  await page
    .locator(".ant-select", { has: page.getByLabel("角色", { exact: true }) })
    .click();
  await page.getByTitle("审核者", { exact: true }).click();
  await page.getByRole("button", { name: "进入工作台" }).click();
  await expect(page.getByRole("heading", { name: "经验库", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "提交经验", exact: true }).click();
  await page.getByLabel("经验标题").fill("React request race condition");
  await page.getByLabel("问题表现").fill("Old requests overwrite the latest filter results.");
  await page.getByLabel("背景与约束").fill("Concurrent requests resolve out of order.");
  await page
    .getByLabel("解决方案（支持 Markdown）")
    .fill("Use AbortController and monotonically increasing request sequences.");
  await page.getByLabel("验证方式").fill("Resolve overlapping requests in reverse order.");
  await page
    .getByLabel("验证结果", { exact: true })
    .fill("Only the latest request changes the result.");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "保存并等待审核" }).click();
  await expect(page.getByRole("heading", { name: "候选审核", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "查看审核" }).click();
  await page.getByRole("button", { name: "完成预检", exact: true }).click();
  await page.getByRole("button", { name: "查看审核" }).click();
  await page.getByRole("button", { name: "审核通过并发布" }).click();
  await page.getByRole("button", { name: "OK", exact: true }).click();
  await page.getByRole("link", { name: "经验库", exact: true }).click();
  await expect(page.getByRole("button", { name: "React request race condition" })).toBeVisible();
  const download = page.waitForEvent("download");
  // Ant Design inserts a space between two CJK characters, so match with a regex.
  await page.getByRole("button", { name: /导\s*出/ }).click();
  expect((await download).suggestedFilename()).toMatch(/EXP.*\.md/);
  await page.screenshot({ path: "frontend/tests/library-desktop.png", fullPage: true });
  await page.getByRole("link", { name: "访问 Token", exact: true }).click();
  await page.getByLabel("名称", { exact: true }).fill("E2E Agent");
  await page.getByRole("button", { name: "创建 Token", exact: true }).click();
  await expect(page.getByText("请保存 Token，仅显示一次")).toBeVisible();
  await page.getByRole("button", { name: "我已保存" }).click();
  await expect(page.getByRole("cell", { name: "E2E Agent" })).toBeVisible();
  await page.getByRole("button", { name: /撤\s*销/ }).click();
  await page.getByRole("button", { name: "OK", exact: true }).click();
  await expect(page.getByText("已撤销", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 820, height: 900 });
  await page.screenshot({ path: "frontend/tests/studio-tablet.png", fullPage: true });
  expect(errors).toEqual([]);
});
