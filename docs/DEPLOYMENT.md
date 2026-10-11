# 本机部署与验收记录

验收日期：2026-09-19（Asia/Shanghai）。

## 当前部署

- 类型：macOS 用户级 launchd 服务；默认本机访问，可选局域网访问。
- 服务：`gui/501/com.sixi.backend`。
- 默认地址：[http://127.0.0.1:4173](http://127.0.0.1:4173)。局域网部署时使用 `SIXI_BIND_HOST=0.0.0.0 npm run deploy:local`，再通过 `npm run service:status` 查看当前网卡 URL。
- 健康接口：[http://127.0.0.1:4173/api/health](http://127.0.0.1:4173/api/health)；局域网设备将端口替换为状态命令列出的地址。
- 部署目录：`/Users/yxmo/Library/Application Support/Sixi/backend/releases/20260919T080847117Z-3801`。
- 启动配置：`/Users/yxmo/Library/LaunchAgents/com.sixi.backend.plist`。
- 数据目录：`/Users/yxmo/.sixi`。
- 部署前备份：`/Users/yxmo/.sixi/backups/20260919T080847117Z-3801.sqlite`。
- 日志目录：`/Users/yxmo/Library/Logs/Sixi`。
- Node：26.5.0；使用部署记录中的固定可执行文件路径。
- 已配置登录后启动及进程退出后自动恢复，不依赖开发终端。

## 验收结果

| 检查 | 结果 |
| --- | --- |
| 独立部署目录按 lockfile 安装依赖 | 通过 |
| 部署版本语法检查 | 通过 |
| 自动化测试 | 34/34 通过 |
| 真实网页采集 | SQLite 官方网页成功，正文 12,568 字符 |
| 原始响应与出处查询 | 通过 |
| 重复采集 | unchanged=1，无重复资料 |
| RSS/Atom | 订阅解析通过；网页正文不足时明确保存 feed_excerpt，任务为 partial |
| 关键词查询 | 找到已入库的 SQLite 正文 |
| Origin: null 拒绝 | 已部署接口返回 403，测试覆盖读取、写入与预检 |
| 数据目录单实例保护 | 第二进程拒绝启动，原运行任务不被改动 |
| 采集中 SIGTERM / SIGKILL | 子进程测试验证恢复、部分成果保留和去重 |
| 重新部署 | 成功，资料及任务记录与部署前完全一致 |
| 实际后台服务 SIGKILL | launchd 自动拉起新进程，资料 ID、内容指纹和任务记录不变 |
| 资料库和部署前备份 integrity_check | 均为 ok |
| 原有 AI SDK 在独立部署目录中加载 | 通过；未调用付费问答接口 |

初次联网验收的资料库包含 2 个公开验收来源、2 条资料、3 个采集任务（2 个 succeeded、1 个 partial）。partial 来自 Readability 发布页正文提取不足，保留订阅摘要并记录原因，未将导航文字当成正文。

部署中发现 launchd 卸载返回后服务名尚未完全释放的时序问题；失败部署已自动恢复旧配置，随后加入卸载等待与短暂启动重试，重新部署通过。

## 运维

在项目目录使用：

```sh
npm run service:status
npm run service:restart
npm run service:stop
npm run service:start
npm run deploy:local
```

再次对已部署服务运行联网验收：

```sh
SIXI_SMOKE_BASE_URL=http://127.0.0.1:4173 npm run test:live
```

该验收模式会保留公开样例来源。默认不设置 SIXI_SMOKE_BASE_URL 时，test:live 使用临时库并清理。前端未修改；当前部署不提供公网访问。已有 AI SDK 的依赖审计限制见 README。


## Cookie 与无人操作时的采集（本次更新）

- 后端版本：`20260919T080847117Z-3801`，使用 `--backend-only` 部署，三个静态页面文件与上一部署完全一致。
- 34 项测试全部通过，包括 Cookie 精确来源绑定、跨域阻断、失效与续期、长 Cookie 分块存储，以及登录失败后其他公开条目和排队来源继续采集。
- 实机 launchd 服务验证：16 KB 模拟 Cookie 写入、更新、读取、服务重启后复用元数据、移除均通过；模拟会话已清理，当前没有配置真实 Cookie。
- 模拟 Cookie 未出现在资料库和服务日志；原有资料 ID 与内容指纹保持不变；最终资料库及本次备份完整性检查均为 ok。
- 最终版本再次通过真实 SQLite 网页及 GitHub Atom 采集、去重、查询测试，测试使用临时资料库。
- Domel 采用公开资料模式，3 个页面已入库，详情见 [DOMEL.md](DOMEL.md)。下载登记未提交，受限技术资料跳过。
- 当前资料库：5 个来源、5 条资料、8 个任务；6 succeeded、1 partial、1 failed。failed 是修复前的分类页解析失败记录，修复后已重新采集成功，历史记录保留。


## 第 2 周研究工作区版本

完整部署现在复制 `frontend/`，避免入口存在而 JS 模块缺失。默认启用本地登录认证；首次打开由用户创建管理员账号，不预置共享默认密码。已有资料库、Cookie 元数据及模型配置沿用，测试研究和账号仅存在于临时目录。

可通过 `SIXI_AUTH_REQUIRED=1 npm start` 在开发时验证认证；部署由 launchd 显式设置该变量。Cookie CLI 和真实网络 smoke 脚本用数据目录内私有本机令牌兼容认证。

页面验收：登录/初始化、研究定义、信息源、Agent 队列、Evidence、Findings、竞争对比/客户需求/战略视图、可选审核、Report、设置。部署后核对 `/app.js` 以及 `frontend/core.js`、`views.js`、`market.js`、`auth.js` 全部返回 200；匿名读取 `/api/documents` 应返回 401。

当前交付只在本机访问，不是外部评审地址。Figma MVP、真实员工访谈和 10+ 用户测试见 WEEK2-PROTOTYPE.md 中的后续验收项。
