# 发布到 DSH 插件市场

本文只讲 DSH 这条分发渠道：工程本身与宿主无关，内核不依赖 DSH，命令行与独立工作台也不需要插件。这里说的"上架"仅仅是"把 DSH 适配层发出去"。

DSH 的插件市场**没有官方索引**：Discover 只列出用户自己添加的 index URL（`@deepseek-ai/dsh-experimental-plugin-market-bundle` README 原文）。所以“上架”= 发布 npm 包 + 提供一个 format 1 的索引 JSON，让用户把它的 URL 加进 Discover。

本仓库已把这两件事都准备好：

| 产物 | 位置 |
| --- | --- |
| 插件包清单（含市场元数据） | `packages/dsh-plugin/package.json` |
| 包图标 | `packages/dsh-plugin/icon.svg` |
| 市场详情页正文 | `packages/dsh-plugin/README.md` |
| 索引 JSON | `market/index.json` |
| 索引生成/校验 | `packages/dsh-plugin/scripts/market-index.mjs` |
| 发布形态自检 | `packages/dsh-plugin/scripts/check-publishable.mjs` |

## 1. 发布前自检

```bash
node scripts/build.ts
node packages/dsh-plugin/scripts/check-publishable.mjs --pack
node packages/dsh-plugin/scripts/market-index.mjs --check
```

第一条编译 `dist/`（**必须**，包里不含构建脚本）；第二条按市场的收录条件逐项核对，`--pack` 会真的打包到临时目录并读 tarball 清单，确认 `dist/`、`LICENSE`、`client.js`、`cordis.patch.yml`、`icon.svg` 都进包，同时校验 tarball 内的 `workspace:*` 已被替换成真实版本号；第三条确认索引与清单没有漂移。

本机装了 DSH 时，第二条会自动找到 `@deepseek-ai/dsh-app-boot`，直接用宿主的 `evaluatePluginCompatibility` 验证版本门槛真的会拒绝旧版本（找不到时可加 `--host <DSH 的 node_modules 路径>` 指定；CI 上没有宿主，该项显示为跳过）。

> `**/dist/` 在 `.gitignore` 里，npm 默认会继承它。两个包都显式声明了 `files` 白名单，`dist/` 因此一定会被打包——这一步不要删。

## 2. 发布顺序：core 先，插件后

`packages/dsh-plugin` 依赖 `@accremind/core`。本地用 `workspace:*`，`pnpm publish` 会把它替换成真实版本号，所以**先发 core**，否则装插件时会找不到依赖。

一条命令跑完全流程（自检 → 发 core → 发插件 → 回读版本 → 刷新索引 → 校验索引）：

```bash
npm login                                  # 一次性，需要能写 @accremind scope
./scripts/release-npm.sh                   # 或者 NPM_TOKEN=npm_xxx ./scripts/release-npm.sh
```

脚本存在的理由，每一条都是踩过的坑：

- **必须用 `pnpm publish`，不能用 `npm publish`**：实测同一个包 `npm pack` 出来的 tarball 里 `@accremind/core` 依赖不会被改写，`pnpm pack` 出来的才是 `0.1.0`。
- **强制 `--registry https://registry.npmjs.org/`**：本机 `~/.npmrc` 常指向镜像（npmmirror），不显式指定会把发布打到镜像上。
- **npm 缓存重定向到临时目录**：受限 shell 里 `~/.npm` 不可写，`npm whoami` 会直接 EPERM。
- **token 必须走环境变量，不能只写 `.npmrc`**：`pnpm publish` 不读 userconfig / 项目 `.npmrc` 里的 `_authToken`。只写配置文件时，即使 token 已带 Bypass 2FA，发布仍报 `403 Two-factor authentication or granular access token with bypass 2fa enabled is required`——这条错误极易被误判成"token 没开 Bypass 2FA"。脚本因此把 token 同时注入成 `npm_config_//registry.npmjs.org/:_authToken`，发布步骤一次通过。

判断 token 到底是"权限不足"还是"没被读到"，看 `GET /-/npm/v1/tokens` 的返回：`bypass_2fa: true` 且权限含 package write 就说明 token 本身没问题，问题在客户端没带上它。

## 2.1 2FA 越来越紧，备选是分段发布

npm 已在收紧 bypass-2FA token 用于直接发布（官方提示：`https://gh.io/npm-gat-bypass2fa-deprecation`）。如果手上的 token 不再允许直接发，用 npm 的分段发布把 2FA 推迟到审批那一刻：

```bash
pnpm pack --pack-destination /tmp/rel                 # 仍用 pnpm，保证 workspace:* 被改写
npm stage publish /tmp/rel/accremind-core-0.1.0.tgz    # 只上传，不生效
npm stage list                                        # 拿 stage-id
npm stage approve <stage-id>                           # 这一步才校验 2FA
```

`npm stage publish` 对已存在的版本会报 `409 Cannot stage previously published version`，可以当作"这个版本确实已经发布成功"的旁证。

首次发布前要先在 npm 建好 `@accremind` 组织（scope 必须存在，`--access public` 才生效）。版本号改动走 `pnpm version`，两个包保持同步。

## 3. 刷新索引里的发布时间

```bash
node packages/dsh-plugin/scripts/market-index.mjs --from-npm
git add market/index.json && git commit -m 'chore(market): 刷新索引发布时间'
```

`publishTimestamp` 是 npm 上该版本的真实发布时间（Unix 秒）。写错会被 schema 拒绝或显示成异常时间。

## 4. 让用户加进 Discover

索引推到 `main` 后，URL 是：

```
https://raw.githubusercontent.com/ninthmonee/AccreMind/main/market/index.json
```

用户侧操作：

1. DSH → Plugins → Experimental plugins → 打开 **Custom plugin indexes**，出现 Installed / Discover 两个页签。
2. 在索引列表里添加上面的 URL。
3. 去 Discover 搜 `AccreMind`，详情页长描述读的就是 `packages/dsh-plugin/README.md`（npm 文件来自公共 CDN）。
4. 安装后重启桌面，左侧栏出现 AccreMind 面板。

## 5. 索引里各字段的硬约束

`parseMarketIndex` 会拒绝任何越界值，几条容易踩的：

- `format` 必须是数字 `1`；`title` / `description` 是 `string` 或 `{ en: string, [locale]: string }`，**`en` 必填**。
- `icon` 只能是 `data:` URL（解码后 ≤ 32768 字节）或绝对 URL；相对路径按 index URL 解析。
- `repository.url` 是仓库网页地址（无 `.git`、无凭据、无 query/fragment），只用于展示，永远不作为安装源。
- `versions` 非空、按 SemVer 降序，版本号是精确 SemVer 且在插件内唯一。
- `publishTimestamp` 是 Unix **秒**；`0` 是合法值（会被保留），`null` 会被丢弃。
- `metadata.category` / `labels` / `sortKeys` 的 id 必须在该索引的 `metadata` 里声明过，否则引用悬空。
- **版本门槛必须写在包清单顶层的 `engines.dsh`**：`{"engines":{"node":">=24.0.0","dsh":">=0.2.2-rc.5"}}`。宿主的 `evaluatePluginCompatibility` 只读顶层 `engines.dsh`（有则独占决定）或 `peerDependencies` 里的 `@deepseek-ai/dsh*`；写在 `dsh.engines` 下会被当成"没有任何版本要求"，任何 DSH 版本都放行，并且不会出现在安装/启动校验里。索引里的 `versions[].engines.dsh` 只用于门店展示，市场不校验它与包是否一致。
- 安装串由 `marketInstallTarget` 生成：npm 源是 `name@version`，git 源是 `git+https://…#<40 位 commit>` 加 `path:` 参数。

## 6. 不想发 npm 的备选：git 源

`source` 也可以写 git：

```json
{ "type": "git", "url": "https://github.com/ninthmonee/AccreMind", "commit": "<40 位小写 commit>", "path": "packages/dsh-plugin" }
```

但 pnpm 从 git 装子目录时**不会解析 `workspace:*`**，这样装会失败。要走这条路，得先给两个包改成真实版本号依赖（`"@accremind/core": "0.1.0"`），并且接受安装包里没有 `dist/`——因为 git 安装不会替你跑 `scripts/build.ts`。所以默认走 npm。

## 7. 本地开发与市场版共存

本地现在是用软链装进 profile 的：

```bash
node packages/dsh-plugin/scripts/install-to-dsh.mjs --profile desktop            # 装/更新软链
node packages/dsh-plugin/scripts/install-to-dsh.mjs --profile desktop --uninstall # 卸掉
```

在市场里装过一次之前，先卸载软链，避免同一个插件 id 被注册两遍。
