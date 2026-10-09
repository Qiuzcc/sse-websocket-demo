/**
 * panels/polling.js —— HTTP 轮询（短轮询）
 *
 * 客户端每隔 800ms 主动问一次"好了吗/有新内容吗"。
 * 时间线用不同颜色区分"命中增量的轮询"与"空轮询"——
 * 你会直观看到：绝大部分请求都是无效 traffic。
 */
import { h, buildPanel, addUserMsg, startAssistantMsg, registerPanel } from '../panel-kit.js';

const POLL_INTERVAL = 800;

export function createPollingPanel(root) {
  const sendBtn = h('button', { class: 'btn btn-primary' }, '发送并开始轮询');
  const stopBtn = h('button', { class: 'btn btn-danger' }, '停止轮询');
  const { chat, log, input } = buildPanel(root, {
    title: '② HTTP 轮询 · 客户端反复主动问',
    hint: `每 ${POLL_INTERVAL}ms 拉一次增量 —— 灰色=空轮询，青色=拿到新内容`,
    extraButtons: [sendBtn, stopBtn],
  });

  let timer = null;
  let polling = false;

  function stopPolling(reason) {
    clearInterval(timer);
    polling = false;
    sendBtn.disabled = false;
    if (reason) log.log('warn', '轮询停止', reason);
  }

  async function submit(prompt) {
    if (polling) return;
    addUserMsg(chat, prompt);
    polling = true;
    sendBtn.disabled = true;

    log.markStart();
    // 第一步：创建任务（服务端后台开始"生成"）
    const resp = await fetch('/api/chat/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });
    const { jobId, cursor: initCursor } = await resp.json();
    log.log('lifecycle', 'POST /api/chat/jobs', `任务已创建 jobId=${jobId.slice(0, 8)}…（之后靠客户端反复 GET 取结果）`);

    const updater = startAssistantMsg(chat, '（轮询等待服务端产出……）');
    let cursor = initCursor;
    let n = 0;
    let hitChars = 0;

    timer = setInterval(async () => {
      n += 1;
      try {
        const r = await fetch(`/api/chat/jobs/${jobId}?cursor=${cursor}`);
        const data = await r.json();
        cursor = data.cursor;

        if (data.delta) {
          hitChars += data.delta.length;
          updater.append(data.delta);
          log.log('transport', `第 ${n} 次轮询 ✓`, `命中增量 ${data.delta.length} 字（累计 ${hitChars}）`);
        } else {
          log.log('info', `第 ${n} 次轮询 ✗`, '空轮询：服务端没有新内容，这次请求白发了');
        }

        if (data.done) {
          const stats = `共轮询 ${n} 次 / 收到 ${hitChars} 字`;
          updater.finish(`轮询结束 · ${stats}`);
          log.log('lifecycle', '任务完成', `done=true，停止轮询 —— ${stats}`);
          stopPolling();
        }
      } catch (err) {
        log.log('error', '轮询请求失败', String(err));
        stopPolling('因错误终止');
      }
    }, POLL_INTERVAL);
  }

  stopBtn.addEventListener('click', () => stopPolling('手动停止（客户端不问了，服务端结果就只能躺在内存里）'));
  sendBtn.addEventListener('click', () => submit(input.value.trim() || '你好'));
  input.addEventListener('keydown', (e) => e.key === 'Enter' && submit(input.value.trim() || '你好'));

  return registerPanel({ log, submit, stop: () => stopPolling() });
}
