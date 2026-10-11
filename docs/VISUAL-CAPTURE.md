# Playwright 视觉采集

URL 信息源现在可以按条目选择 Playwright 视觉采集。它适合需要 JavaScript 渲染、普通 HTTP 只能拿到空壳 HTML 的公开页面；默认的普通 URL 采集仍使用轻量 HTTP，不会为每个来源启动浏览器。

## 使用方式

1. 打开一个研究的“信息源”页，选择“WebFetch / URL”。
2. 输入一个或多个 `http://` 或 `https://` 地址。
3. 勾选“Playwright 视觉采集”，再提交。

采集器会启动无头 Chromium，等待 `DOMContentLoaded`，最多等待一小段网络空闲时间，再读取页面可见文字并保存 PNG 截图。截图会作为资料库附件出现在阅读面板中；文字是渲染后的证据候选，应与截图和原始页面一起核实。每个截图上限 5 MB，默认视口为 1440×900，单页超时为 35 秒。

## 安装与运行时

首次在新机器部署时运行：

```sh
npm ci
npm run browser:install
```

`npm run deploy:local` 会在部署版本中安装 Node 依赖；Chromium 浏览器包由 Playwright 缓存管理。若服务提示“未安装 Chromium”，在同一用户下执行 `npm run browser:install` 后重新部署或重启服务。也可以用 `SIXI_PLAYWRIGHT_EXECUTABLE` 指定一个已安装的 Chromium 可执行文件。

## 登录和安全边界

视觉采集可选择已有的 Cookie 会话，后端只把该会话的 Cookie 注入当前页面上下文；不会从浏览器配置目录读取 Cookie，也不会自动登录、绕过验证码或同意站点登记用途。页面跳转到登录页时，任务记录 `AUTH_REQUIRED` 并交给人工补采，其他排队来源继续处理。

仅允许公网 HTTP(S) 地址。回环、内网、保留地址和本地域名会被拒绝；本地动态页面只在自动化测试中通过显式测试开关访问。浏览器会话在每个来源结束后关闭，任务按现有采集队列串行执行。

## 与 MinerU 的关系

Playwright 负责“打开并截图”，不负责 OCR 或视觉理解。扫描 PDF、图片或需要 OCR 的截图继续使用资料库里的 MinerU 解析入口；解析出的文字仍须对照原图核实。当前没有自动调用多模态模型解释截图。

## API 结果

`POST /api/research/projects/:id/collect` 或 URL 信息源提交中传入：

```json
{ "url": "https://example.com/article", "renderMode": "playwright", "fullPage": true }
```

成功入库后，资料的 `attachments` 包含 `kind: "image"`、`parser: "playwright"` 和受保护的 `/api/visual-captures/:id/image` 下载地址；正文出处仍保留最终跳转地址、采集时间和页面标题。
