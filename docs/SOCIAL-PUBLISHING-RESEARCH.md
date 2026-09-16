# 开源社交媒体发布方案调研

调研日期：2026-09-14。目标是登录自己的账号，发布小红书图文、国内抖音图文、原生微博和 B站动态。

本次核对公开仓库源码、官方项目文档及具体提交版本，没有运行这些项目，也没有用真实账号测试发布。“代码包含此流程”与“当前账号端到端可用”是不同结论。

**结论：会话隔离值得保留，登录界面可以改进。** 浏览器自动化项目可以使用可见窗口，也可以在后台运行并向控制台返回二维码；扩展可以复用现有浏览器会话；桌面应用可以内嵌登录窗口。我们当前打开专用 Chrome 是一种实现选择。下述项目尚不能直接替代全部四个平台的连接器。

**登录和发布是两层设计**

| 实际发布方式 | 登录与凭据 | 核实到的例子 | 主要适配工作 |
| --- | --- | --- | --- |
| 自动操作平台网页 | 用户登录一次，保存完整 profile、storage_state 或 Cookies | social-auto-upload、xiaohongshu-mcp | 编辑器、图片上传、验证弹窗和发布结果检测 |
| 直接请求平台网页接口 | 复用浏览器 Cookie，或将 Cookie 保存在本地文件/数据库 | Wechatsync、AiToEarn 的 Electron 代码 | 接口参数、会话过期、签名与实际内容类型 |
| 平台授权 API | 多数通过 OAuth 获取用户授权 token；也有应用密码等方式 | Postiz 的多数主流平台适配器 | 开发者应用配置、平台权限、token 刷新和异步发布 |

MCP 是调用这些能力的工具接口，不能据此判断底层采用哪种发帖方式。OAuth 本身是授权机制；是否能发原生内容取决于调用的接口及应用权限，不能把 OAuth 一概理解成分享链接。

**与目标最相关的源码案例**

1. **social-auto-upload：适合参考抖音和小红书图文流程。**

   核实提交 `0012d2c355f88f683cc38dde2a2db209e14091bc`，许可证 [MIT](https://github.com/dreammis/social-auto-upload/blob/0012d2c355f88f683cc38dde2a2db209e14091bc/LICENSE)。当前代码通过 Python 浏览器自动化进入创作中心、上传图片、填写文案和点击发布；CLI 支持无头与可见模式。[抖音图文源码](https://github.com/dreammis/social-auto-upload/blob/0012d2c355f88f683cc38dde2a2db209e14091bc/uploader/douyin_uploader/main.py#L1179)、[小红书图文源码](https://github.com/dreammis/social-auto-upload/blob/0012d2c355f88f683cc38dde2a2db209e14091bc/uploader/xiaohongshu_uploader/main.py#L771)。

   会话按平台和账号保存在 `BASE_DIR/cookies/{platform}_{account_name}.json`，内容是浏览器 `storage_state`，不同于完整 Chrome profile。后续启动新 context 时加载该状态。[会话路径](https://github.com/dreammis/social-auto-upload/blob/0012d2c355f88f683cc38dde2a2db209e14091bc/sau_cli.py#L263)、[登录状态保存](https://github.com/dreammis/social-auto-upload/blob/0012d2c355f88f683cc38dde2a2db209e14091bc/uploader/douyin_uploader/main.py#L265)。

   其 B站 CLI 包装 `biliup upload`，用于视频投稿；不能当作 B站动态连接器。图文发布流程主要依据页面跳转判断成功，并存在超时后再次点击的循环；借鉴页面操作时，应保留发条自己的提交记录和防重复发布机制。[B站命令](https://github.com/dreammis/social-auto-upload/blob/0012d2c355f88f683cc38dde2a2db209e14091bc/sau_cli.py#L562)、[抖音提交循环](https://github.com/dreammis/social-auto-upload/blob/0012d2c355f88f683cc38dde2a2db209e14091bc/uploader/douyin_uploader/main.py#L1215)。

2. **xiaohongshu-mcp：最值得参考二维码登录体验。**

   核实提交 `aad2a3d249a347859975ce3b76d3442c4a027780`，许可证 [Apache-2.0](https://github.com/xpzouying/xiaohongshu-mcp/blob/aad2a3d249a347859975ce3b76d3442c4a027780/LICENSE)。Go + Rod 操作小红书网页。服务默认无头运行，也提供可见登录程序。二维码接口返回图片，后台维持浏览器等待扫码，成功后保存 Cookies；新二维码替换旧等待会话。[服务与二维码生命周期](https://github.com/xpzouying/xiaohongshu-mcp/blob/aad2a3d249a347859975ce3b76d3442c4a027780/service.go#L127)、[启动配置](https://github.com/xpzouying/xiaohongshu-mcp/blob/aad2a3d249a347859975ce3b76d3442c4a027780/main.go#L22)。

   当前源码默认保存到运行目录的 `cookies.json`，可用 `COOKIES_PATH` 覆盖，并兼容已有 `/tmp/cookies.json`。应以固定版本源码为准，不能照搬旧教程中的路径。[Cookies 存储](https://github.com/xpzouying/xiaohongshu-mcp/blob/aad2a3d249a347859975ce3b76d3442c4a027780/cookies/cookies.go#L93)。

   它具备实际图文上传与发布代码，但通过离开编辑页判断完成；发布响应没有笔记 ID。直接接入时仍需要补充回执确认。[页面提交](https://github.com/xpzouying/xiaohongshu-mcp/blob/aad2a3d249a347859975ce3b76d3442c4a027780/xiaohongshu/publish.go#L405)、[响应结构](https://github.com/xpzouying/xiaohongshu-mcp/blob/aad2a3d249a347859975ce3b76d3442c4a027780/service.go#L53)。

3. **Wechatsync：扩展复用现有浏览器登录，但内容类型不匹配。**

   核实提交 `a98e42865387285afcc027c61836488748f3b30f`，许可证 [GPL-3.0](https://github.com/wechatsync/Wechatsync/blob/a98e42865387285afcc027c61836488748f3b30f/LICENSE)。扩展运行时通过携带浏览器凭据的请求操作平台网页接口，无需专用 Chrome；该路径复用浏览器 Cookie。[扩展运行时](https://github.com/wechatsync/Wechatsync/blob/a98e42865387285afcc027c61836488748f3b30f/packages/extension/src/runtime/extension.ts#L21)。

   微博适配器创建并保存的是 **微博头条文章草稿**，B站适配器保存的是 **专栏草稿**，都不等同于本项目要求的原生微博/B站动态。[微博草稿源码](https://github.com/wechatsync/Wechatsync/blob/a98e42865387285afcc027c61836488748f3b30f/packages/core/src/adapters/platforms/weibo.ts#L118)、[B站草稿源码](https://github.com/wechatsync/Wechatsync/blob/a98e42865387285afcc027c61836488748f3b30f/packages/core/src/adapters/platforms/bilibili.ts#L91)。

   公开树中未找到抖音和小红书适配器；注册器支持加载 private 适配器子模块，该子模块匿名访问返回 404。README 的平台数量不能等同于全部实现均有公开源码。[子模块配置](https://github.com/wechatsync/Wechatsync/blob/a98e42865387285afcc027c61836488748f3b30f/.gitmodules)、[注册器](https://github.com/wechatsync/Wechatsync/blob/a98e42865387285afcc027c61836488748f3b30f/packages/extension/src/adapters/index.ts#L50)。

4. **AiToEarn：可参考内嵌登录，必须区分 Electron 与后端代码。**

   核实提交 `9413d73918271bd716b9ea59f61c9f59e485619b`，许可证 [MIT](https://github.com/yikart/AiToEarn/blob/9413d73918271bd716b9ea59f61c9f59e485619b/LICENSE)。仓库中的 Electron 代码创建 `BrowserWindow` 登录窗口，读取对应 session 的 Cookies；账号的 `loginCookie`、`token` 保存到 `app.getPath('userData')/database.sqlite`。[登录窗口](https://github.com/yikart/AiToEarn/blob/9413d73918271bd716b9ea59f61c9f59e485619b/project/aitoearn-electron/electron/plat/xiaohongshu/index.ts#L116)、[账号模型](https://github.com/yikart/AiToEarn/blob/9413d73918271bd716b9ea59f61c9f59e485619b/project/aitoearn-electron/electron/db/models/account.ts#L32)、[数据库路径](https://github.com/yikart/AiToEarn/blob/9413d73918271bd716b9ea59f61c9f59e485619b/project/aitoearn-electron/electron/db/index.ts#L26)。

   Electron 的小红书、抖音图文函数直接请求网页接口。它们还有外部 HTTP 签名服务依赖，涉及传递会话或签名相关数据，不能当作完全本地、可直接复制的方案。[小红书发布](https://github.com/yikart/AiToEarn/blob/9413d73918271bd716b9ea59f61c9f59e485619b/project/aitoearn-electron/electron/plat/xiaohongshu/index.ts#L812)、[小红书签名依赖](https://github.com/yikart/AiToEarn/blob/9413d73918271bd716b9ea59f61c9f59e485619b/project/aitoearn-electron/electron/plat/xiaohongshu/index.ts#L1328)、[抖音签名依赖](https://github.com/yikart/AiToEarn/blob/9413d73918271bd716b9ea59f61c9f59e485619b/project/aitoearn-electron/electron/plat/douyin/index.ts#L1945)。

   同一版本后端代码中的抖音 provider 返回需要用户继续操作的 App 链接；小红书 provider 接收已有作品链接；B站 provider 提交视频稿件。未找到微博发布适配器，因此不作为四平台现成后端推荐。[抖音 provider](https://github.com/yikart/AiToEarn/blob/9413d73918271bd716b9ea59f61c9f59e485619b/project/aitoearn-backend/apps/aitoearn-server/src/core/channels/platforms/douyin/douyin-publish.provider.ts#L66)、[小红书 provider](https://github.com/yikart/AiToEarn/blob/9413d73918271bd716b9ea59f61c9f59e485619b/project/aitoearn-backend/apps/aitoearn-server/src/core/channels/platforms/rednote/rednote-publish.provider.ts#L65)、[B站 provider](https://github.com/yikart/AiToEarn/blob/9413d73918271bd716b9ea59f61c9f59e485619b/project/aitoearn-backend/apps/aitoearn-server/src/core/channels/platforms/bilibili/bilibili-publish.provider.ts#L73)。

5. **Postiz：借鉴控制台和持久化任务，不作为国内连接器。**

   核实提交 `36d5fc7b3ac3f17178b1589cf7a7337523017a41`，许可证 [AGPL-3.0](https://github.com/gitroomhq/postiz-app/blob/36d5fc7b3ac3f17178b1589cf7a7337523017a41/LICENSE)。多数主流平台通过官方 API/OAuth 发布，自部署需配置平台开发者应用。也有应用密码或扩展会话等其他认证方式。[官方账号配置文档](https://docs.postiz.com/self-host/providers/overview)。

   自部署服务端会将 token、refreshToken、tokenExpiration 写入数据库 `Integration` 记录。不能用 README 的概括性宣传推断它不保存 token。[账号 schema](https://github.com/gitroomhq/postiz-app/blob/36d5fc7b3ac3f17178b1589cf7a7337523017a41/libraries/nestjs-libraries/src/database/prisma/schema.prisma#L302)、[写入逻辑](https://github.com/gitroomhq/postiz-app/blob/36d5fc7b3ac3f17178b1589cf7a7337523017a41/libraries/nestjs-libraries/src/database/prisma/integrations/integration.repository.ts#L259)。

   当前使用 Temporal 执行可恢复的后台任务，把提交与结果查询分开；帖子表保存状态、发布时间、原帖 ID/链接和错误。适合借鉴定时与回执设计。[官方架构](https://docs.postiz.com/self-host/architecture)、[TikTok 结果查询](https://github.com/gitroomhq/postiz-app/blob/36d5fc7b3ac3f17178b1589cf7a7337523017a41/libraries/nestjs-libraries/src/integrations/social/tiktok.provider.ts#L396)。

   固定版本注册表没有本项目四个平台，TikTok 也不能算国内抖音。[平台注册表](https://github.com/gitroomhq/postiz-app/blob/36d5fc7b3ac3f17178b1589cf7a7337523017a41/libraries/nestjs-libraries/src/integrations/integration.manager.ts#L1)。

**B站动态与微博候选的额外核查**

- `adoresever/bilibili-mcp` 的提交 `1521d19d4118bfe23e08ec4c7702991c5f9de0ba` 确实包含扫码登录、`bili_credential.json` 凭据文件，以及调用 `dynamic.send_dynamic` 的图文动态函数。[登录存储](https://github.com/adoresever/bilibili-mcp/blob/1521d19d4118bfe23e08ec4c7702991c5f9de0ba/bili_login.py#L9)、[动态发布](https://github.com/adoresever/bilibili-mcp/blob/1521d19d4118bfe23e08ec4c7702991c5f9de0ba/mcp_server.py#L625)。但它依赖的 `Nemo2011/bilibili-api` 原仓库已于 **2026-07-06 归档**，当前主线只保留停止维护、关停声明。因此本次不将这条依赖链推荐为可持续维护的首选。[依赖](https://github.com/adoresever/bilibili-mcp/blob/1521d19d4118bfe23e08ec4c7702991c5f9de0ba/requirements.txt)、[上游当前声明](https://github.com/Nemo2011/bilibili-api/blob/3798d3b3bd3c3a93678d5a0367637a19262303ef/README.md)。
- `prism-agent` 的提交 `22020455ad63c48ebf03ba9bdc520fbbbcf62b1f` 有直接操作微博首页编辑器的代码，说明此路线存在其他实现；其微博提交以成功提示或输入框清空判断结果，没有返回帖文 ID。所读微博填充函数也未包含图片上传路径，不宜当作完整替代。[微博源码](https://github.com/liuyifan00565/prism-agent/blob/22020455ad63c48ebf03ba9bdc520fbbbcf62b1f/backend/platforms/weibo.py#L77)。
- `kevinten-ai/mcp-social-publisher` 的提交 `1c0059ea295ed16ee48c81f8f5bf5bd1e199d27a` 中，小红书只返回手动发布指导；微博要求开放平台 access token；B站是专栏发布。平台名称覆盖不代表满足我们的四种内容需求。[小红书占位实现](https://github.com/kevinten-ai/mcp-social-publisher/blob/1c0059ea295ed16ee48c81f8f5bf5bd1e199d27a/src/social_publisher/platforms/xiaohongshu.py#L44)、[微博实现](https://github.com/kevinten-ai/mcp-social-publisher/blob/1c0059ea295ed16ee48c81f8f5bf5bd1e199d27a/src/social_publisher/platforms/weibo.py#L48)、[B站实现](https://github.com/kevinten-ai/mcp-social-publisher/blob/1c0059ea295ed16ee48c81f8f5bf5bd1e199d27a/src/social_publisher/platforms/bilibili.py#L56)。

**对发条的建议（调研时的设计判断）**

后续已按本节路线完成四个平台连接器与控制台登录交互，实际验收范围和限制见 [平台接入说明](PLATFORMS.md)。下表保留调研时的建议，不代表所有平台均已完成真实账号发布验收。

| 平台 | 建议路线 | 需要独立验收的重点 |
| --- | --- | --- |
| 微博 | 保留当前专用浏览器和本地 profile，先完成自己的账号真实图文验收 | 上传图片、账号核对、真实帖子 ID；再验证能否改为控制台二维码和后台运行 |
| 小红书 | 参考 xiaohongshu-mcp 的二维码流程及图文编辑器 | 二维码有效期、登录失效、图片上传、笔记回执 |
| 抖音图文 | 参考 social-auto-upload 的创作中心图文流程 | 真正的图文入口、图片/标题/话题、发布回执 |
| B站动态 | 单独验证官网动态编辑器并实现适配器 | 纯文字与带图动态；不复用视频投稿或专栏草稿连接器 |

短期建议继续使用本地服务，按平台和账号隔离会话，把“需要用户登录”和“执行发布”分开。小红书已有控制台显示二维码的源码依据，微博是否适合相同交互仍需实际验证，不能直接假定成立。遇到必须在官网完成的验证时，保留打开专用窗口的入口。

如果产品明确要做桌面客户端，可参考 Electron 内嵌平台登录视图；这会增加桌面打包和升级维护。若优先复用日常浏览器已有登录态，可评估扩展，但它同样需要针对原生微博和动态编写连接器。

发布状态统一区分草稿、待执行、提交中、平台处理中、已确认成功、失败和结果待核实。继续保留发条现有的提交前落盘、相同请求去重和不确定结果阻止重发；页面跳转只作为辅助证据。多平台界面可以统一，平台支持的内容类型和登录方式应明确展示。
