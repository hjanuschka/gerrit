Gerrit.install(plugin => {
  const api = plugin.restApi();
  let currentChangeNum = null;
  let mounted = false;
  window.__gchatPluginLoaded = true;

  plugin.styleApi().insertCSSRule(`
    .gchat-fab {
      position: fixed;
      right: 22px;
      bottom: calc(92px + env(safe-area-inset-bottom, 0px));
      width: 52px;
      height: 52px;
      border-radius: 50%;
      border: 1px solid var(--border-color, #cdd2d8);
      background: var(--view-background-color, #fff);
      color: var(--primary-text-color, #111);
      box-shadow: 0 8px 22px rgba(0,0,0,0.22);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.03em;
      cursor: pointer;
      z-index: 2147483000;
    }

    .gchat-panel {
      position: fixed;
      right: 22px;
      bottom: calc(152px + env(safe-area-inset-bottom, 0px));
      width: min(430px, calc(100vw - 20px));
      height: min(64vh, 760px);
      display: none;
      flex-direction: column;
      border: 1px solid var(--border-color, #cdd2d8);
      border-radius: 14px;
      background: var(--view-background-color, #fff);
      box-shadow: 0 14px 36px rgba(0,0,0,0.28);
      z-index: 2147483000;
      overflow: hidden;
    }
    .gchat-panel.open { display: flex; }

    .gchat-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 10px 12px;
      border-bottom: 1px solid var(--border-color, #e2e4e7);
      background: var(--table-subheader-background-color, #f8f9fb);
    }
    .gchat-title {
      font-size: 13px;
      font-weight: 650;
      color: var(--primary-text-color, #111);
    }
    .gchat-close {
      border: 1px solid var(--border-color, #cdd2d8);
      border-radius: 8px;
      background: var(--view-background-color, #fff);
      color: var(--deemphasized-text-color, #666);
      cursor: pointer;
      font-size: 12px;
      line-height: 1;
      padding: 4px 7px;
    }

    .gchat-list {
      flex: 1;
      overflow: auto;
      padding: 12px;
      background: var(--table-subheader-background-color, #f7f8fa);
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .gchat-msg {
      display: flex;
      flex-direction: column;
      max-width: 92%;
      gap: 4px;
    }
    .gchat-msg-user { align-self: flex-end; }
    .gchat-msg-assistant, .gchat-msg-tool { align-self: flex-start; }

    .gchat-role {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: .05em;
      opacity: .72;
      padding: 0 4px;
    }

    .gchat-body {
      white-space: pre-wrap;
      font-size: 12px;
      line-height: 1.38;
      border: 1px solid var(--border-color, #d9dde3);
      border-radius: 10px;
      padding: 8px 10px;
      background: var(--view-background-color, #fff);
      color: var(--primary-text-color, #121212);
    }

    .gchat-msg-user .gchat-body {
      background: var(--selection-background-color, #e8f1ff);
    }

    .gchat-msg-tool .gchat-body {
      font-family: var(--monospace-font-family, ui-monospace, SFMono-Regular, Menlo, monospace);
      font-size: 11px;
      background: var(--table-subheader-background-color, #f0f2f4);
    }

    .gchat-empty {
      font-size: 12px;
      color: var(--deemphasized-text-color, #666);
      padding: 8px;
      text-align: center;
    }

    .gchat-controls {
      padding: 10px;
      border-top: 1px solid var(--border-color, #e2e4e7);
      display: flex;
      gap: 8px;
      align-items: flex-end;
      background: var(--view-background-color, #fff);
    }

    .gchat-input {
      flex: 1;
      min-height: 64px;
      max-height: 180px;
      resize: vertical;
      border: 1px solid var(--border-color, #cdd2d8);
      border-radius: 9px;
      padding: 8px;
      font-size: 12px;
      background: var(--view-background-color, #fff);
      color: var(--primary-text-color, #111);
    }

    .gchat-send {
      border: 1px solid var(--border-color, #cdd2d8);
      border-radius: 9px;
      padding: 8px 11px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      background: var(--view-background-color, #fff);
      color: var(--primary-text-color, #111);
    }

    .gchat-send[disabled], .gchat-input[disabled] {
      opacity: .55;
      cursor: not-allowed;
    }

    .gchat-footer-status {
      padding: 0 10px 10px;
      font-size: 11px;
      color: var(--deemphasized-text-color, #666);
      min-height: 16px;
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

    if (mounted && !document.querySelector('.gchat-fab')) {
      mounted = false;
    }

    if (currentChangeNum !== maybeChange || !mounted) {
      currentChangeNum = maybeChange;
      mountUi();
      reloadState();
    }
  };

  bootstrap();
  setTimeout(bootstrap, 400);
  setTimeout(bootstrap, 1200);
  setTimeout(bootstrap, 2500);
  setInterval(bootstrap, 2000);
  window.addEventListener('popstate', bootstrap);
  window.addEventListener('hashchange', bootstrap);

  function mountUi() {
    if (mounted) return;
    mounted = true;

    const fab = document.createElement('button');
    fab.className = 'gchat-fab';
    fab.type = 'button';
    fab.title = 'Open AI chat';
    fab.textContent = 'CHAT';

    const panel = document.createElement('section');
    panel.className = 'gchat-panel';
    panel.innerHTML = `
      <div class="gchat-header">
        <div class="gchat-title">AI Review Chat</div>
        <button class="gchat-close" type="button" title="Close">✕</button>
      </div>
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
    const closeEl = panel.querySelector('.gchat-close');

    fab.addEventListener('click', async () => {
      panel.classList.toggle('open');
      if (panel.classList.contains('open')) {
        await reloadState();
      }
    });

    closeEl.addEventListener('click', () => {
      panel.classList.remove('open');
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
      } catch (err) {
        statusEl.textContent = `Load failed: ${String(err)}`;
      }
    }

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

    if (!canWrite) {
      inputEl.placeholder = permissions.writeReason || 'Read-only mode';
      statusEl.textContent = permissions.writeReason || 'Read-only mode';
      return;
    }

    if (permissions.owner && permissions.reviewer) {
      statusEl.textContent = 'You can chat as owner/reviewer.';
    } else if (permissions.owner) {
      statusEl.textContent = 'You can chat as change owner.';
    } else {
      statusEl.textContent = 'You can chat as reviewer.';
    }
    inputEl.placeholder = 'Ask about this change...';
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
      empty.className = 'gchat-empty';
      empty.textContent = 'No chat messages yet for this CL.';
      listEl.appendChild(empty);
      return;
    }

    for (const msg of messages) {
      const roleName = msg.role || 'assistant';
      const item = document.createElement('div');
      item.className = `gchat-msg gchat-msg-${roleName}`;

      const role = document.createElement('div');
      role.className = 'gchat-role';
      role.textContent = msg.authorName || roleName;

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
