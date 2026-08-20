---
name: trim-fnos-openapi
description: 当任务涉及 fnOS 开放 API（应用文件授权、路径转换、文件权限检查、平台配置读取、JS SDK 页面路由/交互）时使用；这些是 2026-07-31 新增的系统能力（系统 1.2.0401+ / App 1.34.0+）
---

# trim-fnos-openapi — fnOS 开放 API（应用级能力）

fnOS 开放 API 用于让第三方应用更自然地接入系统：文件授权、页面路由、界面状态和后端查询。**注意**：这些接口是"应用开发者"接入 fnOS 的能力，与 trim-cli 的 NAS 管理能力互补——Hermes 管理 NAS 用 trim-cli，理解/开发 fnOS 应用时参考本 entry。

> 系统版本要求：`1.2.0401+`，App 版本 `1.34.0+`（2026-07-31 更新日志）

## 后端 API 调用方式

统一通过 Unix Socket 调用：

```
POST /api/v1/trimapp
Unix Socket: /var/run/trim_open_gateway_apiscope.socket
Content-Type: application/json
Authorization: Bearer <token>
```

- token 由系统在调用应用脚本时自动注入环境变量 `TRIM_API_TOKEN`
- token 可能更新，每次调用都从当前进程 env 读取，不要持久化
- 请求体：`{"reqId":"1","req":"trim.system.getPlatformConfig","appName":"your-app","data":{}}`
- 响应：`{"reqId":"1","code":0,"msg":"","data":{}}`（code=0 成功）

## API 清单

| 接口 | Scope | 说明 |
| --- | --- | --- |
| `trim.file.getSharedAccessibleFolders` | `trim.file.sharedAccess` | 查询应用共享授权目录（管理员配置的固定目录） |
| `trim.file.delSharedAccessibleFolder` | `trim.file.sharedAccess` | 删除共享授权目录 |
| `trim.file.getUserAccessibleFolders` | `trim.file.userAccess` | 查询当前用户个人授权目录 |
| `trim.file.delUserAccessibleFolder` | `trim.file.userAccess` | 删除用户个人授权目录 |
| `trim.file.checkUserACL` | `trim.file.userAcl` | 检查用户对路径的读/写/删除权限 |
| `trim.file.convertPath` | `trim.file.path` | 把 `/vol1/...` 内部路径转成用户可理解路径 |
| `trim.system.getPlatformConfig` | `trim.system.getPlatformConfig` | 读取系统语言和系统版本 |

## 前端 JS SDK

- 包：`@trimjs/web-app`（npm）
- 需要在 manifest 声明 `micro_app=true`
- 环境判断：`sdk.isWeb`（Web 环境）、`sdk.isStandaloneWeb`（独立浏览器页面）
- 能力：`pickSharedFile`（管理员授权目录）、`pickUserFile`（用户授权目录/文件）、`openFile`/`openFileManager`/`openAppSettings`/`openUrl`（页面路由）、`getPlatformConfig`（平台配置）、监听主题/语言变化

## 授权模型

- 应用以独立应用用户运行，访问用户文件前需系统授予应用用户 ACL
- 应用共享授权：管理员配置固定目录（不按用户区分）
- 用户个人授权：当前用户选择并授权自己的目录/文件（按用户区分）
- 拿到授权路径**不代表绕过当前用户系统权限**，返回内容前仍应检查用户权限

## 权限声明

在应用包 `config/resource` 声明 api-scope：

```json
{
  "api-scope": ["trim.file.userAccess", "trim.file.userAcl"]
}
```

只声明实际用到的 Scope，不要无脑写满。

## 错误码

| 错误 | 场景 |
| --- | --- |
| `code: 1` + "仅管理员可进行此操作" | 非管理员调用共享授权 |
| `status: "error"` + `error: "access_denied"` | 授权路由回调被拒 |

完整错误码见官方文档：https://developer.fnnas.com/api/error-codes

## 参考

- 官方文档：https://developer.fnnas.com/docs/（llms-full.txt 可整站下载）
- 更新日志：https://developer.fnnas.com/docs/update-log/
- trim-cli 管理 NAS：见 `../SKILL.md`（管理文件/存储/Docker/应用等）
