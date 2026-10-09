/**
 * event-log.js —— 协议事件时间线组件（所有面板共用）
 *
 * 每一行 = 一个协议相关事件：相对时间 + 类型标签 + 事件名 + 详情。
 * 类型决定颜色：
 *   lifecycle 连接生命周期（建立/关闭）
 *   state     状态机变化（readyState 等）
 *   transport 业务数据传输（消息/事件/token 到达）
 *   heartbeat 心跳收发
 *   error     错误/异常断线
 *   warn      值得注意的行为（空轮询、无自动重连……）
 *   info      普通说明
 */

const TYPE_LABEL = {
  lifecycle: '生命周期',
  state: '状态机',
  transport: '传输',
  heartbeat: '心跳',
  error: '异常',
  warn: '注意',
  info: '信息',
};

const MAX_ROWS = 500; // 行数封顶：每个 token 一条记录，长会话下需控制 DOM 规模

export class EventLog {
  /** @param {HTMLElement} bodyEl 已存在的 .log-body 容器 */
  constructor(bodyEl) {
    this.body = bodyEl;
    this.startAt = null;
    this.body.innerHTML = '<div class="log-empty">（暂无事件，先在左侧发起一次请求）</div>';
  }

  /** 重置计时基准（一般在发起新一轮交互时调用） */
  markStart() {
    this.startAt = performance.now();
  }

  clear() {
    this.startAt = null;
    this.body.innerHTML = '<div class="log-empty">（已清空）</div>';
  }

  /**
   * @param {keyof TYPE_LABEL} type 事件类型（决定颜色）
   * @param {string} name 事件名
   * @param {string} detail 详情文本
   */
  log(type, name, detail = '') {
    if (this.startAt === null) this.markStart();
    if (this.body.querySelector('.log-empty')) this.body.innerHTML = '';

    const elapsed = ((performance.now() - this.startAt) / 1000).toFixed(2);
    const row = document.createElement('div');
    row.className = `log-entry t-${type}`;

    const timeEl = document.createElement('span');
    timeEl.className = 'log-time';
    timeEl.textContent = `+${elapsed}s`;

    const tagEl = document.createElement('span');
    tagEl.className = 'log-tag';
    tagEl.textContent = TYPE_LABEL[type] || type;

    const nameEl = document.createElement('span');
    nameEl.className = 'log-name';
    nameEl.textContent = name;

    row.append(timeEl, tagEl, nameEl);
    if (detail) {
      const detailEl = document.createElement('span');
      detailEl.className = 'log-detail';
      detailEl.textContent = detail;
      row.append(detailEl);
    }
    this.body.append(row);
    while (this.body.children.length > MAX_ROWS) this.body.firstChild.remove();
    this.body.scrollTop = this.body.scrollHeight;
  }
}
