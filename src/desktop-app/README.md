# desktop-app（桌面端 Web UI）

`desktop-app` 是 Hermes 桌面端 Web UI，由**官方 hermes-agent 上游的 web 构建产物**（assets/*.js）与**本项目自定义文件**组成。

## 组成

| 文件 | 来源 | 说明 |
| --- | --- | --- |
| `assets/*` | 上游编译 | 官方 Hermes Desktop UI 的 JS/CSS bundle（browser build） |
| `index.html` | 本项目 | 入口页，注入 `viewport-fit=cover`（移动端）+ 引用 web-shim |
| `web-shim.js` | 本项目 | 桌面桥接层：API 代理、中文汉化层（DICT+MutationObserver）、移动端适配（iOS 16px 防缩放/safe-area） |

## 构建

1. 上游 hermes-src 构建 web_dist（`hermes-src/hermes_cli/web_dist`）
2. 本项目把 `src/desktop-app-*.js` 和 `src/desktop-app-index.html` 覆盖到 desktop-app/
3. 最终 desktop-app/ = 官方 web 构建产物 + 本项目自定义覆盖

## 汉化机制

`web-shim.js` 内置：
- **DOM 汉化层**：242 条中英映射（账单/主题/人格/枚举/提示音等硬编码英文），MutationObserver + 500ms 兜底
- **移动端适配**：iOS 输入框强制 16px（防聚焦缩放）、safe-area-inset-bottom 刘海屏适配、触摸优化
- **API 桥接**：/proxy/dashboard 代理 + session token 注入
