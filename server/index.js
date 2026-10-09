/**
 * server/index.js —— 协议实验室服务端
 *
 * 同一个"模拟 LLM 逐 token 回复"场景，提供四种传输方式：
 *   1. POST /api/chat           普通 HTTP（攒完全部再返回，对比基线）
 *   2. POST /api/chat/jobs      HTTP 轮询（创建任务）
 *      GET  /api/chat/jobs/:id  HTTP 轮询（拉取增量）
 *   3. GET  /api/chat/stream    SSE（EventSource 用，支持 Last-Event-ID 续传）
 *      POST /api/chat/stream-fetch SSE（fetch + ReadableStream 用，演示 POST 能力）
 *   4. ws://.../chat            WebSocket（noServer 模式，手动处理 upgrade）
 * 管理接口（配合前端演示断线）：
 *   POST /api/admin/sse-interrupt  强制掐断所有活跃 SSE 流
 *   POST /api/admin/ws-kick        强制断开所有 WebSocket 连接
 */
import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { createGeneration, totalDuration } from "./mock-llm.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "client")));

const server = createServer(app);

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

const now = () => new Date().toISOString().slice(11, 23); // HH:mm:ss.SSS
const log = (...args) => console.log(`[${now()}]`, ...args);

/** 用 prompt 的哈希作为 SSE 生成任务的 key（同 prompt 重连可续传） */
const promptKey = (prompt) =>
  crypto.createHash("sha1").update(String(prompt)).digest("hex").slice(0, 12);

/* ------------------------------------------------------------------ */
/* 1. 普通 HTTP：攒完全部 token 再一次性返回                            */
/* ------------------------------------------------------------------ */

app.post("/api/chat", (req, res) => {
  const prompt = String(req.body?.prompt || "").trim() || "你好";
  const wait = totalDuration(prompt);
  log(`[http] POST /api/chat prompt="${prompt}" 将阻塞 ${wait}ms 后一次性返回`);
  const task = createGeneration(prompt);
  const timer = setInterval(() => {
    if (task.done) {
      clearInterval(timer);
      res.json({
        reply: task.parts.join(""),
        mode: "buffered",
        serverWaitMs: wait,
      });
    }
  }, 50);
});

/* ------------------------------------------------------------------ */
/* 2. HTTP 轮询：创建任务 + 按游标拉增量                                */
/* ------------------------------------------------------------------ */

const jobs = new Map(); // jobId -> task

app.post("/api/chat/jobs", (req, res) => {
  const prompt = String(req.body?.prompt || "").trim() || "你好";
  const jobId = crypto.randomUUID();
  const task = createGeneration(prompt);
  task.createdAt = Date.now();
  jobs.set(jobId, task);
  log(`[poll] 创建任务 ${jobId} prompt="${prompt}"`);
  res.json({ jobId, cursor: 0 });
});

app.get("/api/chat/jobs/:id", (req, res) => {
  const task = jobs.get(req.params.id);
  if (!task) return res.status(404).json({ error: "job not found" });
  const cursor = Math.max(0, parseInt(req.query.cursor, 10) || 0);
  const delta = task.parts.slice(cursor).join("");
  res.json({
    delta, // 本次新增内容（可能为空字符串 = 空轮询）
    cursor: task.parts.length, // 下次拉取用的游标
    done: task.done,
  });
});

// 简单回收：完成 5 分钟的 job 删除
setInterval(() => {
  const deadline = Date.now() - 5 * 60_000;
  for (const [id, t] of jobs) {
    if (t.done && t.finishedAt < deadline) jobs.delete(id);
  }
}, 60_000).unref();

/* ------------------------------------------------------------------ */
/* 3. SSE                                                             */
/* ------------------------------------------------------------------ */

// promptKey -> { task, refs:Set<res> }；供重连续传与"服务端掐断"演示
const sseGenerations = new Map();
const activeSseResponses = new Set();

function sseHead(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // 关闭代理缓冲（Nginx 场景的知识点）
  });
  // 告诉浏览器：断线重连前等 1.5 秒（默认约 3 秒，缩短便于观察）
  res.write("retry: 1500\n\n");
}

function handleSse(req, res, prompt, sid) {
  // 用 prompt+sid 作为任务 key：前端每轮新发送换新 sid（避免命中旧缓存秒回放），
  // 而 EventSource 断线重连访问的是同一 URL（sid 不变），因此仍能命中任务续传。
  const key = promptKey(`${prompt}|${sid || ""}`);
  let entry = sseGenerations.get(key);
  if (!entry) {
    entry = { task: createGeneration(prompt), refs: new Set() };
    sseGenerations.set(key, entry);
    log(`[sse] 新建生成任务 key=${key} prompt="${prompt}"`);
  } else {
    log(`[sse] 命中已有任务 key=${key}（重连续传场景）`);
  }
  const { task } = entry;

  // 续传起点：浏览器自动重连时会带上 Last-Event-ID（即上一个事件 id = token 下标）
  const lastEventId = parseInt(req.headers["last-event-id"], 10);
  let cursor =
    Number.isInteger(lastEventId) && lastEventId >= 0 ? lastEventId + 1 : 0;

  sseHead(res);
  entry.refs.add(res);
  activeSseResponses.add(res);
  log(
    `[sse] 连接建立 key=${key} 起始游标=${cursor}（Last-Event-ID: ${req.headers["last-event-id"] || "无"}）`,
  );

  let lastWrite = Date.now();
  const write = (str) => {
    res.write(str);
    lastWrite = Date.now();
  };

  // 轮询任务进度：有新 token 就推，空闲超过 1.2s 发心跳注释
  const timer = setInterval(() => {
    if (res.writableEnded) return;
    if (task.parts.length > cursor) {
      while (task.parts.length > cursor) {
        const text = task.parts[cursor];
        write(`id: ${cursor}\ndata: ${JSON.stringify({ token: text })}\n\n`);
        cursor += 1;
      }
    } else if (Date.now() - lastWrite > 1200) {
      // 心跳：用命名事件 event: ping 而非注释行 ": ping"，
      // 因为注释行在浏览器 EventSource API 层不可见，无法用于教学展示。
      write(`event: ping\ndata: {"at":${Date.now()}}\n\n`);
    }
    if (task.done && cursor >= task.parts.length) {
      write(
        `event: done\ndata: ${JSON.stringify({ totalTokens: task.parts.length })}\n\n`,
      );
      cleanup();
      res.end();
      log(`[sse] 正常结束 key=${key} 共 ${task.parts.length} 个 token`);
    }
  }, 60);

  function cleanup() {
    clearInterval(timer);
    entry.refs.delete(res);
    activeSseResponses.delete(res);
    if (
      entry.refs.size === 0 &&
      task.done &&
      Date.now() - (task.finishedAt || 0) > 30_000
    ) {
      sseGenerations.delete(key); // 无人订阅且已完结，回收
    }
  }
  // 断线检测必须挂在 res 上，不能挂 req（真实踩坑点）：
  // Node 16+ 中，POST 的请求体一旦被 express.json() 读完，req（请求流）会立刻触发一次
  // 'close' —— 它表示"请求读完了"，与连接是否断开无关。若监听 req.on('close')，
  // fetch 模式的 POST 会在连接刚建立时就误执行 cleanup()、清掉推送定时器，
  // 客户端便永远收不到 token（EventSource 走 GET 无 body，所以不会暴露这个问题）。
  // res 的 'close' 只在两种时刻触发：响应正常结束，或底层连接被提前掐断，语义正确。
  res.on("close", () => {
    cleanup();
    if (!res.writableEnded) {
      log(
        `[sse] 客户端断开 key=${key} 游标停在 ${cursor}（等待可能的重连续传）`,
      );
    }
  });
}

app.get("/api/chat/stream", (req, res) => {
  const prompt = String(req.query.prompt || "").trim() || "你好";
  handleSse(req, res, prompt, String(req.query.sid || ""));
});

// 与 GET 版本行为一致，只是参数来自 POST body —— 演示"EventSource 做不到 POST，fetch 可以"
app.post("/api/chat/stream-fetch", (req, res) => {
  const prompt = String(req.body?.prompt || "").trim() || "你好";
  handleSse(req, res, prompt, String(req.body?.sid || ""));
});

app.post("/api/admin/sse-interrupt", (req, res) => {
  let n = 0;
  for (const sseRes of activeSseResponses) {
    if (!sseRes.writableEnded) {
      sseRes.write(": server-interrupting-now\n\n");
      sseRes.end(); // 不发 done 就掐断 → EventSource 会当作异常断线自动重连
      n += 1;
    }
  }
  log(`[admin] 掐断了 ${n} 条 SSE 连接`);
  res.json({ interrupted: n });
});

/* ------------------------------------------------------------------ */
/* 4. WebSocket（noServer 模式，手动处理 upgrade 握手，方便打日志）      */
/* ------------------------------------------------------------------ */

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const { pathname } = new URL(req.url, "http://localhost");
  if (pathname !== "/chat") {
    log(`[ws] 拒绝 upgrade：未知路径 ${pathname}`);
    socket.destroy();
    return;
  }
  // 这里能打印出浏览器发起握手时的关键请求头（事件级之外的轻量补充）
  log(
    `[ws] 收到 upgrade 握手 GET ${pathname}\n` +
      `      Upgrade: ${req.headers.upgrade} | Connection: ${req.headers.connection}\n` +
      `      Sec-WebSocket-Key: ${req.headers["sec-websocket-key"]}\n` +
      `      Sec-WebSocket-Version: ${req.headers["sec-websocket-version"]}`,
  );
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

let wsClientSeq = 0;
wss.on("connection", (ws, req) => {
  const clientId = `ws-${++wsClientSeq}`;
  log(`[ws] ${clientId} 连接建立（握手完成，101 Switching Protocols）`);

  // 协议级 Ping：每 15s 发一次（浏览器 JS 看不到它，但能维持连接并由库自动回 Pong）
  const pingTimer = setInterval(() => {
    if (ws.readyState === ws.OPEN) {
      ws.ping();
      log(`[ws] ${clientId} 服务端发出协议级 Ping（浏览器 JS 层不可见）`);
    }
  }, 15_000);
  ws.on("pong", () => log(`[ws] ${clientId} 收到浏览器对本端 Ping 的 Pong`));

  ws.isAlive = true;
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === "ping") {
      // 应用层心跳：客户端 JS 能感知的那种（浏览器 API 拿不到协议级 ping/pong）
      ws.send(
        JSON.stringify({
          type: "pong",
          serverTime: Date.now(),
          echoAt: msg.echoAt,
        }),
      );
      return;
    }

    if (msg.type === "chat") {
      const prompt = String(msg.prompt || "").trim() || "你好";
      if (ws.currentStream) ws.currentStream.cancel();
      log(
        `[ws] ${clientId} 收到 chat 请求 prompt="${prompt}"，开始逐 token 推送`,
      );
      let count = 0;
      ws.currentStream = createGeneration(prompt);
      const task = ws.currentStream;
      task.delivered = 0;
      const t = setInterval(() => {
        if (ws.readyState !== ws.OPEN) {
          clearInterval(t);
          return;
        }
        // WebSocket 没有游标续传概念，直接把 parts 差量推完即可
        while (task.delivered < task.parts.length) {
          ws.send(
            JSON.stringify({ type: "token", text: task.parts[task.delivered] }),
          );
          task.delivered += 1;
          count += 1;
        }
        if (task.done && task.delivered >= task.parts.length) {
          clearInterval(t);
          ws.send(JSON.stringify({ type: "done", totalTokens: count }));
          log(`[ws] ${clientId} 回复推送完毕（${count} tokens）`);
        }
      }, 50);
    }
  });

  ws.on("close", (code, reason) => {
    clearInterval(pingTimer);
    if (ws.currentStream) ws.currentStream.cancel();
    log(`[ws] ${clientId} 连接关闭 code=${code} reason="${reason || ""}"`);
  });
});

app.post("/api/admin/ws-kick", (req, res) => {
  let n = 0;
  for (const client of wss.clients) {
    client.close(4000, "server kick"); // 4000-4999 是保留给应用的自定义关闭码
    n += 1;
  }
  log(`[admin] 踢掉了 ${n} 个 WebSocket 连接`);
  res.json({ kicked: n });
});

/* ------------------------------------------------------------------ */

server.listen(PORT, () => {
  log(`协议实验室已启动： http://localhost:${PORT}`);
});
