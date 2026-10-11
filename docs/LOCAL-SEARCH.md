# 本地 SearxNG 与 WebFetch

研究问题 → SearxNG 搜索 → 相关性筛选 → WebFetch 抓取正文 → SQLite 资料库 → Evidence。手动 Search 和自动搜集使用同一搜索配置。已有 URL 时直接选择「信息源 → WebFetch / URL」，无需先调用搜索；WebFetch 复用现有采集器，不执行页面 JavaScript，也不绕过登录或验证码。

## 部署与操作

需要 Docker Engine 和 Docker Compose。macOS 可使用 Colima；先启动已有环境，不会删除或重建虚拟机：

```sh
colima start
SIXI_DOCKER_CONTEXT=colima npm run search:start
SIXI_DOCKER_CONTEXT=colima npm run search:status
SIXI_DOCKER_CONTEXT=colima npm run search:stop
```

Docker Desktop 或 Linux 可省略 `SIXI_DOCKER_CONTEXT`，使用 Docker 当前 context。首次启动生成配置到 `~/.sixi/searxng/`（遵循 `SIXI_DATA_DIR`），不会把服务密钥写入仓库，也不会覆盖已有运行配置。模板位于 `scripts/searxng/`。镜像固定为实测版本 2026.9.19-c0014f015 的官方 GHCR digest，避免 `latest` 自动变化。

服务仅绑定 `127.0.0.1:8888`。容器随 Docker 恢复运行；电脑重启后需要先启动 Docker/Colima，本命令不会为虚拟机安装开机服务。应用后端仍由原 launchd 服务运行。停止搜索容器不影响资料库和 WebFetch。

打开应用设置，选择「本地 SearxNG」，Endpoint 填 `http://127.0.0.1:8888/search`，点击「测试搜索连接」后保存。无需 API Key。测试使用 `Domel electric motors` 查询，不保存未提交配置，也不使用备用服务掩盖连接失败。

## 代理与上游引擎

本机实测使用 Clash 7897 端口。Colima 内访问主机代理可用 `host.lima.internal`；容器中的 `127.0.0.1` 指向容器自身。首次部署可显式设置：

```sh
SIXI_DOCKER_CONTEXT=colima SEARXNG_PROXY=http://host.lima.internal:7897 npm run search:start
```

上述环境变量只用于首次生成 `config/settings.yml`。之后修改运行目录中的 `outgoing.proxies`，再执行 `docker --context colima compose -f ~/.sixi/searxng/compose.yaml restart searxng`。无代理需求时删除 `outgoing.proxies`；Docker Desktop 通常使用其文档提供的 `host.docker.internal`。代理地址必须从容器实际可达，不能直接照搬 Colima 地址。

镜像拉取与搜索请求是两条连接。本机首次拉取直连超时，因此在 Colima 虚拟机的 `/etc/docker/daemon.json` 为镜像下载设置了本机 HTTP 代理，原文件备份为 `/etc/docker/daemon.json.before-sixi-search`。该运行时设置可能随 Colima 重新生成配置而变化；已缓存镜像可直接启动。若需长期代理拉取镜像，可按 Colima/Docker 官方方式配置。没有修改 Clash 的 LAN 开放开关。

当前启用 Google、Bing、DuckDuckGo。搜索依然访问外部引擎，不是离线搜索。上游出现验证/超时会在搜索结果和自动搜集记录中提示；其他引擎成功的结果仍可使用。所有引擎均失败时按设置尝试 DuckDuckGo 备用搜索；备用也失败则记录人工补采任务，流程不等用户响应。建议保留证据核验：搜索摘要和排名不等于来源事实已被证实。

## 接口与保护

- `GET /api/search/config`：读取 `provider`、`endpoint`、`fallback`。
- `POST /api/search/config`：管理员保存上述配置；仅支持本机 SearxNG 地址。
- `POST /api/search/config/test`：管理员测试当前或表单中的未保存配置。
- `POST /api/search`：`{"query":"Domel electric motors","limit":10}`；返回实际 `provider`、`items`、`warnings`，回退时附 `fallbackFrom`。
- WebFetch 继续使用现有 `POST /api/research/projects/:id/collect`，请求 `{"type":"url","url":"https://www.domel.com/"}`。

应用登录与管理员权限继续生效。SearxNG 只允许显式配置的 loopback 地址，拒绝重定向，限制响应为 2 MB、单次 SearxNG 搜索为 20 秒；取消自动搜集会取消正在执行的搜索。网页正文抓取仍使用原有公共地址检查和 Cookie 精确域名规则，不因本地搜索服务放宽。

出现 HTTP 403 时，检查 SearxNG 的 `search.formats` 是否包含 `json`。若容器 healthy 但没有搜索结果，检查上游网络、代理及 `unresponsive_engines`；健康检查只说明服务启动，不代表每个上游引擎可用。

官方资料：[Docker 安装](https://docs.searxng.org/admin/installation-docker.html)、[Search API](https://docs.searxng.org/dev/search_api.html)、[代理设置](https://docs.searxng.org/admin/settings/settings_outgoing.html)。
