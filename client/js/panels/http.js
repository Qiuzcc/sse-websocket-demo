/**
 * panels/http.js —— 普通 HTTP（请求-响应，一次性返回）
 *
 * 对比基线：服务端要等全部 token 生成完才能返回，
 * 用户在此期间只能干等 —— 时间线上"发出请求"和"收到响应"之间是一片真空。
 */
import { h, buildPanel, addUserMsg, startAssistantMsg, registerPanel } from '../panel-kit.js';

export function createHttpPanel(root) {
  const sendBtn = h('button', { class: 'btn btn-primary' }, '发送（等待完整响应）');
  const { chat, log, input } = buildPanel(root, {
    title: '① 普通 HTTP · 请求-响应',
    hint: '服务端攒完全部内容才返回 —— 注意时间线上的"空窗期"',
    extraButtons: [sendBtn],
  });

  let busy = false;

  async function submit(prompt) {
    if (busy) return;
    busy = true;
    sendBtn.disabled = true;
    addUserMsg(chat, prompt);
    const updater = startAssistantMsg(chat, '（等待服务端生成全部内容……）');
    const waiting = h('div', { class: 'waiting-hint' }, '⏳ 一次性响应：生成完成前你什么也看不到');
    chat.append(waiting);
    chat.scrollTop = chat.scrollHeight;

    log.markStart();
    const t0 = performance.now();
    log.log('transport', 'fetch POST /api/chat', '请求发出（body 携带 prompt）');
    try {
      const resp = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });
      const data = await resp.json();
      const secs = ((performance.now() - t0) / 1000).toFixed(1);
      waiting.remove();
      updater.append(data.reply);
      updater.finish(`HTTP 200 · 一次性返回 · 耗时 ${secs}s`);
      log.log('transport', `HTTP ${resp.status}`, `收到完整响应体（${data.reply.length} 字，耗时 ${secs}s）`);
      log.log('lifecycle', '请求结束', '响应体接收完毕，连接归还/关闭 —— 期间服务端无法再推送任何内容');
    } catch (err) {
      waiting.remove();
      log.log('error', '请求失败', String(err));
      updater.append(`❌ ${err}`);
    } finally {
      busy = false;
      sendBtn.disabled = false;
    }
  }

  sendBtn.addEventListener('click', () => submit(input.value.trim() || '你好'));
  input.addEventListener('keydown', (e) => e.key === 'Enter' && submit(input.value.trim() || '你好'));

  return registerPanel({ log, submit });
}
