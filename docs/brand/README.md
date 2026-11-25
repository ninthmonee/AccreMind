# AccreMind 图标

图标以「层积 A」表达 AccreMind 的核心：把散落的研发经验逐步沉淀为持久、可复用的知识。

三个分层形状共同组成首字母 A。顶部代表提炼后的知识，横向层代表累积的经验，底部形成稳定的基座。整体使用厚实的填充面，保留三角形负空间，便于在小尺寸下识别。

## 文件

| 文件 | 用途 |
| --- | --- |
| `../../packages/dsh-plugin/icon.svg` | 应用图标唯一源文件；供插件市场、工作台页眉和浏览器页签使用 |
| `accremind-icon-1024.png` | 1024 × 1024 透明圆角背景 PNG，可用于应用展示和宣传素材 |
| `accremind-icon-512.png` | 512 × 512 PNG |
| `accremind-icon-256.png` | 256 × 256 PNG |
| `accremind-icon-128.png` | 128 × 128 PNG |
| `accremind-icon-64.png` | 64 × 64 PNG |
| `accremind-icon-32.png` | 32 × 32 PNG |
| `accremind-icon-24.png` | 24 × 24 PNG，符号使用纯薄荷青以提高小尺寸辨识度 |
| `accremind-icon-16.png` | 16 × 16 PNG，符号使用纯薄荷青以提高小尺寸辨识度 |
| `accremind-mark.svg` | 透明背景深青单色符号，用于浅色页面、印刷或定制配色 |
| `accremind-mark.png` | 1024 × 1024 透明背景单色符号 |
| `accremind-wordmark-light.svg` | 浅色背景横向标题标识，图标与文字在同一画布内垂直居中 |
| `accremind-wordmark-dark.svg` | 深色背景横向标题标识，与浅色版共享轮廓和尺寸 |
| `accremind-preview.png` | 主图标、明暗背景、小尺寸和单色应用预览 |
| `accremind-icon-kit.zip` | 可直接下载的完整素材包，包含应用 SVG、各尺寸 PNG、单色符号、横向标题标识与预览 |

## 配色与使用

- 深青背景：`#174849` → `#081C25`。
- 符号渐变：`#F0FFF8` → `#B4F6E7` → `#70E6E3`，与工作台的薄荷青主色呼应。
- 单色深青：`#006766`，与浅色工作台主色一致。
- 保持方形比例，不拉伸、不旋转，不在符号上添加文字或额外细节。
- 应用版已经包含圆角与安全留白，不需要再套一层边框。
- 单色符号用于深色背景时，改为 `#70E6E3` 或白色；DSH 侧栏使用宿主的 `currentColor`。
- README 的标题使用横向标识，通过 `<picture>` 自动选择明暗版本；文字已转为路径，图标与字形的视觉中心保持一致，不依赖浏览器字体或图片的基线对齐。
- 修改应用源 SVG 后运行 `pnpm build:webui` 并通过 `pnpm verify`，确保工作台内联图标与源文件一致。
