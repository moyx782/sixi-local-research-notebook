# Domel 公开资料采集验收

日期：2026-09-19。后端：/Users/yxmo/Library/Application Support/Sixi/backend/releases/20260919T080847117Z-3801。

用户选择只采集公开资料，不接受网站用于业务沟通的下载登记用途。未提交登记，没有创建 Domel Cookie 会话。登录/登记属于可选补充；无人操作或不同意授权时，受限内容跳过，其他采集继续。

## 已保存的页面

| 页面 | 正文字符数 | 质量 | 本机查询 |
| --- | ---: | --- | --- |
| [Electric motors & components · Domel](https://www.domel.com/) | 6839 | full_text | [查看资料](http://127.0.0.1:4173/api/documents/12f53425-9d93-450c-b08d-c21f72546022) |
| [EC/BLDC low voltage motors · Products](https://www.domel.com/products/ec-bldc-low-voltage-motors-48) | 877 | full_text | [查看资料](http://127.0.0.1:4173/api/documents/de789942-78f5-4109-92eb-a16dfa1aa367) |
| [720 inner runner motor · EC/BLDC low voltage motors · Motors](https://www.domel.com/product/720-inner-runner-motor-24) | 2078 | full_text | [查看资料](http://127.0.0.1:4173/api/documents/5988c083-032e-4835-9c04-0856996528ad) |

三项任务均为 succeeded，原始 HTML、来源和抓取时间可查询。720 详情包含公开规格，重复采集结果 unchanged=1，按 720 检索通过。

EC/BLDC 分类页曾因页面布局类名干扰正文提取而失败；已增加对明确正文区域的二次提取，并保留段落、隐藏控件和错误页面检查，修复后入库成功。历史失败任务保留。

## 下载与授权范围

[720 产品页](https://www.domel.com/product/720-inner-runner-motor-24) 的 Technical Data 部分要求下载登记，邮箱必填，并要求同意将资料用于业务沟通，网站说明登记信息会保存在 Cookie 中。该部分未登记、未下载。

分类页的 [公开介绍 PDF](https://www.domel.com/document-download/952) 已验证匿名 GET 返回 200 / application/pdf；后端当前尚未接入 PDF 正文解析，因此本次仅完成网页正文采集，不将其记为已入库 PDF。

## 可追溯编号

- https://www.domel.com/
  - sourceId: `706c6db1-3369-4c92-8579-71436b363909`
  - jobId: `f0b2aab8-c0cf-4293-b7f7-a4d6fc50e103`
  - documentId: `12f53425-9d93-450c-b08d-c21f72546022`
- https://www.domel.com/products/ec-bldc-low-voltage-motors-48
  - sourceId: `ab8acb77-1d98-4d09-b042-107a4b8912ae`
  - jobId: `3b3a6c84-c1eb-4c31-8ee0-4346a40bc9cb`
  - documentId: `de789942-78f5-4109-92eb-a16dfa1aa367`
- https://www.domel.com/product/720-inner-runner-motor-24
  - sourceId: `618234a7-f242-40a4-aa29-22edcb250ecc`
  - jobId: `5b4bfa7b-1747-41cb-a4b3-6b30f1166a36`
  - documentId: `5988c083-032e-4835-9c04-0856996528ad`

去重验证任务：`fb673492-7493-49d5-90ac-25c1533c130a`。

## 自动化边界验证

34 项自动化测试通过。新增测试覆盖：RSS 中认证失败后，后续公开外站条目仍采集；已失效会话的单独来源结束为 failed / skipped，随后排队的公开来源仍成功。不等待用户登录，也不将登录页或摘要冒充受限正文。
