/**
 * app.js —— Tab 路由与全局控制
 *
 * 五个视图：HTTP / 轮询 / SSE / WebSocket / 并排对比。
 * 面板懒创建、创建后常驻（切换 Tab 不销毁，时间和连接状态得以延续）。
 */
import { h, clearAllLogs } from './panel-kit.js';
import { createHttpPanel } from './panels/http.js';
import { createPollingPanel } from './panels/polling.js';
import { createSsePanel } from './panels/sse.js';
import { createWsPanel } from './panels/ws.js';

const tabBar = document.getElementById('tab-bar');
const panelsRoot = document.getElementById('tab-panels');

const TABS = [
  { id: 'http', label: '① 普通 HTTP', create: createHttpPanel },
  { id: 'polling', label: '② HTTP 轮询', create: createPollingPanel },
  { id: 'sse', label: '③ SSE', create: createSsePanel },
  { id: 'ws', label: '④ WebSocket', create: createWsPanel },
  { id: 'compare', label: '⑤ 并排对比（SSE vs WS）', create: createCompareView },
];

const instances = new Map(); // id -> { root, panel }

function activate(id) {
  TABS.forEach((t) => {
    const btn = tabBar.querySelector(`[data-tab="${t.id}"]`);
    const ins = instances.get(t.id);
    btn.classList.toggle('active', t.id === id);
    if (ins) ins.root.classList.toggle('active', t.id === id);
  });
}

function openTab(id) {
  if (!instances.has(id)) {
    const def = TABS.find((t) => t.id === id);
    const root = h('section', { class: 'tab-panel', 'data-tab': id });
    panelsRoot.append(root);
    const panel = def.create(root);
    instances.set(id, { root, panel });
  }
  activate(id);
}

TABS.forEach((t) => {
  const btn = h('button', {
    class: 'tab-btn', 'data-tab': t.id,
    onclick: () => openTab(t.id),
  }, t.label);
  tabBar.append(btn);
});

document.getElementById('btn-clear-all').addEventListener('click', () => clearAllLogs());

/* ------------------------------------------------------------------ */
/* ⑤ 并排对比视图：同一个 prompt 同时发给 SSE 与 WS                       */
/* ------------------------------------------------------------------ */
function createCompareView(root) {
  const input = h('input', { class: 'prompt-input', value: '什么是 WebSocket？', placeholder: '同一个问题，两条路…' });
  const goBtn = h('button', { class: 'btn btn-primary' }, '同一 Prompt 同时发送');
  root.append(h('div', { class: 'compare-bar' }, [input, goBtn]));

  const inner = h('div', { class: 'compare-inner' });
  const sseCol = h('div', { class: 'compare-col' });
  const wsCol = h('div', { class: 'compare-col' });
  inner.append(sseCol, wsCol);
  root.append(inner);

  const ssePanel = createSsePanel(sseCol);
  const wsPanel = createWsPanel(wsCol);

  goBtn.addEventListener('click', async () => {
    const prompt = input.value.trim() || '你好';
    await ssePanel.submit(prompt);
    wsPanel.submit(prompt);
  });
  input.addEventListener('keydown', (e) => e.key === 'Enter' && goBtn.click());

  return {
    log: { clear: () => { ssePanel.log.clear(); wsPanel.log.clear(); } },
  };
}

// 默认打开第一个 Tab
openTab('http');
