# dsh-notify

[English](README.md) | **中文**

**DeepSeek Harness 的跨设备通知插件。** 执行长任务期间无需值守：任务结束、等待审批或等待回答时，通过已启用的渠道发出提醒——桌面通知、浏览器标签页、手机 ntfy 推送、飞书机器人消息，任选组合。

- 设置 → **通知**：勾渠道、填凭据、点**发测试**
- 四个渠道：系统通知中心（macOS / Windows / Linux）、你自己的浏览器标签页、ntfy、飞书机器人
- 只在你走开时才通知：每条通知默认先等 60 秒，这期间你回过话、批过、答过就跳过这条
- 凭据存在宿主的凭据服务里，不进配置文件

![插件图标](icon.svg)

## 截图

![通知渠道、触发时机与通知内容](screenshot-wide.png)

## 渠道

| 渠道 | 投递方式 | 凭据 |
|---|---|---|
| `local` | macOS 通知中心、Windows 系统通知、Linux `notify-send` | 无 |
| `browser` | 由开着的 GUI 标签页弹出系统通知 | 浏览器通知权限 |
| `ntfy` | ntfy 发布接口 | topic + 可选访问令牌 |
| `feishu` | 飞书 / Lark 自定义机器人 webhook | webhook 前缀 + token，可选签名密钥 |

## 安装

### 1. 走宿主的 `installBundle`（装上并启用）

在对话里让 agent 装：

> 安装插件 `github:miiy/dsh-notify`

或者把同一个 spec 贴进 **设置 → 插件** 页的安装框。

两条路都走宿主的 `installBundle`：装包、写进 `dsh.profile.bundles`、热生效，一步到位。

### 2. 命令行（`dsh plugin`，只安装）

```sh
dsh plugin --profile <profile> add github:miiy/dsh-notify
```

`dsh plugin` 把参数转给 profile 目录里的 pnpm，所以这一步只装包、**不**组装。装完在
**设置 → 插件** 页会看到这一行是已安装、开关**关着**的状态；把它打开才会加进
`dsh.profile.bundles`。开关没即时生效就重启一次 `dsh web`。

纯 JavaScript 的包没有构建脚本，从 git 安装不需要 `allowBuilds` 审批。

可接受的 spec 形式：`github:user/repo`、`git+https://…`、仓库的完整 URL、绝对本地路径，
或者 npm 包名。

### 3. 从本地目录挂载（开发用）

见 [MAINTENANCE.md](MAINTENANCE.md) 的 *Run from a checkout*。

## 配置

打开 **设置 → 通知**。

| 字段 | 含义 |
|---|---|
| 渠道 | 桌面通知 / 浏览器通知 / ntfy 推送 / 飞书机器人，任意组合。勾了但凭据没填时，保存会被拒绝 |
| 飞书机器人 | 前缀 `https://open.feishu.cn/open-apis/bot/v2/hook/` 已预填、可以改；只填前缀之后那段 token |
| 浏览器权限 | 点一次**允许通知**；页面会显示当前状态 |
| 回合完成 | 勾 `完成` / `出错` / `超限`；`aborted`（你自己停的）不提供 |
| 等你审批 | 工具调用要你拍板时提醒 |
| 等你回答 | 模型向你提问时提醒 |
| 最短回合时长 | 秒；`0` 表示每轮都提醒 |
| 通知内容 | 每种事件一个模板，已填好默认文案；第一行是标题，其余是正文，**恢复默认**把默认文案放回去 |
| 发测试 | 立刻用这条渠道发一条真消息，读的是**已保存**的值 |

占位符：回合结束用 `{title}` `{outcome}` `{project}` `{duration}` `{preview}` `{error}`，
等待审批用 `{title}` `{project}` `{tool}` `{reason}`，等待回答用 `{title}` `{project}`
`{question}` `{count}`。不认识的占位符原样留在文案里。

配置存在 `~/.dsh/dsh-notify/config.json`（权限 0600）。凭据走宿主的凭据服务，设置页只能
知道某个键有没有配，拿不到值。

## 测试

```sh
node --check index.js && node --check client.js
node tests/harness.mjs   # 宿主半边
node tests/client.mjs    # 设置页
```

## 文件结构

```
index.js          宿主半边：会话事件与提问瀑布进，通知出
client.js         客户端半边：设置页 + 浏览器渠道
browser.js        浏览器渠道：每个页面一条 SSE
config.js         配置文件读写、校验、凭据键名、运行中的设置
rpc.js            设置页的 POST 路由与信封
channels.js       local / ntfy / feishu 三个发信函数
cordis.patch.yml  bundle patch：挂一行宿主入口
locale/           插件卡片的中英文标题和描述
tests/            两边的离线自检
MAINTENANCE.md    依赖了上游哪些东西，升级后查什么
```

## 许可

MIT
