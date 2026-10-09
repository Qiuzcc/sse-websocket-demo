# 协议实验室 · WebSocket / SSE / HTTP 学习 Demo

一个面向前端工程师的协议教学项目：**同一个"模拟 AI 逐 token 流式回答"场景，用四种传输方式各跑一遍**，每种方式都配一条实时的「协议事件时间线」，把连接生命周期、消息到达、心跳、断线重连这些看不见的机制全部摊开。

## 配套文章

- [**WebSocket**](https://www.yuque.com/yuqueyonghucia7xz/ewvtgw/xpfim60b1mupuf8b)
- [**SSE 服务器发送事件技术**](https://www.yuque.com/yuqueyonghucia7xz/ewvtgw/chf42sayuficuwhp)



## 运行

```bash
npm install
npm start          # 启动后访问 http://localhost:3000
```

零构建工具：后端只有 `express` + `ws` 两个依赖，前端是原生 ES Module，直接逐文件阅读源码即可。

## 五个视图怎么用

| Tab | 内容 | 建议观察点 |
|---|---|---|
| ① 普通 HTTP | 请求-响应，服务端攒完全部 token 才返回 | 时间线上"发出请求"与"收到响应"之间长达十几秒的真空 —— 这就是流式存在的理由 |
| ② HTTP 轮询 | 创建任务后客户端每 800ms 拉一次增量 | 灰色条目=空轮询、青色条目=命中增量；数一数无效请求占比 |
| ③ SSE | 双实现切换：`EventSource` / `fetch + ReadableStream` | 点「服务端掐断连接」：模式 A 演出「onerror → 1.5s 自动重连 → 带 Last-Event-ID 续传」全套；模式 B 手动解析能看到原始 chunk 与 SSE 报文帧 |
| ④ WebSocket | 手写 `ResilientSocket`：状态机 + 应用层心跳 + 指数退避重连 + 发送队列 | 先「建立连接」再「发送」；点「服务端踢线」「模拟断线」观察 `readyState 0→1→2→3` 变迁与 1s→2s→4s 退避重连 |
| ⑤ 并排对比 | 同一个 Prompt 同时走 SSE 与 WS | 左右时间线对照：事件格式、心跳方式、断线恢复的异同 |

服务端终端也会打日志（WS upgrade 握手请求头、SSE 首包与续传游标、协议级 Ping/Pong），是事件级之外的轻量补充。

## 协议对比速查表

| 维度 | 普通 HTTP | HTTP 轮询 | SSE | WebSocket |
|---|---|---|---|---|
| 方向 | 请求→响应（单向） | 客户端反复拉（单向） | 服务端→客户端 单向推送 | 全双工双向 |
| 传输内容 | 一次完整响应 | 每次一个增量片段 | `text/event-stream` 事件（`data:/id:/event:/retry:` 文本协议） | 任意帧（文本/二进制，本项目用 JSON 消息） |
| 建立方式 | 每次请求一个请求-响应周期 | 同左 | 就是一个普通 HTTP GET | 先 HTTP `Upgrade: websocket` 握手，响应 `101 Switching Protocols`，之后脱离 HTTP |
| 服务端能主动推吗 | 否 | 否（只能等客户端来问） | 能（在同一条响应流里随时 write） | 能（任意时刻 send） |
| 心跳 | 无此概念 | 轮询本身即"心跳" | 服务端发事件/注释行；注释行 JS 不可见 | 协议层有 ping/pong 帧，但**浏览器 JS 摸不到**，必须应用层自己做（本项目 `{type:'ping'}`） |
| 断线恢复 | 无需（本就是一锤子） | 天然容错（下一轮再问） | **EventSource 自动重连** + 自动携带 `Last-Event-ID`，服务端可实现续传 | 无内置重连，客户端必须自己写（本项目：指数退避 1s→2s→4s→8s→封顶 15s） |
| 能否 POST / 带请求头 | 能 | 能 | EventSource 不能（只能 GET、无自定义头）；**fetch + ReadableStream 方案可以** | 握手 URL 可带 query，但浏览器不能自定义握手头（鉴权常放 query 或首条消息） |
| 连接数特征 | 用完即走 | 高频短连接 | 1 条长连接（HTTP/1.1 下每个域名浏览器并发 6 条，SSE 会占坑；HTTP/2 无此问题） | 1 条长连接，同域可多路复用 |
| 典型场景 | 表单、SSR 首屏 | 低实时性要求（进度条） | **AI 流式输出（OpenAI/Anthropic 均用 SSE）**、通知、行情订阅 | 协同编辑、聊天、游戏、需要上行高频交互的场景 |

### 为什么真实 AI 应用多用「fetch 流式读取」而不是 EventSource？

大模型接口的请求是 **POST + JSON body + Authorization 头**，而 `EventSource` 只能 GET、不能带头——所以 OpenAI 官方 SDK 的浏览器端用 `fetch` 拿到 `response.body` 的 `ReadableStream`，手动按 `\n\n` 切分 SSE 帧（见本项目的 SSE 模式 B）。代价是失去了浏览器托管的自动重连与 `Last-Event-ID` 续传，需要自己实现。

### 长轮询（long polling）与短轮询的差异（本项目只实现了短轮询）

短轮询：客户端每隔固定时间问一次，绝大多数请求为空响应（②号 Tab 中的灰色条目）。
长轮询：客户端发起请求后**服务端挂住不返回**，直到有数据或超时才响应，客户端收到即再发起下一次。实时性更好、空响应更少，但每次仍是"一问一答"，服务端要维护挂起的连接。它是 SSE 出现前的主流折中，理解到这一层即可。

## 每个面板对应的学习要点

**① 普通 HTTP**：请求-响应模型中服务端无法主动开口；流式生成必须"全攒完再返回"，首字延迟（TTFT）= 全部耗时。

**② HTTP 轮询**：轮询间隔是延迟与开销的直接折中；看时间线数空轮询的比例；轮询天然"客户端不知道服务端什么时候有东西"。

**③ SSE**
- SSE 报文就是带规则的纯文本行：`data:`、`event:`、`id:`、`retry:`、`:` 注释，空行分帧（模式 B 有逐 chunk 的原始展示）。
- `EventSource` 帮你托管了：断线自动重连、重连自动带 `Last-Event-ID`、去重事件 id。本项目的服务端按 `prompt+sid` 缓存生成进度，续传时**不重放、不丢字**，时间线会明确标出"从断点继续"。
- 收到 `done` 业务事件后必须手动 `close()`，否则服务端正常结束流也会被浏览器当作异常断线而重连——经典坑。

**④ WebSocket**
- 握手是一个 HTTP 请求（`Upgrade: websocket` → `101`），终端日志里能看到原始握手头；之后这条 TCP 连接就不再是 HTTP 了。
- 状态机 `CONNECTING(0) → OPEN(1) → CLOSING(2) → CLOSED(3)`，徽标与时间线全程跟踪。
- 浏览器 JS **访问不到协议层 ping/pong 帧**（服务端确实也发了，见终端日志），所以断线检测、保活必须应用层心跳：本项目每 5s 发 `{type:'ping'}`，两个周期没等到 pong 判连接"假活"，主动 close 触发重连。
- 重连必须指数退避（1s→2s→4s→8s→封顶），否则服务恢复瞬间会被所有客户端的"重连风暴"打死。
- 断线期间发的消息要进队列，`onopen` 后补发（对比视图首帧演示了这个竞态）。
- close code 语义：`1000` 正常、`1006` 异常断开（无 close 帧）、`4000-4999` 应用自定义（本项目 `4000`=服务端踢线、`4001`=心跳超时、`4002`=模拟断线）。

**⑤ 并排对比**：同一内容两条路 —— SSE 的"每 token 一个事件、断线自动续传" vs WS 的"一条常驻双向通道、重连自己写"。做 AI 应用时：只需要流式下行 → SSE 更简单；需要上下行高频交互 → WebSocket。

## 项目结构

```
server/
  index.js       四种传输方式的端点 + 管理接口（掐流/踢线）+ 终端日志
  mock-llm.js    确定性 token 流生成器（同 prompt 内容可复现，SSE 续传的前提）
client/
  index.html     单页骨架
  css/styles.css 暗色调试台样式
  js/
    app.js          Tab 路由 + 并排对比视图
    event-log.js    事件时间线组件（类型着色 / 相对耗时 / 行数封顶）
    panel-kit.js    面板布局与聊天气泡助手
    panels/http.js      ① 一次性 HTTP
    panels/polling.js   ② 短轮询
    panels/sse.js       ③ SSE 双实现
    panels/ws.js        ④ ResilientSocket + 面板
```

## 推荐学习路径

1. 按 ① → ② → ③ → ④ 顺序各发一次消息，只看时间线，建立"同一件事四种做法"的体感。
2. 在 ③ 里点「服务端掐断连接」，逐条读 onerror → 自动重连 → 续传的完整演出；再切模式 B 对比 fetch 手动解析的原始报文。
3. 在 ④ 里依次点「服务端踢线」「模拟断线」「主动关闭(不重连)」，辨析三种断开在 `onclose code/wasClean`、重连行为上的差异。
4. 打开终端日志，对照浏览器时间线，理解"JS 层看得见 / 看不见"的两层心跳。
5. 最后读一遍 `panels/ws.js` 的 `ResilientSocket`——把它抽出来略加改造，就是一个可用于生产的最小 WS 客户端。
