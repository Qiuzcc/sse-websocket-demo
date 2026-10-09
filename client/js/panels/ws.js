/**
 * panels/ws.js —— WebSocket 面板
 *
 * 核心是手写的 ResilientSocket 封装，把"生产级 WS 客户端"的三件必修课摊开：
 *   1. 状态机：CONNECTING(0) → OPEN(1) → CLOSING(2) → CLOSED(3)，每次变迁都上时间线
 *   2. 应用层心跳：浏览器 JS 拿不到协议层 ping/pong 帧，只能靠自己发 {type:'ping'}
 *      —— 超时没等到 pong 就判定连接"假活"，主动 close 触发的重连
 *   3. 指数退避重连：1s → 2s → 4s → 8s →（封顶 15s）
 * 外加一个真实应用必备的小机制：未连接时的发送队列（onopen 后自动补发）
 */
import { h, buildPanel, addUserMsg, startAssistantMsg, registerPanel } from '../panel-kit.js';

const STATE_NAMES = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'];
const STATE_CLASS = ['s-connecting', 's-open', 's-closing', 's-closed'];

/* ------------------------------------------------------------------ */
/* ResilientSocket：带心跳与指数退避重连的 WebSocket 封装                */
/* ------------------------------------------------------------------ */
class ResilientSocket {
  /**
   * @param {string} url
   * @param {object} handlers { onState(state), onMessage(obj), onLog(type,name,detail) }
   */
  constructor(url, handlers) {
    this.url = url;
    this.h = handlers;
    this.ws = null;
    this.closedByUser = false;
    this.retry = 0;              // 连续失败的重连计数（成功后清零）
    this.lastServerMsgAt = 0;    // 最近一次收到服务端任何消息的时刻
    this.awaitingPong = false;   // 是否有一个应用层 ping 在等回应
    this.timers = { heartbeat: null, reconnect: null };
    this.outbox = []; // 连接未就绪时的待发消息，onopen 后自动补发
    this.connect();
  }

  connect() {
    this.h.onLog('lifecycle', 'new WebSocket(this.url)', `GET /chat + Upgrade: websocket —— 想发起必须经过 HTTP 握手`);
    this.setState('CONNECTING');
    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      this.setState('OPEN');
      this.retry = 0;
      this.lastServerMsgAt = Date.now();
      this.h.onLog('lifecycle', 'onopen', '握手完成（HTTP 101 Switching Protocols），全双工通道就绪');
      if (this.outbox.length) {
        this.h.onLog('info', '补发队列', `连接就绪，补发 ${this.outbox.length} 条排队中的消息`);
        this.outbox.splice(0).forEach((m) => this.ws.send(JSON.stringify(m)));
      }
      this.startHeartbeat();
    };

    this.ws.onmessage = (e) => {
      this.lastServerMsgAt = Date.now();
      let obj;
      try { obj = JSON.parse(e.data); } catch { return; }
      if (obj.type === 'pong') {
        this.awaitingPong = false;
        const rtt = Date.now() - obj.echoAt;
        this.h.onLog('heartbeat', '收到 pong', `应用层心跳往返 RTT=${rtt}ms（协议层 ping/pong 帧浏览器 JS 根本看不到，所以必须自己发明一套）`);
        return;
      }
      this.h.onMessage(obj);
    };

    this.ws.onerror = () => {
      this.h.onLog('error', 'onerror', '连接层发生错误（紧随其后通常会触发 onclose）');
    };

    this.ws.onclose = (e) => {
      this.stopHeartbeat();
      this.setState('CLOSED');
      this.h.onLog('lifecycle', 'onclose', `code=${e.code} reason="${e.reason || '无'}" wasClean=${e.wasClean}`);
      if (!this.closedByUser) this.scheduleReconnect();
    };
  }

  setState(name) {
    this.h.onState(STATE_NAMES.indexOf(name));
  }

  /** 应用层心跳：每 5s 发一次 ping；连续 2 次（10s）无 pong 判死 */
  startHeartbeat() {
    this.stopHeartbeat();
    this.timers.heartbeat = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      if (this.awaitingPong && Date.now() - this.lastServerMsgAt > 11_000) {
        this.h.onLog('error', '心跳超时', '连发两个 ping 都没等到 pong —— 连接大概率"假活"，主动 close 触发重连');
        this.ws.close(4001, 'heartbeat timeout');
        return;
      }
      this.awaitingPong = true;
      this.ws.send(JSON.stringify({ type: 'ping', echoAt: Date.now() }));
      this.h.onLog('heartbeat', '发送 {type:"ping"}', '等待服务端回 pong（服务端同时还有 15s 一次的协议级 Ping，JS 层不可见）');
    }, 5000);
  }

  stopHeartbeat() {
    clearInterval(this.timers.heartbeat);
    this.awaitingPong = false;
  }

  /** 指数退避重连 */
  scheduleReconnect() {
    const delay = Math.min(1000 * 2 ** this.retry, 15_000);
    this.retry += 1;
    this.h.onLog('warn', `计划第 ${this.retry} 次重连`, `指数退避：等待 ${(delay / 1000).toFixed(0)}s（1s→2s→4s→8s→封顶 15s，避免雪崩式惊群）`);
    clearTimeout(this.timers.reconnect);
    this.timers.reconnect = setTimeout(() => {
      this.h.onLog('lifecycle', `开始第 ${this.retry} 次重连`, '重新走完整的 TCP + HTTP Upgrade 握手');
      this.connect();
    }, delay);
  }

  /** 发送：未就绪则入队，onopen 后自动补发（而不是丢消息） */
  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
      return 'sent';
    }
    this.outbox.push(obj);
    return 'queued';
  }

  /** 用户/演示按钮主动关闭：不重连 */
  close(reason) {
    this.closedByUser = true;
    this.stopHeartbeat();
    clearTimeout(this.timers.reconnect);
    if (this.ws) this.ws.close(1000, reason || 'client normal');
  }

  /** 演示"网络断线"：直接 close 但不设 closedByUser，观察自动重连 */
  simulateDrop() {
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) {
      this.ws.close(4002, 'simulated offline');
    }
  }
}

/* ------------------------------------------------------------------ */
/* 面板                                                                  */
/* ------------------------------------------------------------------ */
export function createWsPanel(root) {
  const sendBtn = h('button', { class: 'btn btn-primary' }, '发送');
  const connectBtn = h('button', { class: 'btn' }, '建立连接');
  const dropBtn = h('button', { class: 'btn btn-danger', title: '等价于拔网线：本地 close，但不阻止自动重连' }, '模拟断线');
  const kickBtn = h('button', { class: 'btn btn-danger', title: '服务端对所有 WS 连接发送 close 帧' }, '服务端踢线');
  const closeBtn = h('button', { class: 'btn' }, '主动关闭(不重连)');
  const { chat, log, input, badge } = buildPanel(root, {
    title: '④ WebSocket · 全双工长连接',
    hint: '一条 TCP 通道双向随便说 —— 重点观察状态机与重连',
    extraButtons: [connectBtn, sendBtn, dropBtn, kickBtn, closeBtn],
  });

  let sock = null;
  let updater = null; // 当前正在接收的助手气泡

  function setBadge(idx) {
    badge.style.display = '';
    badge.textContent = `${STATE_NAMES[idx]}(${idx})`;
    badge.className = `state-badge ${STATE_CLASS[idx]}`;
  }

  function ensureConnected() {
    if (sock && !sock.closedByUser && sock.ws && sock.ws.readyState <= WebSocket.OPEN) return;
    sock = new ResilientSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/chat`, {
      onState: (idx) => {
        const prev = badge.textContent;
        setBadge(idx);
        log.log('state', 'readyState 变迁', `${prev || '?'} → ${STATE_NAMES[idx]}(${idx})`);
      },
      onLog: (type, name, detail) => log.log(type, name, detail),
      onMessage: (obj) => {
        if (obj.type === 'token') {
          if (updater) updater.append(obj.text);
          log.log('transport', '收到 {type:"token"}', `text=${JSON.stringify(obj.text)} —— 服务端随时可以主动开口`);
        } else if (obj.type === 'done') {
          if (updater) updater.finish(`流式接收完成 · 共 ${obj.totalTokens} 个 token`);
          log.log('lifecycle', '收到 {type:"done"}', `本轮回复结束（${obj.totalTokens} 个 token），但连接保持 OPEN 可复用 —— 这就是与 HTTP 的本质区别`);
          updater = null;
        }
      },
    });
  }

  connectBtn.addEventListener('click', () => {
    log.markStart();
    log.log('info', '手动建立连接', '页面加载时不自动连，先观察握手');
    ensureConnected();
  });

  function submit(prompt) {
    ensureConnected();
    addUserMsg(chat, prompt);
    updater = startAssistantMsg(chat);
    const result = sock.send({ type: 'chat', prompt });
    if (result === 'sent') {
      log.log('transport', '发送 {type:"chat"}', `prompt=${JSON.stringify(prompt)} —— 上行通道，与下行互不干扰`);
    } else {
      log.log('warn', '消息已入队', `当前未处于 OPEN，{type:"chat"} 进入发送队列，onopen 后自动补发（真实应用的标准做法）`);
    }
  }

  sendBtn.addEventListener('click', () => submit(input.value.trim() || '你好'));
  input.addEventListener('keydown', (e) => e.key === 'Enter' && submit(input.value.trim() || '你好'));

  dropBtn.addEventListener('click', () => {
    if (!sock) return log.log('info', '模拟断线', '还没有连接，先点「建立连接」');
    log.log('error', '模拟断线', '本地直接 close(4002) —— 对端视角等同于网络掉线，重连逻辑将接管');
    sock.simulateDrop();
  });

  kickBtn.addEventListener('click', async () => {
    const r = await fetch('/api/admin/ws-kick', { method: 'POST' });
    const { kicked } = await r.json();
    log.log('error', 'POST /api/admin/ws-kick', `服务端向 ${kicked} 个连接发送 close 帧(code=4000) —— 观察 onclose 与自动重连`);
  });

  closeBtn.addEventListener('click', () => {
    if (sock) {
      sock.close('user quit');
      log.log('warn', '主动关闭', 'closedByUser=true：重连调度被取消，这是"用户登出"式的终态');
    }
  });

  return registerPanel({
    log,
    submit,
    stop: () => { if (sock) sock.close('panel teardown'); },
  });
}
