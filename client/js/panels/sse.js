/**
 * panels/sse.js —— SSE 面板（双实现）
 *
 * 模式 A：EventSource（浏览器原生）
 *   - 自动重连 + 自动携带 Last-Event-ID 续传（服务端已实现按游标续传）
 *   - 只能 GET、不能带自定义请求头 —— 真实 AI 应用的痛点
 * 模式 B：fetch + ReadableStream（手动解析 SSE 报文）
 *   - 可以 POST、可以带头（OpenAI 官方 SDK 浏览器端就是这么做的）
 *   - 没有自动重连，断开要靠手写；但能拿到原始字节，可展示给学习者
 */
import { h, buildPanel, addUserMsg, startAssistantMsg, registerPanel } from '../panel-kit.js';

const READY = ['CONNECTING', 'OPEN', 'CLOSED'];

export function createSsePanel(root) {
  let mode = 'es'; // 'es' | 'fetch'

  const sendBtn = h('button', { class: 'btn btn-primary' }, '发送');
  const closeEsBtn = h('button', { class: 'btn' }, 'es.close()');
  const abortBtn = h('button', { class: 'btn', style: 'display:none' }, 'AbortController 中止');
  const kickBtn = h('button', { class: 'btn btn-danger', title: '让服务端把所有活跃 SSE 流直接掐断' }, '服务端掐断连接');
  const { chat, log, input, badge } = buildPanel(root, {
    title: '③ SSE · Server-Sent Events',
    hint: '一条单向的、自动重连的 HTTP 长连接',
    extraButtons: [sendBtn, closeEsBtn, abortBtn, kickBtn],
  });

  // 模式切换子 Tab
  const tabEs = h('button', { class: 'subtab active', onclick: () => setMode('es') }, '模式A：EventSource（自动重连）');
  const tabFetch = h('button', { class: 'subtab', onclick: () => setMode('fetch') }, '模式B：fetch + ReadableStream（手动解析）');
  const note = h('div', { class: 'subtab-note' }, '原生 API：浏览器替你管理连接与重连，你只能看到事件。');
  root.querySelector('.controls').before(h('div', { class: 'subtabs' }, [tabEs, tabFetch]), note);

  function setMode(m) {
    mode = m;
    tabEs.classList.toggle('active', m === 'es');
    tabFetch.classList.toggle('active', m === 'es' ? false : true);
    note.textContent = m === 'es'
      ? '原生 API：浏览器替你管理连接与重连，你只能看到事件。'
      : '手动 API：fetch POST + getReader() 逐块读取，自己按空行切分 SSE 报文（真实 AI 应用普遍采用此方案）。';
    closeEsBtn.style.display = m === 'es' ? '' : 'none';
    abortBtn.style.display = m === 'fetch' ? '' : 'none';
    stopAll();
  }

  function setBadge(state) {
    badge.style.display = '';
    badge.textContent = state;
    badge.className = `state-badge ${state === 'OPEN' ? 's-open' : state === 'CLOSED' ? 's-closed' : 's-connecting'}`;
  }

  /* ---------------- 共用：一次"回复"的渲染上下文 ---------------- */
  function beginReply(prompt) {
    addUserMsg(chat, prompt);
    log.markStart();
    setBadge('CONNECTING');
    return startAssistantMsg(chat);
  }

  // 每轮新发送换一个 sid：避免服务端命中上一轮任务的缓存造成"秒回放"；
  // 而 EventSource 重连用的是同一个 URL，sid 不变，续传机制不受影响。
  const newSid = () => Math.random().toString(36).slice(2, 8);

  /* ---------------- 模式 A：EventSource ---------------- */
  let es = null;
  let esRound = 0; // 第几轮（含自动重连）
  
  function startEventSource(prompt) {
    if (es) es.close();
    const updater = beginReply(prompt);
    esRound = 0;
    let tokenCount = 0;
  
    // 只创建一个 EventSource：断线后的重连由浏览器自动完成（同一个对象上反复触发 open）
    const sid = newSid();
    esRound += 1;
    log.log('lifecycle', `new EventSource（第 ${esRound} 轮）`, `GET /api/chat/stream?prompt=…&sid=${sid} —— 握手即一个普通 HTTP 请求`);
    es = new EventSource(`/api/chat/stream?prompt=${encodeURIComponent(prompt)}&sid=${sid}`);
  
    es.onopen = () => {
      setBadge('OPEN');
      log.log('lifecycle', 'onopen', esRound > 1
        ? `重连成功！浏览器自动携带了 Last-Event-ID 请求头，服务端从断点继续推 —— 后续事件到达即证明续传`
        : `HTTP 响应头 Content-Type: text/event-stream，连接进入 OPEN`);
    };
  
    es.onmessage = (e) => {
      // 服务端 token 事件都带 id，浏览器自动记录并用于重连时的 Last-Event-ID
      tokenCount += 1;
      updater.append(JSON.parse(e.data).token);
      log.log('transport', 'onmessage', `data=${e.data} ｜ lastEventId=${e.lastEventId}`);
    };
  
    es.addEventListener('ping', () => {
      log.log('heartbeat', 'event: ping', '服务端空闲心跳（若使用注释行 ": ping" 则 JS 层不可见）');
    });
  
    es.addEventListener('done', (e) => {
      const { totalTokens } = JSON.parse(e.data);
      updater.finish(`流结束 · 共 ${totalTokens} 个 token`);
      log.log('lifecycle', 'event: done', `服务端正常收尾（共推送 ${totalTokens} 个 token）`);
      es.close(); // 必须手动 close：否则服务端 end() 后浏览器会当作异常断线去重连
      setBadge('CLOSED');
      log.log('info', 'es.close()', '收到 done 后主动关闭，避免不必要的自动重连');
    });
  
    es.onerror = () => {
      if (!es) return;
      if (es.readyState === EventSource.CONNECTING) {
        setBadge('CONNECTING');
        esRound += 1;
        log.log('error', 'onerror', '连接中断（可能是服务端掐流）—— readyState=CONNECTING');
        log.log('warn', '自动重连即将发生', `无需手写任何代码，浏览器将在约 1.5s（服务端 retry: 1500）后重连并附带 Last-Event-ID，等待下一次 onopen`);
      } else if (es.readyState === EventSource.CLOSED) {
        setBadge('CLOSED');
        log.log('error', 'onerror', 'readyState=CLOSED，浏览器已放弃重连（通常是 es.close() 或致命错误）');
      }
    };
  }

  /* ---------------- 模式 B：fetch + ReadableStream ---------------- */
  let abortCtrl = null;

  async function startFetchStream(prompt) {
    if (abortCtrl) abortCtrl.abort();
    abortCtrl = new AbortController();
    const signal = abortCtrl.signal;
    const updater = beginReply(prompt);
    const sid = newSid();
    let tokenCount = 0;

    log.log('lifecycle', 'fetch POST /api/chat/stream-fetch', '发起请求（可以 POST、可以带任意请求头 —— EventSource 做不到）');
    try {
      const resp = await fetch('/api/chat/stream-fetch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, sid }),
        signal,
      });
      setBadge('OPEN');
      log.log('lifecycle', '响应到达', `HTTP ${resp.status} ｜ Content-Type: ${resp.headers.get('content-type')}`);
      log.log('info', '开始读取 body', 'resp.body.getReader() —— 下面展示的是原始 chunk → 手动解析');

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        log.log('transport', `chunk 到达 (${value.length}B)`, JSON.stringify(chunk.length > 70 ? chunk.slice(0, 70) + '…' : chunk));
        buf += chunk;

        // SSE 报文以空行分隔 —— 这一步在 EventSource 里是浏览器帮你做的
        let sep;
        while ((sep = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          handleFrame(frame);
        }
      }
      setBadge('CLOSED');
      log.log('lifecycle', 'reader done', '服务端结束了流，读取循环自然退出 —— 若没收到 done 事件就走到这里，说明是异常断流，需要自己重连');
      updater.finish();

      function handleFrame(frame) {
        let event = 'message';
        const dataLines = [];
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
          else if (line.startsWith(':')) log.log('heartbeat', '注释行', JSON.stringify(line));
          else if (line.startsWith('retry:')) log.log('info', 'retry 字段', `浏览器重连间隔被设为 ${line.slice(6).trim()}（EventSource 专用，fetch 模式下无人使用它）`);
        }
        if (!dataLines.length && event === 'message') return;
        const data = dataLines.join('\n');

        if (event === 'message') {
          tokenCount += 1;
          updater.append(JSON.parse(data).token);
          log.log('transport', '解析出 token 事件', `data=${data}`);
        } else if (event === 'ping') {
          log.log('heartbeat', '解析出 ping 事件', '空闲心跳 —— 同样的解析代码，注释行/事件行一目了然');
        } else if (event === 'done') {
          setBadge('CLOSED');
          updater.finish(`流结束 · 共 ${tokenCount} 个 token`);
          log.log('lifecycle', '解析出 done 事件', `服务端正常收尾（共 ${tokenCount} 个 token）`);
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        setBadge('CLOSED');
        log.log('warn', 'fetch 被中止', 'AbortController.abort() —— 手动 API 的一切都要自己收场');
        updater.finish();
      } else {
        setBadge('CLOSED');
        log.log('error', '流读取失败', `${err} —— 且没有自动重连！这就是手写方案的代价`);
        updater.finish();
      }
    }
  }

  /* ---------------- 控制 ---------------- */
  function stopAll() {
    if (es) { es.close(); es = null; }
    if (abortCtrl) { abortCtrl.abort(); abortCtrl = null; }
    badge.style.display = 'none';
  }

  async function submit(prompt) {
    if (mode === 'es') startEventSource(prompt);
    else await startFetchStream(prompt);
  }

  sendBtn.addEventListener('click', () => submit(input.value.trim() || '你好'));
  input.addEventListener('keydown', (e) => e.key === 'Enter' && submit(input.value.trim() || '你好'));

  closeEsBtn.addEventListener('click', () => {
    if (es) {
      es.close();
      setBadge('CLOSED');
      log.log('warn', 'es.close()', '手动关闭 = 终态，浏览器不会再重连（与网络断线截然不同）');
    }
  });

  abortBtn.addEventListener('click', () => {
    if (abortCtrl) abortCtrl.abort();
  });

  kickBtn.addEventListener('click', async () => {
    const r = await fetch('/api/admin/sse-interrupt', { method: 'POST' });
    const { interrupted } = await r.json();
    log.log('error', 'POST /api/admin/sse-interrupt', `服务端掐断了 ${interrupted} 条活跃 SSE 流${mode === 'es' ? ' —— 坐等时间线演出「异常 → 自动重连 → 续传」全过程' : ' —— fetch 模式不会自动恢复，观察差异'}`);
  });

  return registerPanel({ log, submit, stop: stopAll });
}
