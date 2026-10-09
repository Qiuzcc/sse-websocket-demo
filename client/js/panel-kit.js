/**
 * panel-kit.js —— 面板共用脚手架
 *
 * 统一生成"左侧聊天卡片 + 右侧事件时间线卡片"的面板布局，
 * 并提供聊天气泡的流式渲染助手。各协议面板只需关注自己的逻辑。
 */
import { EventLog } from './event-log.js';

/** 极简 DOM 创建助手：h('div', {class:'x'}, [child, 'text']) */
export function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'title') el.title = v;
    else el.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    el.append(c.nodeType ? c : document.createTextNode(c));
  }
  return el;
}

/**
 * 构建标准面板布局。
 * @param {HTMLElement} parent 面板根（.tab-panel）
 * @param {object} opts { title, hint, extraButtons: HTMLElement[] }
 * @returns { chat, controls, titleBar, badge, log, input }
 */
export function buildPanel(parent, opts) {
  parent.classList.add('panel-root');

  // 聊天卡片头：标题 + 状态徽标
  const badge = h('span', { class: 'state-badge', style: 'display:none' });
  const titleBar = h('div', { class: 'panel-title' }, [opts.title, badge, h('span', { class: 'hint' }, opts.hint || '')]);

  // 输入 + 按钮行
  const input = h('input', { class: 'prompt-input', placeholder: '输入问题，体验协议差异…', value: '什么是 WebSocket？' });
  const controls = h('div', { class: 'controls' }, [input, ...(opts.extraButtons || [])]);

  const chat = h('div', { class: 'chat-area' });
  const chatCard = h('div', { class: 'panel-chat' }, [titleBar, controls, chat]);

  // 时间线卡片
  const clearBtn = h('button', { class: 'btn btn-ghost', onclick: () => log.clear() }, '清空');
  const logBody = h('div', { class: 'log-body' });
  const logCard = h('div', { class: 'panel-log' }, [
    h('div', { class: 'log-head' }, [h('span', {}, '协议事件时间线'), clearBtn]),
    logBody,
  ]);
  const log = new EventLog(logBody);

  parent.append(h('div', { class: 'panel-inner' }, [chatCard, logCard]));
  return { chat, controls, titleBar, badge, log, input, chatCard, logCard };
}

/** 添加用户气泡 */
export function addUserMsg(chat, text) {
  chat.append(h('div', { class: 'msg msg-user' }, text));
  chat.scrollTop = chat.scrollHeight;
}

/**
 * 开始一条助手回复，返回流式更新器。
 * updater.append(text) 逐段追加；updater.finish(meta) 收尾并标注元信息。
 */
export function startAssistantMsg(chat, pendingText = '') {
  const body = h('span', { class: 'body' }, pendingText ? [h('i', { class: 'pending' }, pendingText)] : []);
  const meta = h('span', { class: 'msg-meta', style: 'display:none' });
  const bubble = h('div', { class: 'msg msg-assistant' }, [body, meta]);
  chat.append(bubble);
  chat.scrollTop = chat.scrollHeight;
  return {
    append(text) {
      const pending = body.querySelector('.pending');
      if (pending) pending.remove();
      body.append(text);
      chat.scrollTop = chat.scrollHeight;
    },
    finish(metaText) {
      if (metaText) {
        meta.textContent = metaText;
        meta.style.display = '';
      }
    },
  };
}

/** 面板注册协议：统一记录到 allPanels，供"清空所有时间线"使用 */
export const allPanels = [];
export function registerPanel(panel) {
  allPanels.push(panel);
  return panel;
}
export function clearAllLogs() {
  allPanels.forEach((p) => p.log.clear());
}
