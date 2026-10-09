/**
 * mock-llm.js —— 模拟 LLM 的流式生成器
 *
 * 关键设计：token 序列与延迟是「确定性的」（只由 prompt 决定），
 * 这样 SSE 断线重连时，服务端可以按 Last-Event-ID 从断点续传，
 * 客户端能观察到"接着上次继续"的效果。
 */

/** 根据 prompt 生成一条"AI 回复"全文 */
function buildReplyText(prompt) {
  return [
    `你好，我收到了你的问题："${prompt}"。`,
    `这是一个模拟的流式回复，它的内容并不重要，重要的是它到达你面前所走过的路。`,
    `在真实的 AI 应用中，大模型是逐 token 生成的：先吐一个字，再吐一个字。`,
    `服务端要做的，就是把这些碎片一边生成、一边推送给你，而不是等全部生成完再一次性返回。`,
    `接下来有一段约三秒的长停顿，模拟模型"深度思考"时的空白期，`,
    `这时候连接上没有业务数据，协议层的心跳机制就该登场了。`,
    `心跳之后欢迎回来。你会发现，无论是 WebSocket 还是 SSE，`,
    `它们解决的其实是同一个问题：让服务端可以在任意时刻主动开口说话。`,
    `而 HTTP 请求-响应模型里，服务端永远只能"被问了才答"。`,
    `这条消息发完，本次流式生成就结束了。去右侧的事件时间线里看看吧。`,
  ].join('');
}

/**
 * 把全文切成 token 并附上逐 token 延迟（确定性）。
 * 返回 [{ text, delay }]，delay 是"产出这个 token 之前"等待的毫秒数。
 */
export function buildTokens(prompt) {
  const text = buildReplyText(prompt);
  // 按 1~2 个字符切块，模拟 BPE token 的粒度
  const chunks = text.match(/.{1,2}/gs) || [];
  const tokens = [];
  // 固定的"深度思考"长停顿位置：全文 46% 处
  const pauseIndex = Math.floor(chunks.length * 0.46);

  chunks.forEach((piece, i) => {
    let delay;
    if (i === 0) {
      delay = 400; // 首 token 延迟（TTFT）
    } else if (i === pauseIndex) {
      delay = 3000; // 长停顿，用于演示心跳
    } else {
      delay = 40 + (i % 5) * 25; // 40~140ms 规律波动
    }
    tokens.push({ text: piece, delay });
  });
  return tokens;
}

/** 全文生成总耗时（毫秒），用于 HTTP 一次性接口的模拟等待 */
export function totalDuration(prompt) {
  return buildTokens(prompt).reduce((sum, t) => sum + t.delay, 0);
}

/**
 * 启动一个逐 token 的流式产出。
 * @param {string} prompt
 * @param {object} handlers { onToken(text, index), onDone() }
 * @param {number} startIndex 从第几个 token 开始（SSE 续传用）
 * @returns {{ cancel: () => void }} 控制器
 */
export function createStream(prompt, handlers, startIndex = 0) {
  const tokens = buildTokens(prompt);
  let cancelled = false;
  let timer = null;
  let i = startIndex;

  function step() {
    if (cancelled) return;
    if (i >= tokens.length) {
      handlers.onDone();
      return;
    }
    const t = tokens[i];
    timer = setTimeout(() => {
      if (cancelled) return;
      handlers.onToken(t.text, i);
      i += 1;
      step();
    }, t.delay);
  }
  step();

  return {
    cancel() {
      cancelled = true;
      if (timer) clearTimeout(timer);
    },
  };
}

/**
 * 创建一个「生成任务」：服务端在后台独立地逐 token 生成，
 * 生成结果缓存在 task.parts 里。多个 SSE 连接可以从同一任务的
 * 任意进度（startIndex）开始读取，实现真正的断点续传。
 *
 * @returns {object} task { parts: string[], done: boolean, finishedAt, stream }
 */
export function createGeneration(prompt, startIndex = 0) {
  const task = { parts: [], done: false, finishedAt: null, stream: null };
  task.stream = createStream(
    prompt,
    {
      onToken(text) {
        task.parts.push(text);
      },
      onDone() {
        task.done = true;
        task.finishedAt = Date.now();
      },
    },
    startIndex,
  );
  // 代理取消：调用方持有 task 即可 cancel，不必了解内部 stream 控制器结构
  task.cancel = () => task.stream.cancel();
  return task;
}
