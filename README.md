# 思绪：Domel 战略市场研究原型

当前为第 2 周结束的本地研究原型。前端以研究问题、对象、信息源、Agent 采集、Evidence、Findings、可选审核和 Report 为主线，直接连接现有 Node + SQLite 后端。采集和手动研究无需 AI 密钥。

支持工业电机市场的季度研究范围、来源评估、竞争对比、客户需求、情景与建议，以及有 Evidence 依据的市场吸引力评分。审核可跳过；报告对待审核内容逐条标注。

当前范围和待验证事项见 [第 2 周交付记录](docs/WEEK2-PROTOTYPE.md)，操作演示及真实用户测试计划见 [演示说明](docs/DEMO.md)。

## 启动与验证

需要 Node.js 22.22.2+（22 系列）、24.15+（24 系列）或 26+。

```sh
npm ci
SIXI_AUTH_REQUIRED=1 npm start
npm test
npm run check
```

`npm run test:live` 可额外运行真实网络验证：抓取 SQLite 官方网页和 Mozilla Readability 的 Atom 订阅，检查正文、原始响应、重复采集及检索。该命令使用临时数据库并在结束后清理，不向个人资料库写入示例数据。

启用认证后首次打开页面创建管理员（密码至少 10 位），再在设置中添加研究成员。`npm start` 未设置 `SIXI_AUTH_REQUIRED=1` 时为本机开发免登录模式；`deploy:local` 默认启用认证。

服务默认监听 `127.0.0.1:4173`。需要局域网访问时部署前设置 `SIXI_BIND_HOST=0.0.0.0`，服务会监听本机网卡并在状态中列出局域网地址；`PORT` 可覆盖端口；`SIXI_DATA_DIR` 可覆盖数据目录，默认 `~/.sixi`。采集数据保存到 `library.sqlite`，原有 AI 配置仍在 `config.json`。同一个数据目录只运行一个后端进程。

## 本机后台部署（macOS）

```sh
npm run deploy:local
npm run service:status
npm run service:restart
npm run service:stop
npm run service:start
```

部署命令将代码复制到 `~/Library/Application Support/Sixi/backend/releases/` 中的独立版本目录，按 lockfile 安装依赖、运行语法检查和全部自动化测试，再备份资料库并安装用户级 launchd 服务 `com.sixi.backend`。服务在登录后启动，退出后由 macOS 拉起；不依赖开发终端或工作区进程。代码更新后再次运行 `deploy:local`。如果端口被 `npm start` 等未托管进程占用，部署会拒绝覆盖，应先确认并停止该旧进程。

- 启动配置：`~/Library/LaunchAgents/com.sixi.backend.plist`
- 部署记录：`~/Library/Application Support/Sixi/backend/active.json`
- 日志：`~/Library/Logs/Sixi/stdout.log`、`stderr.log`
- 部署前资料库备份：`~/.sixi/backups/`（数据目录可通过 `SIXI_DATA_DIR` 更改）

资料库与 AI 密钥不复制到代码版本目录，继续使用原数据目录。默认端口是 4173，默认仅监听本机；局域网模式会允许当前机器网卡地址的 Host/Origin，并继续要求登录。浏览器使用 `http://127.0.0.1:4173` 或状态命令列出的局域网 URL，不再允许 `file://` 的 `Origin: null` 访问接口。数据库目录通过操作系统自动释放的 SQLite 排他锁限制为单实例，重复启动不会重置正在运行的任务。

正式部署会复制完整 `frontend/` 模块和静态入口。

已有部署时，`npm run deploy:local -- --backend-only` 只更新后端，复用当前已部署版本的静态页面，适合前端文件正在独立开发的情况。

部署记录固定本次 Node 可执行文件路径；如果卸载或升级该 Node 版本后清理旧安装，应使用新的 Node 再次部署。旧代码版本和资料库备份保留供人工回退；新版本启动验收失败时，部署脚本自动恢复此前的 launchd 配置。日志和旧版本目前不自动轮转或清理。

对已部署服务进行真实联网验收：

```sh
SIXI_SMOKE_BASE_URL=http://127.0.0.1:4173 npm run test:live
```

与默认临时数据库测试不同，此命令会在目标服务的资料库中保留 SQLite 官方文档和 Mozilla Readability 订阅两项公开验收来源。它检查正文、原始响应、重复采集、订阅降级标记和关键词查询。

## 认证与本机工具

正式本地部署默认开启认证。登录会话采用 HttpOnly、SameSite=Strict Cookie，12 小时到期；密码只存带随机盐的 scrypt 哈希。管理员可配置模型、变更 Cookie 会话并创建研究成员；成员共享本机资料与研究项目，不提供项目级隔离。退出登录不停止队列。

本机 Cookie CLI 和联网验收脚本自动读取数据目录内权限为 0600 的 `local-client-token`，作为本机管理员工具凭据。不要分享该文件。自定义端口时同时设置 `SIXI_DATA_DIR`，将工具指向对应数据目录。浏览器不会接收此令牌。

以下 HTTP 示例在开发免登录模式下可直接执行；认证部署须使用已登录浏览器，或在本机脚本中读取该令牌并用 Authorization Bearer 请求。切勿将令牌写入源码、URL 或 shell 历史。

该认证面向受信任的本地或局域网原型；局域网模式只允许当前网卡地址的 Host/Origin，仍要求登录。公网部署尚未完成，未来需单独配置 HTTPS、域名、反向代理、Secure Cookie、账号恢复和部署平台。

## 研究接口

以 `/api/research/projects` 创建/列出项目；`/{id}` 读取项目与关联资料。`/{id}/edit` 保存研究范围，`attach` 复用资料，`collect` 使用既有采集器，`collect-all` 一次提交一组搜索结果并复用已排队或已完成来源，`pdf` 提取上传文件文字。

`/{id}/evidence` 保存精确原文与来源评估；`evidence/{evidenceId}` 确认或移除未被引用的证据。`findings` 保存有引用的发现，`review/{findingId}` 记录审核。`generate` 接受 `mode=evidence|findings`，调用既有模型适配器后再校验原文/引用。

`GET /{id}/report` 仅纳入 Keep；加 `?skipReview=true` 纳入待审核发现并逐条标注。Reject 始终排除；Investigate More 单列待调查问题。修改研究范围会将已有发现恢复待审核。

PDF 使用 PDF.js 在本机提取文字（5 MB / 100 页 / 450,000 字），扫描件或复杂排版可从资料库上传并选择 MinerU 云解析。导出报告支持 Markdown 与浏览器打印/另存 PDF。

## 提交采集

网页：

```sh
curl http://127.0.0.1:4173/api/collections \
  -H 'Content-Type: application/json' \
  -d '{"type":"url","url":"https://www.sqlite.org/whentouse.html"}'
```

RSS / Atom（最多抓取前 20 条有效条目，可设置 `limit` 为 1–50）：

```sh
curl http://127.0.0.1:4173/api/collections \
  -H 'Content-Type: application/json' \
  -d '{"type":"feed","url":"https://github.com/mozilla/readability/releases.atom","limit":3}'
```

手动文本：

```sh
curl http://127.0.0.1:4173/api/collections \
  -H 'Content-Type: application/json' \
  -d '{"type":"text","title":"研究摘录","content":"需要保存和检索的资料正文。"}'
```

响应为 HTTP 202，返回 `job.id` 和 `job.sourceId`。查询 `GET /api/collections/{job.id}` 获取最终状态。`queued` 为等待，`running` 为采集中，`succeeded` 为完成，`partial` 为存在摘要降级、无效条目或部分失败，`failed` 为失败。`result.items` 中列出每条资料的结果，`error` / `warnings` 提供原因。

## 查询接口

| 接口 | 用途 |
| --- | --- |
| `GET /api/health` | 来源、资料和各状态任务数 |
| `POST /api/collections` | 提交网页、订阅或文本采集 |
| `GET /api/collections` | 采集任务列表 |
| `GET /api/collections/{id}` | 任务状态、进度和结果 |
| `GET /api/sources` | 来源列表与最后一次任务状态 |
| `POST /api/sources/{id}/collect` | 重新采集或重试该来源 |
| `GET /api/documents?q=关键词` | 中英文标题、正文的字面子串检索 |
| `GET /api/documents?sourceId=来源ID` | 按来源筛选 |
| `GET /api/documents/{id}` | 正文、内容摘要、内容指纹和出处 |
| `GET /api/documents/{id}/raw` | 当前来源的原始响应文本和内容类型 |
| `GET /api/cookie-sessions` | 会话编号、绑定来源、状态和到期时间；不返回 Cookie |
| `POST /api/cookie-sessions` | 在本机钥匙串录入或更新 Cookie，推荐通过下方 CLI 调用 |
| `DELETE /api/cookie-sessions/{id}` | 移除会话；保留已采集资料 |

列表支持 `limit`（1–100，默认 20）和 `offset`（默认 0）。原始内容接口支持 `sourceId`，以选择具体出处；返回 JSON 中的 `raw.content` 是原始文本，不应直接作为可信 HTML 渲染。

## 复用网站登录 Cookie（macOS）

先在浏览器登录目标网站，打开开发者工具的 Network，刷新需要采集的页面，选择该页面请求，在 Request Headers 中复制 **Cookie** 的值。复制的是发出的 Cookie 请求头，不是响应中的 Set-Cookie，也不是整个请求或浏览器全部 Cookie。

在项目目录运行，替换示例域名；随后在隐藏输入提示中粘贴 Cookie：

```sh
npm run cookies -- set research https://wiki.example.com
npm run cookies -- list
```

`research` 是自定的会话编号。服务默认使用本机 4173 端口，`SIXI_BASE_URL` 可指定其他本机 HTTP 端口。CLI 也支持从标准输入读取，但不要把真实 Cookie 写成命令参数或保存进 shell 历史。无需把 Cookie 发到聊天里。

Cookie 保存到当前用户的 macOS 登录钥匙串；SQLite、采集任务和会话查询接口只记录编号及元数据。长 Cookie 分块保存到钥匙串以适配系统命令限制，每块验证后才切换会话引用。服务按数据目录的规范绝对路径区分钥匙串命名空间；移动数据目录或换机后需重新录入 Cookie，SQLite 备份不包含钥匙串凭据。钥匙串锁定时返回 KEYCHAIN_UNAVAILABLE，不降级为匿名采集。

采集时只传会话编号：

```sh
curl http://127.0.0.1:4173/api/collections \
  -H 'Content-Type: application/json' \
  -d '{"type":"url","url":"https://wiki.example.com/article","sessionId":"research"}'
```

RSS/Atom 同样支持 `sessionId`。同一 URL 的匿名来源、不同会话来源分别保留，防止重新采集时混用登录状态。已有匿名来源要改用会话，应提交一次带 `sessionId` 的采集，此后用返回的 `sourceId` 重新采集。

会话严格绑定 **HTTPS 协议、完整主机名和端口**；不会自动用于父域、子域或其他网站。已登录请求的跨来源跳转会停止；RSS 指向其他来源的文章只匿名请求。仅复用显式导入的 Cookie 请求头，不读取浏览器的 Cookie 数据库，不自动同步浏览器变化或响应 Set-Cookie，也不继承浏览器 Cookie 的 Path/Domain/Expires 属性。请为目标站点选择适用的请求，并可用 `--expires` 主动设置会话到期时间，例如 `--expires 2026-12-01T00:00:00Z`。

收到 401/403、跳转到常见登录路径，或返回含登录表单的页面时，将会话标记为 `needs_login`。后台不等待用户登录：跳过本轮需要该会话的条目，继续采集订阅里的公开外站条目及后续排队来源。任务结果含 `authRequired: true`、`sessionId` 和 `errorCode: AUTH_REQUIRED`，每个跳过项标记 `outcome: skipped`，`skipped` 是 `failed` 中因会话问题跳过的数量。保留已经采集的条目，不用订阅摘要掩盖登录失败。单独的受限来源结束为 failed，部分成功的订阅为 partial；都不会挂起队列。

登录只作为可选增强。用户未操作或不接受站点登记用途时，继续采集公开内容，不自动注册、不提交个人资料。以后重新登录网站并运行同一条 `cookies -- set` 命令，再调用 `POST /api/sources/{id}/collect` 可补采；此前任务状态不会自动改变。提交接口对已失效会话返回 AUTH_REQUIRED 时，调用方也应继续处理其他来源。403 也可能表示权限不足或站点风控，更新 Cookie 不保证解决。

移除会话：

```sh
npm run cookies -- remove research
```

这一版支持服务器直接返回正文的登录页面。依赖 JavaScript、设备绑定、验证码、SSO 浏览器交互或额外 Authorization 请求头的网站，仍可能需要专用连接器或浏览器采集。登录页识别采用启发式规则，不能识别所有站点；请检查任务结果与原始响应。Cookie 认证不替代 AI 服务的 API Key。

## 数据行为

- 网页提取标题、正文、作者、发布时间，记录提交地址、跳转后的地址和采集时间。普通 HTTP 请求和 HTML 解析不执行页面脚本；显式勾选 Playwright 视觉采集时，使用无头 Chromium 等待页面渲染，另外保存可见文字和页面截图。剔除导航、按钮、隐藏内容，并检查提取片段中的有效段落，拒绝仅包含导航计数或常见加载错误的页面。正文识别仍是启发式规则，极短内容或纯列表页面可能无法自动提取。
- 相同正文使用 SHA-256 去重，多地址保留各自出处；同一地址正文变化后生成新正文版本。资料列表展示当前来源指向的版本；旧正文仍可按 ID 读取，但目前只保留来源最新的原始响应，不提供完整历史快照查询。
- RSS 优先采集条目的网页正文。失败时，只有存在订阅正文或摘要才入库，并标记 `feed_excerpt`。已有完整正文不会被失败时的摘要覆盖。
- `full_text` 表示正文提取成功，`feed_excerpt` 表示订阅内容降级，`imported_text` 表示手动导入；这不是事实准确性评级。
- 网络瞬时错误、429 和部分 5xx 最多尝试 3 次；每次最多 15 秒，单任务网络预算为 3 分钟。超过预算的未完成条目会记录失败或降级。同一来源正在执行时，重复提交复用现有任务，`reused=true`。
- SQLite 保存任务队列。进程重启会重新执行被打断的任务，通过幂等入库避免重复资料；任务计数反映本次重新执行的结果。
- 单次远程响应最多 2 MB（包括解压后的大小），普通请求 JSON 最多 1 MB（PDF 上传接口为 8 MB），手动正文最多 500000 字。默认只允许公网 HTTP(S)，逐次验证跳转与 DNS 地址。

## 当前网络环境

某些本机 TUN 代理将域名解析为 `198.18.0.0/15` 的 Fake-IP。检测到全部 DNS 结果均处于这个网段时，采集器使用 Cloudflare `1.1.1.1` 的 [DNS over HTTPS JSON 接口](https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json/)重新解析，再验证并固定真实公网地址。只发送域名，不发送页面路径、正文或 AI 密钥。`SIXI_DNS_FALLBACK=off` 可关闭此兼容。普通内网地址不会触发该回退。

## 范围和限制

目前支持关键词搜索发现、已知 URL 网页、RSS / Atom、Markdown / TXT、PDF、截图、手动文本，以及显式导入 Cookie 的 HTTPS 页面；研究资料由 SQLite 资料库统一管理。普通 URL 使用轻量 HTTP；在信息源表单勾选“Playwright 视觉采集”后，可渲染 JavaScript 页面并保存可见文字与 PNG 截图。扫描 PDF / 截图可显式选择 MinerU 云解析。尚未实现自动登录或定时订阅调度。

Playwright 视觉采集的安装、限制、会话复用和资料库附件格式见 [视觉采集说明](docs/VISUAL-CAPTURE.md)。

原有 `/api/config`、`/api/ask` 仍可使用；采集不会自动把资料发送给 AI。本次未进行付费模型调用。

### DeepSeek 与自定义模型接口

管理员登录后进入 **AI 设置 → 快速配置 → DeepSeek · Chat Completions**，预设会填写：

| 字段 | DeepSeek 官方接口配置 |
| --- | --- |
| Provider | `deepseek` |
| API 协议 | OpenAI 兼容 · Chat Completions (`openai-chat`) |
| Endpoint | `https://api.deepseek.com/chat/completions` |
| Model | `deepseek-flash`（也可按账号可用模型填写） |
| API Key | 在本地页面填写 DeepSeek 控制台生成的密钥 |

也可以选择 **DeepSeek · Anthropic Messages**，协议为 `anthropic-messages`，完整 Endpoint 为 `https://api.deepseek.com/anthropic/v1/messages`。预设依据 [DeepSeek 官方首次调用说明](https://api-docs.deepseek.com/zh-cn/) 与 [Anthropic 兼容说明](https://api-docs.deepseek.com/zh-cn/guides/anthropic_api/)，核对日期 2026-09-19。模型 ID 是可编辑字段，不受旧版内置模型列表限制。

Endpoint 接受 HTTPS 基础地址或完整接口地址，保存后显示补全的最终请求地址。Chat 协议补全 `/chat/completions`；Messages 协议补全 `/v1/messages`（已有 `/v1` 时只补 `/messages`）。自定义网关选择与其兼容的协议并填写网关地址。暂不支持 Responses 协议或内网 HTTP 模型服务。

点击 **测试连接** 会使用当前表单（尚未保存也可测试）发送一条只要求回复 OK 的消息，不包含资料库内容；此操作可能产生少量模型费用。测试成功后点击 **保存配置**。保存配置本身不调用模型。测试仅验证认证、请求格式及返回正文，不代表研究质量验收。

`POST /api/config` 增加 `protocol` 与 `endpoint` 字段；`POST /api/config/test` 接受相同字段，返回连接耗时和非敏感连接信息，不保存设置。两者仅限管理员。更换服务商、协议或请求地址时不会沿用旧密钥；仅修改模型时可留空保留密钥。旧配置缺少协议时仍使用 `builtin` 内置适配器。密钥存于本机 `config.json`，文件权限为 `0600`，API 不回传密钥。

### 自动搜集、人工补采与资料库直传

搜索服务可在「AI 设置 → 搜索与网页采集」选择本地 SearxNG 或 DuckDuckGo，并测试连接；手动 Search 与自动搜集共用配置。已有网址可在「WebFetch / URL」直接提交，跳过搜索。两者都不要求模型密钥。本地 SearxNG 部署、代理和排错见 [本地搜索说明](docs/LOCAL-SEARCH.md)。

创建研究时默认勾选“创建后自动搜索并采集相关资料”；已有研究可在“信息源”或“Agent 采集”点击“自动搜集相关资料”。自动搜集提供“深入 / 标准”两档：深入模式最多 10 组检索词、96 个去重候选、每域名 5 个来源，并优先报告、研究、标准、年度资料及正文较长的页面；标准模式最多 6 组检索词、48 个候选、每域名 3 个来源。采集材料数可自定义为 1–30 个，界面默认深入模式、12 个材料。已配置模型时，AI 辅助规划关键词及筛选候选；失败或超时自动回退规则。只向模型提供研究问题、市场范围及公开搜索摘要，规划不会读取已有私有资料。规则及模型选择均不代表正文或来源可信度已核验。

采集去重按规范化来源地址执行：忽略 `www`、末尾斜杠、常见追踪参数和查询参数顺序，同一来源不会再次创建采集任务；同一研究的后续搜集轮次会排除已采集来源，并在记录中显示跳过数量。正文先按原文 SHA-256 合并，再按 NFKC、大小写和空白规范化指纹合并格式变化造成的重复；不同地址返回同一正文时共享一份资料并保留多个出处。服务启动时还会清理未被 Evidence 引用的历史格式重复资料，已被引用的资料会保留以确保原文证据不失效。

任务记录持久化，关闭浏览器不停止，服务重启恢复未完成的搜索。一个项目同时只运行一轮，重复启动复用当前任务；修改研究范围会停止旧范围追加来源。停止按钮仅停止后续搜索，已提交到采集队列的来源仍会完成。搜索验证、登录页、失败页面及 PDF 搜索结果会生成“人工补采”任务，自动流程不等待它们。没有绕过登录、验证码或同意流程。

人工补采可指定负责人，由真人打开原始页面、自行登录或搜集后提交文字、出处，以及 PDF、Markdown、TXT 或截图附件。可以只保存到资料库，或同时加入当前研究；任务可跳过。分配仅记录在本地工作区，不会发送邮件或消息。文件原件保留在资料库并可下载；本地 PDF / 文本会提取文字，图片本地保存须填写文字，选择 MinerU 后可在后台 OCR，识别文字仍须对照原件核实。

**全部资料库 → 上传资料** 不依赖任何研究项目：支持 Markdown、TXT、PDF、PNG/JPEG/WebP 截图，也可直接填写文字。文件最大 5 MB，文本文件最大 1 MB；本地 PDF 提取上限 100 页且须有文字层；扫描件可选择 MinerU 云解析。保留原文件，阅读面板可下载；图片可单独入库，没有摘录时明确显示“尚无文字”，不会假装已识别内容。之后可将资料加入任意研究。

新增接口（均要求登录，开发免登录模式除外）：

- `POST /api/research/projects/:id/discover`：开始自动搜集，`depth` 可选 `deep` / `standard`，`maxSources` 可选 1–30，`useAI` 可选；立即返回 202。未传 `depth` 时保持标准模式以兼容 API 调用方。
- `POST /api/research/projects/:id/collect-all`：一次提交 1–50 个来源（搜索结果的一键采集入口）；请求内重复项、已排队来源和已完成来源会复用，不重复创建任务。
- `GET /api/research/projects/:id/discovery`：读取最新进度；`POST .../discover/cancel` 停止后续搜索。
- `GET/POST /api/research/projects/:id/handoffs`：查看/创建人工任务；`POST .../handoffs/:taskId` 支持 `assign`、`skip`、`complete`。
- `POST /api/library/uploads`：直接上传；文件传 `filename` + `base64`，纯文字传 `content`，可附 `title`、`url`。
- `GET /api/library/uploads/:uploadId/file`：下载原文件；`.../image` 仅展示图片。截图接口需要登录。

`npm audit --omit=dev` 目前报告已有 Pi SDK 及其 `extract-zip` 依赖共 2 个 high 条目；采集链路不加载该 SDK。本次没有强制更换或降级原有 AI SDK。新增采集依赖未出现在该审计报告中。

模块结构和扩展方式见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。


## MinerU 官方云解析

在 **AI 设置 → MinerU · 文档解析与 OCR** 填入 [MinerU API 管理](https://mineru.net/apiManage/docs) 中创建的 Token，点击“测试 MinerU 连接”，然后保存。测试申请一个上传地址，不上传文件、不启动解析。Token 与模型 API Key 独立保存在本地 `mineru.json`，权限 0600；API 只返回是否已配置，只有管理员可修改。Token 不需要带 `Bearer` 前缀。

协议固定为 MinerU 官方云 API v4，Endpoint 为 `https://mineru.net/api/v4`；可选择 `vlm` / `pipeline`，及中文、英文或繁体中文。此版本不接自部署接口或代理。

**全部资料库 → 上传资料 → MinerU 云解析** 支持 PDF（包括扫描件）与 PNG/JPEG/WebP。只有主动选择云解析的文件会发至 MinerU，原件保留本机；本地方式和历史文件不会自动外传。人工补采也可以选择 MinerU，只上传截图，完成后按选项仅入库或加入研究。已保存截图/PDF 的阅读面板提供“用 MinerU 解析原件”，生成新资料并保留既有文字与 Evidence。

后台使用 `POST /file-urls/batch` 申请上传地址，再 PUT 文件，轮询 `GET /extract-results/batch/:id`，下载结果 ZIP 中的 `full.md`，作为机器提取文字入库。原始网址和用户补充说明保留。表格以 Markdown 保存，原图与原件可核对；目前不展示 ZIP 中的独立图表图片或布局 JSON。

资料库显示等待、解析、成功与失败状态，失败可重试，关闭浏览器不影响；重启优先恢复已有远程批次。缺少 Token 时仍保留原件，填写 Token 后点击重试。常规采集队列不等待 MinerU。应用文件限额为 5 MB（并非 MinerU 平台上限），识别文字最多 440000 字、补充说明最多 5000 字；单次等待最多 30 分钟。ZIP 下载最多 30 MB，只在内存读取有大小限制的 Markdown，不向磁盘解压路径。

API：
- `GET/POST/DELETE /api/mineru/config`：读取脱敏配置、保存或清除 Token。
- `POST /api/mineru/config/test`：使用当前表单测试，不自动保存。
- `POST /api/library/uploads`：增加 `parser: "mineru"` 使用云解析，默认 `local`。
- `GET /api/library/uploads`：上传记录、解析状态与结果 `documentId`，不暴露签名 URL 或 Token。
- `POST /api/library/uploads/:id/parse`：重试失败的云解析，或把本地原件作为新资料送解析。

解析连通不代表 OCR 准确；报告中的关键数字、表格与引用应对照原件核实。
