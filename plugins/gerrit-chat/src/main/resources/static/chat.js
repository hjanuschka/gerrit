Gerrit.install(plugin => {
  const api = plugin.restApi();
  let currentChangeNum = null;
  let mounted = false;

  plugin.styleApi().insertCSSRule(`
    .gchat-fab {
      position: fixed;
      left: 18px;
      bottom: 18px;
      width: 46px;
      height: 46px;
      border-radius: 50%;
      border: 1px solid var(--border-color, #d0d0d0);
      background: var(--view-background-color, #fff);
      color: var(--primary-text-color, #222);
      box-shadow: 0 2px 10px rgba(0,0,0,0.16);
      font-size: 20px;
      cursor: pointer;
      z-index: 1000;
    }
    .gchat-panel {
      position: fixed;
      left: 18px;
      bottom: 72px;
      width: 380px;
      max-height: 70vh;
      display: none;
      flex-direction: column;
      border: 1px solid var(--border-color, #d0d0d0);
      border-radius: 10px;
      background: var(--view-background-color, #fff);
      box-shadow: 0 8px 28px rgba(0,0,0,0.26);
      z-index: 1000;
      overflow: hidden;
    }
    .gchat-panel.open {
      display: flex;
    }
    .gchat-header {
      padding: 10px 12px;
      border-bottom: 1px solid var(--border-color, #ddd);
      font-weight: 600;
      font-size: 13px;
    }
    .gchat-list {
      padding: 10px;
      overflow: auto;
      flex: 1;
      background: var(--table-subheader-background-color, #fafafa);
    }
    .gchat-msg { margin-bottom: 10px; }
    .gchat-msg:last-child { margin-bottom: 0; }
    .gchat-role {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: .05em;
      opacity: .72;
      margin-bottom: 3px;
    }
    .gchat-body {
      white-space: pre-wrap;
      font-size: 12px;
      line-height: 1.35;
    }
    .gchat-controls {
      padding: 10px;
      border-top: 1px solid var(--border-color, #ddd);
      display: flex;
      gap: 8px;
      align-items: flex-end;
      background: var(--view-background-color, #fff);
    }
    .gchat-input {
      flex: 1;
      min-height: 60px;
      max-height: 160px;
      resize: vertical;
      border: 1px solid var(--border-color, #ccc);
      border-radius: 6px;
      padding: 8px;
      font-size: 12px;
      background: var(--view-background-color, #fff);
      color: var(--primary-text-color, #222);
    }
    .gchat-send {
      border: 1px solid var(--border-color, #bbb);
      border-radius: 6px;
      padding: 7px 10px;
      font-size: 12px;
      cursor: pointer;
      background: var(--view-background-color, #fff);
      color: var(--primary-text-color, #222);
    }
    .gchat-send[disabled], .gchat-input[disabled] {
      opacity: .55;
      cursor: not-allowed;
    }
    .gchat-footer-status {
      padding: 0 10px 10px;
      font-size: 11px;
      color: var(--deemphasized-text-color, #666);
    }
  `);

  plugin.on('showchange', change => {
    currentChangeNum = change && change._number ? change._number : null;
    if (!currentChangeNum) return;
    mountUi();
    reloadState();
  });

  const bootstrap = () => {
    const maybeChange = readChangeFromUrl();
    if (!maybeChange) return;
    if (currentChangeNum !== maybeChange) {
      currentChangeNum = maybeChange;
      mountUi();
      reloadState();
    }
  };
  bootstrap();
  setTimeout(bootstrap, 400);
  setTimeout(bootstrap, 1200);
  window.addEventListener('popstate', bootstrap);
  window.addEventListener('hashchange', bootstrap);

  function mountUi() {
    if (mounted) return;
    mounted = true;

    const fab = document.createElement('button');
    fab.className = 'gchat-fab';
    fab.type = 'button';
    fab.title = 'Open AI chat';
    fab.textContent = '💬';

    const panel = document.createElement('section');
    panel.className = 'gchat-panel';
    panel.innerHTML = `
      <div class="gchat-header">AI Chat (reviewer-write)</div>
      <div class="gchat-list" aria-live="polite"></div>
      <div class="gchat-controls">
        <textarea class="gchat-input" placeholder="Ask about this change..." aria-label="Chat message"></textarea>
        <button class="gchat-send" type="button">Send</button>
      </div>
      <div class="gchat-footer-status">Ready.</div>
    `;

    document.body.appendChild(fab);
    document.body.appendChild(panel);

    const listEl = panel.querySelector('.gchat-list');
    const inputEl = panel.querySelector('.gchat-input');
    const sendEl = panel.querySelector('.gchat-send');
    const statusEl = panel.querySelector('.gchat-footer-status');

    fab.addEventListener('click', async () => {
      panel.classList.toggle('open');
      if (panel.classList.contains('open')) {
        await reloadState();
      }
    });

    const send = async () => {
      if (!currentChangeNum) return;
      const text = inputEl.value.trim();
      if (!text || sendEl.disabled) return;
      inputEl.value = '';
      sendEl.disabled = true;
      statusEl.textContent = 'Thinking…';
      try {
        const state = await api.post(`/changes/${currentChangeNum}/gerrit-chat~chat`, {message: text});
        renderMessages(state.messages || [], listEl);
        updateComposer(state.permissions || {}, inputEl, sendEl, statusEl);
        statusEl.textContent = 'Updated.';
      } catch (err) {
        statusEl.textContent = `Send failed: ${String(err)}`;
      } finally {
        if (!inputEl.disabled) sendEl.disabled = false;
      }
    };

    sendEl.addEventListener('click', send);
    inputEl.addEventListener('keydown', e => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        send();
      }
    });

    async function reloadState() {
      if (!currentChangeNum) return;
      try {
        const state = await api.get(`/changes/${currentChangeNum}/gerrit-chat~chat`);
        renderMessages(state.messages || [], listEl);
        updateComposer(state.permissions || {}, inputEl, sendEl, statusEl);
        if (!state.permissions?.canWrite) {
          statusEl.textContent = state.permissions?.writeReason || 'Read-only mode.';
        }
      } catch (err) {
        statusEl.textContent = `Load failed: ${String(err)}`;
      }
    }

    // expose for plugin.on('showchange')
    window.__gchatReload = reloadState;
  }

  async function reloadState() {
    if (typeof window.__gchatReload === 'function') {
      await window.__gchatReload();
    }
  }

  function updateComposer(permissions, inputEl, sendEl, statusEl) {
    const canWrite = Boolean(permissions && permissions.canWrite);
    inputEl.disabled = !canWrite;
    sendEl.disabled = !canWrite;
    inputEl.placeholder = canWrite
      ? 'Ask about this change...'
      : (permissions.writeReason || 'Read-only: only reviewers can post.');
    if (canWrite) {
      statusEl.textContent = 'You can chat as reviewer.';
    }
  }

  function readChangeFromUrl() {
    const full = `${window.location.pathname}${window.location.hash}`;
    const match = full.match(/\/(?:c\/)?[^\s]*\+\/(\d+)/);
    if (match) return Number(match[1]);
    return null;
  }

  function renderMessages(messages, listEl) {
    listEl.textContent = '';
    if (!messages.length) {
      const empty = document.createElement('div');
      empty.className = 'gchat-status';
      empty.textContent = 'No messages yet.';
      listEl.appendChild(empty);
      return;
    }
    for (const msg of messages) {
      const item = document.createElement('div');
      item.className = `gchat-msg gchat-msg-${msg.role || 'assistant'}`;

      const role = document.createElement('div');
      role.className = 'gchat-role';
      role.textContent = msg.authorName || msg.role || 'message';

      const body = document.createElement('div');
      body.className = 'gchat-body';
      body.textContent = msg.text || '';

      item.appendChild(role);
      item.appendChild(body);
      listEl.appendChild(item);
    }
    listEl.scrollTop = listEl.scrollHeight;
  }
});
