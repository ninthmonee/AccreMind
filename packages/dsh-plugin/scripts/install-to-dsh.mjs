#!/usr/bin/env node
/**
 * install-to-dsh.mjs — 把 @accremind/dsh-plugin 注册进一个 dsh profile。
 *
 * 为什么不用 `pnpm add`：packages/dsh-plugin 的依赖是 workspace 协议
 * （"@accremind/core": "workspace:*"），profile 目录不在本仓库 workspace 内，
 * pnpm 无法解析 workspace:*，会直接 ERR_PNPM_WORKSPACE_PKG_NOT_FOUND。
 * 所以这里用软链把两个包挂进 profile 的 node_modules，零安装、零网络。
 *
 * 用法：
 *   node packages/dsh-plugin/scripts/install-to-dsh.mjs            # 装进 desktop
 *   node packages/dsh-plugin/scripts/install-to-dsh.mjs --profile desktop
 *   node packages/dsh-plugin/scripts/install-to-dsh.mjs --dry-run
 *   node packages/dsh-plugin/scripts/install-to-dsh.mjs --uninstall
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync, lstatSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../..')
const coreDir = join(repoRoot, 'packages/core')
const pluginDir = join(repoRoot, 'packages/dsh-plugin')

const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const uninstall = argv.includes('--uninstall')
const profileName = (() => {
  const i = argv.indexOf('--profile')
  return i >= 0 && argv[i + 1] ? argv[i + 1] : 'desktop'
})()

const profileDir = join(homedir(), '.dsh/profiles', profileName)
const patchPath = join(profileDir, 'cordis.patch.yml')
const modulesDir = join(profileDir, 'node_modules/@accremind')

const PATCH_BLOCK = `- insert:
    - id: accremind
      name: '@accremind/dsh-plugin'
      config:
        globalDir: '~/.dsh/accremind'
        projectDirName: '.accremind'
        writeGate: 'probation'
        maxProbationExposures: 3
        assessmentMode: 'single_pass'
        budgets:
          residentRulesTokens: 500
          turnRadarTokens: 300
          toolGuardTokens: 240
          toolReadMaxTokens: 1500
        autoCapture:
          enabled: true
`

function die(msg) {
  console.error(`✗ ${msg}`)
  process.exit(1)
}

if (!existsSync(profileDir)) die(`找不到 profile 目录：${profileDir}（先用 dsh 启动一次这个 profile）`)
if (!existsSync(join(pluginDir, 'dist/index.js'))) die(`插件未构建：${pluginDir}/dist/index.js 不存在，先跑 node scripts/build.ts`)

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const backupDir = join(profileDir, `.accremind-backup-${stamp}`)

if (dryRun) {
  console.log('dry-run:')
  console.log(`  profile      ${profileDir}`)
  console.log(`  link         ${modulesDir}/dsh-plugin -> ${pluginDir}`)
  console.log(`  link         ${modulesDir}/core -> ${coreDir}`)
  console.log(`  patch        ${patchPath} (+insert accremind)`)
  process.exit(0)
}

if (uninstall) {
  for (const name of ['dsh-plugin', 'core']) {
    const p = join(modulesDir, name)
    if (existsSync(p) || isLink(p)) { rmSync(p, { force: true }); console.log(`− 移除软链 ${p}`) }
  }
  if (existsSync(patchPath)) {
    const text = readFileSync(patchPath, 'utf8')
    const next = text.replace(/\n?- insert:\n(?:[ \t]+.*\n)*?[ \t]+- id: accremind\n(?:[ \t]+.*\n)*/, '\n')
    if (next !== text) {
      copyFileSync(patchPath, join(profileDir, `.accremind-uninstall-${stamp}-cordis.patch.yml`))
      writeFileSync(patchPath, next)
      console.log('− 已从 cordis.patch.yml 移除 accremind insert 块')
    } else {
      console.log('· cordis.patch.yml 中没有 accremind insert 块')
    }
  }
  console.log('完成。重启 dsh 生效。')
  process.exit(0)
}

mkdirSync(backupDir, { recursive: true })
for (const f of ['package.json', 'cordis.patch.yml']) {
  const src = join(profileDir, f)
  if (existsSync(src)) copyFileSync(src, join(backupDir, f))
}
console.log(`· 备份到 ${backupDir}`)

mkdirSync(modulesDir, { recursive: true })
for (const [name, target] of [['dsh-plugin', pluginDir], ['core', coreDir]]) {
  const link = join(modulesDir, name)
  if (isLink(link)) rmSync(link, { force: true })
  if (existsSync(link)) die(`${link} 已存在且不是软链，请手动处理`)
  const { symlinkSync } = await import('node:fs')
  symlinkSync(target, link, 'dir')
  console.log(`· 软链 ${link} -> ${target}`)
}

const current = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
if (/id:\s*accremind\b/.test(current)) {
  console.log('· cordis.patch.yml 已含 accremind，跳过')
} else {
  const next = current.endsWith('\n') || current === '' ? current + PATCH_BLOCK : current + '\n' + PATCH_BLOCK
  writeFileSync(patchPath, next)
  console.log(`· 已追加 insert 到 ${patchPath}`)
}

console.log('')
console.log('安装完成。接下来：')
console.log('  1) 完全退出 DSH 再启动（托盘退出，不是关窗口）')
console.log('  2) 新会话里 composer 输入框上方应出现 AccreMind 工作台按钮')
console.log('  3) 校验：dsh --profile ' + profileName + ' --dump-config | grep -A3 accremind')

function isLink(p) {
  try { return lstatSync(p).isSymbolicLink() } catch { return false }
}
