Gerrit.install(plugin => {
  const api = plugin.restApi();
  let currentChangeNum = null;
  let widget = null;

  class GerritChatWidget extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({mode: 'open'});
      this.changeNum = null;
      this.permissions = {};
      this.messages = [];
      this.render();
    }

    setContext(changeNum) {
      this.changeNum = changeNum;
      this.updateHeader();
      this.reload();
    }

    render() {
      this.shadowRoot.innerHTML = `
        <style>
          :host {
            all: initial;
            position: fixed;
            right: 22px;
            bottom: calc(88px + env(safe-area-inset-bottom, 0px));
            z-index: 2147483000;
            font-family: var(--font-family, Inter, system-ui, -apple-system, sans-serif);
          }

          .fab {
            width: 54px;
            height: 54px;
            border-radius: 50%;
            border: 1px solid #cfd6de;
            background: #fff;
            color: #1f2937;
            box-shadow: 0 10px 24px rgba(0,0,0,0.24);
            cursor: pointer;
            display: grid;
            place-items: center;
          }

          .fab-icon {
            width: 24px;
            height: 24px;
            display: block;
          }

          .panel {
            position: absolute;
            right: 0;
            bottom: 66px;
            width: min(430px, calc(100vw - 24px));
            height: min(65vh, 760px);
            border: 1px solid #d7dce3;
            border-radius: 14px;
            background: #fff;
            box-shadow: 0 18px 38px rgba(0,0,0,0.28);
            overflow: hidden;
            display: none;
            flex-direction: column;
          }
          .panel.open { display: flex; }

          .header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            padding: 10px 12px;
            border-bottom: 1px solid #e4e8ed;
            background: #f7f9fb;
          }

          .title {
            font-size: 13px;
            font-weight: 650;
            color: #111827;
          }
          .subtitle {
            font-size: 10px;
            color: #6b7280;
            margin-top: 1px;
          }

          .close {
            border: 1px solid #cfd6de;
            border-radius: 8px;
            background: #fff;
            color: #6b7280;
            cursor: pointer;
            font-size: 12px;
            line-height: 1;
            padding: 4px 7px;
          }

          .list {
            flex: 1;
            overflow: auto;
            padding: 12px;
            display: flex;
            flex-direction: column;
            gap: 10px;
            background: #f7f8fa;
          }

          .empty {
            font-size: 12px;
            color: #6b7280;
            text-align: center;
            padding: 10px;
          }

          .msg {
            display: flex;
            flex-direction: column;
            gap: 4px;
            max-width: 92%;
          }
          .msg.user { align-self: flex-end; }
          .msg.assistant,
          .msg.tool { align-self: flex-start; }

          .role {
            font-size: 10px;
            text-transform: uppercase;
            letter-spacing: .05em;
            color: #6b7280;
            padding: 0 4px;
          }

          .body {
            white-space: pre-wrap;
            font-size: 12px;
            line-height: 1.38;
            border: 1px solid #d7dce3;
            border-radius: 10px;
            padding: 8px 10px;
            color: #111827;
            background: #fff;
          }

          .msg.user .body {
            background: #e9f2ff;
          }

          .msg.tool .body {
            font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
            font-size: 11px;
            background: #eff2f5;
          }

          .controls {
            padding: 10px;
            border-top: 1px solid #e4e8ed;
            background: #fff;
            display: flex;
            gap: 8px;
            align-items: flex-end;
          }

          .input {
            flex: 1;
            min-height: 64px;
            max-height: 180px;
            resize: vertical;
            border: 1px solid #cfd6de;
            border-radius: 9px;
            padding: 8px;
            font-size: 12px;
            color: #111827;
            background: #fff;
          }

          .send {
            border: 1px solid #cfd6de;
            border-radius: 9px;
            padding: 8px 11px;
            font-size: 12px;
            font-weight: 600;
            cursor: pointer;
            background: #fff;
            color: #111827;
          }

          .send[disabled],
          .input[disabled] {
            opacity: .56;
            cursor: not-allowed;
          }

          .status {
            padding: 0 10px 10px;
            font-size: 11px;
            color: #6b7280;
            min-height: 16px;
          }
        </style>

        <button class="fab" type="button" title="Open AI chat" aria-label="Open AI chat">
          <svg class="fab-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M4 5.5C4 4.67 4.67 4 5.5 4h13c.83 0 1.5.67 1.5 1.5v9c0 .83-.67 1.5-1.5 1.5H10l-4.4 3.5c-.5.4-1.2.04-1.2-.6V16.9c-.23-.26-.4-.6-.4-.9v-10.5Z" fill="currentColor"/>
          </svg>
        </button>

        <section class="panel">
          <div class="header">
            <div>
              <div class="title">AI Review Chat</div>
              <div class="subtitle"></div>
            </div>
            <button class="close" type="button" title="Close">✕</button>
          </div>

          <div class="list" aria-live="polite"></div>

          <div class="controls">
            <textarea class="input" placeholder="Ask about this change..." aria-label="Chat message"></textarea>
            <button class="send" type="button">Send</button>
          </div>

          <div class="status">Ready.</div>
        </section>
      `;

      this.fabEl = this.shadowRoot.querySelector('.fab');
      this.panelEl = this.shadowRoot.querySelector('.panel');
      this.closeEl = this.shadowRoot.querySelector('.close');
      this.subtitleEl = this.shadowRoot.querySelector('.subtitle');
      this.listEl = this.shadowRoot.querySelector('.list');
      this.inputEl = this.shadowRoot.querySelector('.input');
      this.sendEl = this.shadowRoot.querySelector('.send');
      this.statusEl = this.shadowRoot.querySelector('.status');

      this.fabEl.addEventListener('click', async () => {
        this.panelEl.classList.toggle('open');
        if (this.panelEl.classList.contains('open')) {
          await this.reload();
        }
      });

      this.closeEl.addEventListener('click', () => {
        this.panelEl.classList.remove('open');
      });

      this.sendEl.addEventListener('click', () => this.sendMessage());
      this.inputEl.addEventListener('keydown', e => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
          e.preventDefault();
          this.sendMessage();
        }
      });
    }

    updateHeader() {
      this.subtitleEl.textContent = this.changeNum ? `Change #${this.changeNum}` : '';
    }

    async reload() {
      if (!this.changeNum) return;
      try {
        const state = await api.get(`/a/changes/${this.changeNum}/gerrit-chat~chat`);
        this.permissions = state.permissions || {};
        this.messages = state.messages || [];
        this.renderMessages();
        this.updateComposer();
      } catch (err) {
        this.statusEl.textContent = `Load failed: ${String(err)}`;
      }
    }

    async sendMessage() {
      if (!this.changeNum) return;
      const text = this.inputEl.value.trim();
      if (!text || this.sendEl.disabled) return;

      this.inputEl.value = '';
      this.sendEl.disabled = true;
      this.statusEl.textContent = 'Thinking…';

      try {
        const state = await api.post(`/a/changes/${this.changeNum}/gerrit-chat~chat`, {message: text});
        this.permissions = state.permissions || {};
        this.messages = state.messages || [];
        this.renderMessages();
        this.updateComposer();
        this.statusEl.textContent = 'Updated.';
      } catch (err) {
        this.statusEl.textContent = `Send failed: ${String(err)}`;
      } finally {
        if (!this.inputEl.disabled) this.sendEl.disabled = false;
      }
    }

    updateComposer() {
      const p = this.permissions || {};
      const canWrite = Boolean(p.canWrite);

      this.inputEl.disabled = !canWrite;
      this.sendEl.disabled = !canWrite;

      if (!canWrite) {
        this.inputEl.placeholder = p.writeReason || 'Read-only mode';
        this.statusEl.textContent = p.writeReason || 'Read-only mode';
        return;
      }

      if (p.owner && p.reviewer) {
        this.statusEl.textContent = 'You can chat as owner/reviewer.';
      } else if (p.owner) {
        this.statusEl.textContent = 'You can chat as change owner.';
      } else {
        this.statusEl.textContent = 'You can chat as reviewer.';
      }
      this.inputEl.placeholder = 'Ask about this change...';
    }

    renderMessages() {
      this.listEl.textContent = '';
      if (!this.messages.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'No chat messages yet for this CL.';
        this.listEl.appendChild(empty);
        return;
      }

      for (const msg of this.messages) {
        const roleName = msg.role || 'assistant';
        const item = document.createElement('div');
        item.className = `msg ${roleName}`;

        const role = document.createElement('div');
        role.className = 'role';
        role.textContent = msg.authorName || roleName;

        const body = document.createElement('div');
        body.className = 'body';
        body.textContent = msg.text || '';

        item.appendChild(role);
        item.appendChild(body);
        this.listEl.appendChild(item);
      }

      this.listEl.scrollTop = this.listEl.scrollHeight;
    }
  }

  if (!customElements.get('gchat-widget')) {
    customElements.define('gchat-widget', GerritChatWidget);
  }

  plugin.on('showchange', change => {
    const changeNum = change && change._number ? change._number : null;
    if (!changeNum) return;
    mount(changeNum);
  });

  const bootstrap = () => {
    const maybeChange = readChangeFromUrl();
    if (!maybeChange) {
      unmount();
      return;
    }
    mount(maybeChange);
  };

  bootstrap();
  setTimeout(bootstrap, 500);
  setTimeout(bootstrap, 1500);
  setTimeout(bootstrap, 3000);
  setInterval(bootstrap, 2000);
  window.addEventListener('popstate', bootstrap);
  window.addEventListener('hashchange', bootstrap);

  function mount(changeNum) {
    currentChangeNum = changeNum;

    if (!widget || !document.body.contains(widget)) {
      widget = document.createElement('gchat-widget');
      document.body.appendChild(widget);
    }

    widget.setContext(changeNum);
  }

  function unmount() {
    currentChangeNum = null;
    if (widget && document.body.contains(widget)) {
      widget.remove();
    }
    widget = null;
  }

  function readChangeFromUrl() {
    const full = `${window.location.pathname}${window.location.hash}`;
    const match = full.match(/\/(?:c\/)?[^\s]*\+\/(\d+)/);
    if (match) return Number(match[1]);
    return null;
  }
});
