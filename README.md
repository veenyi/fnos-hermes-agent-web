# fnos-hermes-agent-web

飞牛 fnOS 上的 Hermes Agent 桌面端 Web 版。基于官方 [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) 集成，提供 fnOS 应用中心安装包（FPK）、桌面端 Web UI 汉化、飞牛管理技能（trim-cli）与 GitHub 增量更新。

## 版本号机制

版本号 = **官方代号 + 迭代号**（`0.24.4.<迭代>`）：

- 当前官方代号 `0.24.4` → 本项目 `0.24.4.36`
- 官方代号升级到 `0.24.5` → 本项目从 `0.24.5.01` 重新开始迭代

每次迭代版本号 +1（0.24.4.36 → 0.24.4.37 → ...），release tag 格式：`v0.24.4.36`

## 仓库结构

```
fnos-hermes-agent-web/
├── app/                    # 完整应用源码树（与部署端一致，自包含可运行）
│   ├── server/             # Node 后端（monitor.js / custom_routes.js / connectors.js 等）
│   ├── desktop-app/        # 桌面端 Web UI（官方 dist + web-shim 汉化层/移动端适配）
│   ├── ui/                 # 旧版控制台页面
│   ├── hermes-src/         # Hermes Agent 上游源码（vendored，含自定义配置）
│   └── config/             # fnOS 应用配置（bootstrap / privilege）
├── src/                    # 编译前的自定义修改源文件（供对照/重新构建）
│   ├── server/             # monitor.js 等 Node 后端
│   └── desktop-app-*.js    # 桌面端 Web UI 自定义（web-shim 汉化层/移动端适配）
├── scripts/                # 构建与发布脚本
│   ├── sync-upstream.sh    # 同步官方 hermes-agent 上游
│   ├── build.sh            # 编译打包（FPK + 增量 tar）
│   └── publish.sh          # 发布到 GitHub Release
├── fpk/                     # FPK 打包骨架（manifest/cmd/config/ICON/wizard/技能）
├── VERSION                 # 当前版本号
└── .github/workflows/      # GitHub Actions 自动同步/编译/发布
```

`app/` 为完整可部署源码树（不含 venv 与运行时数据）；`src/` 为汉化/自定义修改的源文件集合，两者内容一致时以 `app/` 为准。

## 增量更新机制

每次 Release 上传三类资产：

1. **`fnos-hermes-agent_v0.24.4.36.fpk`** — 完整安装包（全新安装/跨大版本）
2. **`incremental-v0.24.4.35-to-v0.24.4.36.tar.gz`** — 增量更新包（相对上一迭代变更的文件，tar 解压）
3. **`hot-patch.json`** — 更新元数据（base_version / version / 文件清单 / checksum）

monitor 的 `/api/app/hot-patch` 检测到 `hot-patch.json` 时，下载增量 tar 解压到应用目录，更新版本号后自重启，无需全量重装。

## 本地构建

```bash
# 1. 同步上游
./scripts/sync-upstream.sh

# 2. 编译打包
./scripts/build.sh

# 3. 发布（需 GITHUB_TOKEN）
./scripts/publish.sh
```

## 上游同步

自动检测官方 hermes-agent 新版本：

- 官方代号变化（如 0.24.4 → 0.24.5）→ 全新同步 + 迭代 V01
- 官方代号不变 → 仅本地增量（迭代 +1）

## 隐私声明

本仓库**不含**任何个人数据：无密码、token、内网 IP、NAS 路径或个人信息。打包前自动执行隐私扫描，确保零残留。部署时通过环境变量注入真实配置（如 `GITHUB_REPO`），源码内仅保留匿名占位值。
