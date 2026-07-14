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

      this.inFlight = false;
      this.optimisticUserText = '';
      this.progressTimer = null;
      this.progressStepIndex = 0;
      this.progressSteps = [
        'Reading change context',
        'Inspecting patches',
        'Running tools',
        'Composing answer',
      ];
      this.progressStartedAt = 0;

      this.assistantStream = null;
      this.assistantStreamTimer = null;
      this.openToolIds = new Set();
      this.stickToBottom = true;

      this.render();
    }

    disconnectedCallback() {
      this.stopProgress();
      this.stopAssistantStream();
    }

    setContext(changeNum) {
      if (this.changeNum !== changeNum) {
        this.openToolIds.clear();
      }
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
            width: min(440px, calc(100vw - 24px));
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

          .body.markdown {
            white-space: normal;
            padding: 6px 8px;
          }

          .body.markdown .md {
            display: block;
            font-size: 12px;
            line-height: 1.4;
          }

          .body.markdown .md > :first-child { margin-top: 0; }
          .body.markdown .md > :last-child { margin-bottom: 0; }
          .body.markdown .md p { margin: 0 0 8px; }
          .body.markdown .md ul,
          .body.markdown .md ol { margin: 0 0 8px 18px; padding: 0; }
          .body.markdown .md li { margin: 2px 0; }
          .body.markdown .md pre {
            margin: 0 0 8px;
            padding: 8px;
            border-radius: 8px;
            background: #0f172a;
            color: #e5e7eb;
            overflow-x: auto;
            font-size: 11px;
            line-height: 1.35;
          }
          .body.markdown .md code {
            font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
            font-size: 11px;
            background: #eef2f7;
            padding: 1px 4px;
            border-radius: 4px;
          }
          .body.markdown .md pre code {
            background: transparent;
            padding: 0;
            border-radius: 0;
            color: inherit;
          }
          .body.markdown .md blockquote {
            margin: 0 0 8px;
            padding: 0 0 0 10px;
            border-left: 3px solid #cfd6de;
            color: #4b5563;
          }
          .body.markdown .md a {
            color: #2563eb;
            text-decoration: none;
          }
          .body.markdown .md a:hover { text-decoration: underline; }

          .msg.pending .body {
            background: #fffdf2;
            border-color: #e7dba8;
          }

          .pending-row {
            display: flex;
            align-items: center;
            gap: 7px;
            margin-bottom: 3px;
            font-weight: 600;
          }

          .spinner {
            width: 14px;
            height: 14px;
            border-radius: 50%;
            border: 2px solid #d7dce3;
            border-top-color: #3b82f6;
            animation: gchat-spin .9s linear infinite;
          }

          .pending-sub {
            font-size: 11px;
            color: #6b7280;
          }

          .pending-tools {
            margin-top: 6px;
            font-size: 11px;
            color: #4b5563;
            background: #f4f6f8;
            border: 1px solid #e2e7ec;
            border-radius: 8px;
            padding: 6px 7px;
          }

          .tool-details {
            border: 1px solid #d7dce3;
            border-radius: 10px;
            background: #eff2f5;
            overflow: hidden;
          }

          .tool-summary {
            list-style: none;
            cursor: pointer;
            padding: 7px 9px;
            font-size: 11px;
            display: flex;
            align-items: center;
            gap: 7px;
            color: #374151;
            user-select: none;
          }
          .tool-summary::-webkit-details-marker {
            display: none;
          }

          .tool-chevron {
            width: 8px;
            height: 8px;
            border-right: 1.8px solid #4b5563;
            border-bottom: 1.8px solid #4b5563;
            transform: rotate(-45deg);
            transition: transform .14s ease;
            margin-right: 2px;
          }

          .tool-details[open] .tool-chevron {
            transform: rotate(45deg);
            margin-top: -2px;
          }

          .tool-name {
            font-weight: 650;
          }

          .tool-content {
            border-top: 1px solid #d7dce3;
            background: #fff;
            white-space: pre-wrap;
            font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
            font-size: 11px;
            line-height: 1.34;
            color: #111827;
            padding: 8px 9px;
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

          @keyframes gchat-spin {
            to { transform: rotate(360deg); }
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

      this.listEl.addEventListener('scroll', () => {
        this.stickToBottom = this.isNearBottom();
      });

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
        this.stopAssistantStream();
        this.permissions = normalizePermissions(state.permissions || {});
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
      this.stickToBottom = true;
      this.optimisticUserText = text;
      this.startProgress();
      this.renderMessages();
      this.updateComposer();

      try {
        const state = await api.post(`/a/changes/${this.changeNum}/gerrit-chat~chat`, {message: text});
        this.permissions = normalizePermissions(state.permissions || {});
        this.messages = state.messages || [];
        this.optimisticUserText = '';
        this.stopProgress();

        const lastAssistant = this.findLastAssistantMessage(this.messages);
        if (lastAssistant && lastAssistant.id && lastAssistant.text) {
          this.startAssistantStream(lastAssistant.id, lastAssistant.text);
        } else {
          this.renderMessages();
          this.statusEl.textContent = 'Updated.';
        }
        this.updateComposer();
      } catch (err) {
        this.optimisticUserText = '';
        this.stopProgress();
        this.stopAssistantStream();
        this.renderMessages();
        this.updateComposer();
        this.inputEl.value = text;
        this.statusEl.textContent = `Send failed: ${String(err)}`;
      }
    }

    startProgress() {
      this.stopProgress();
      this.inFlight = true;
      this.progressStepIndex = 0;
      this.progressStartedAt = Date.now();
      this.statusEl.textContent = 'Pi is working…';

      this.progressTimer = window.setInterval(() => {
        this.progressStepIndex = (this.progressStepIndex + 1) % this.progressSteps.length;
        this.statusEl.textContent = `Pi is working… ${this.progressSteps[this.progressStepIndex]}`;
        this.renderMessages();
      }, 1000);
    }

    stopProgress() {
      this.inFlight = false;
      if (this.progressTimer) {
        window.clearInterval(this.progressTimer);
      }
      this.progressTimer = null;
    }

    startAssistantStream(messageId, fullText) {
      this.stopAssistantStream();
      this.assistantStream = {
        id: messageId,
        fullText,
        shown: 0,
        currentText: '',
      };
      this.statusEl.textContent = 'Streaming response…';

      const tick = () => {
        if (!this.assistantStream || this.assistantStream.id !== messageId) return;

        const total = this.assistantStream.fullText.length;
        const done = this.assistantStream.shown >= total;
        if (done) {
          this.stopAssistantStream();
          this.statusEl.textContent = 'Updated.';
          this.renderMessages();
          this.updateComposer();
          return;
        }

        const burst = Math.max(1, Math.min(10, Math.ceil(total / 180)));
        this.assistantStream.shown = Math.min(total, this.assistantStream.shown + burst);
        this.assistantStream.currentText = this.assistantStream.fullText.slice(
          0,
          this.assistantStream.shown
        );
        this.renderMessages();
      };

      tick();
      this.assistantStreamTimer = window.setInterval(tick, 24);
    }

    stopAssistantStream() {
      if (this.assistantStreamTimer) {
        window.clearInterval(this.assistantStreamTimer);
      }
      this.assistantStreamTimer = null;
      this.assistantStream = null;
    }

    findLastAssistantMessage(messages) {
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m && m.role === 'assistant') return m;
      }
      return null;
    }

    updateComposer() {
      const p = normalizePermissions(this.permissions || {});
      const canWrite = Boolean(p.canWrite);

      const busy = this.inFlight || Boolean(this.assistantStream);
      this.inputEl.disabled = !canWrite || busy;
      this.sendEl.disabled = !canWrite || busy;

      if (this.inFlight) {
        this.inputEl.placeholder = 'Pi is working…';
        return;
      }

      if (this.assistantStream) {
        this.inputEl.placeholder = 'Streaming response…';
        return;
      }

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
      const shouldAutoScroll = this.stickToBottom || this.listEl.scrollHeight === 0;
      this.listEl.textContent = '';
      const items = [...this.messages];
      if (this.optimisticUserText) {
        items.push({
          role: 'user',
          authorName: 'You',
          text: this.optimisticUserText,
          pending: true,
        });
      }

      if (!items.length && !this.inFlight) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'No chat messages yet for this CL.';
        this.listEl.appendChild(empty);
        return;
      }

      for (const msg of items) {
        const roleName = msg.role || 'assistant';
        const item = document.createElement('div');
        item.className = `msg ${roleName}`;

        const role = document.createElement('div');
        role.className = 'role';
        role.textContent = msg.authorName || roleName;
        item.appendChild(role);

        if (roleName === 'tool') {
          item.appendChild(this.renderToolDetails(msg));
        } else {
          const body = document.createElement('div');
          body.className = 'body';

          if (roleName === 'assistant') {
            body.classList.add('markdown');
            const text = this.getRenderedMessageText(msg);
            body.appendChild(renderMarkdownFragment(text));
          } else {
            body.textContent = msg.text || '';
          }

          item.appendChild(body);
        }

        this.listEl.appendChild(item);
      }

      if (this.inFlight) {
        this.listEl.appendChild(this.renderPendingMessage());
      }

      if (shouldAutoScroll) {
        this.listEl.scrollTop = this.listEl.scrollHeight;
        this.stickToBottom = true;
      }
    }

    isNearBottom() {
      const threshold = 32;
      return this.listEl.scrollHeight - (this.listEl.scrollTop + this.listEl.clientHeight) <= threshold;
    }

    renderToolDetails(msg) {
      const details = document.createElement('details');
      details.className = 'tool-details';

      const toolKey = getToolKey(msg);
      details.open = this.openToolIds.has(toolKey);
      details.addEventListener('toggle', () => {
        if (details.open) {
          this.openToolIds.add(toolKey);
        } else {
          this.openToolIds.delete(toolKey);
        }
      });

      const summary = document.createElement('summary');
      summary.className = 'tool-summary';

      const chevron = document.createElement('span');
      chevron.className = 'tool-chevron';

      const icon = document.createElement('span');
      icon.textContent = '🛠';

      const name = document.createElement('span');
      name.className = 'tool-name';
      name.textContent = deriveToolName(msg);

      summary.appendChild(chevron);
      summary.appendChild(icon);
      summary.appendChild(name);

      const content = document.createElement('div');
      content.className = 'tool-content';
      content.textContent = msg.text || '';

      details.appendChild(summary);
      details.appendChild(content);
      return details;
    }

    getRenderedMessageText(msg) {
      if (
        this.assistantStream &&
        msg &&
        msg.id &&
        this.assistantStream.id === msg.id &&
        typeof this.assistantStream.currentText === 'string'
      ) {
        return this.assistantStream.currentText;
      }
      return msg && msg.text ? msg.text : '';
    }

    renderPendingMessage() {
      const item = document.createElement('div');
      item.className = 'msg assistant pending';

      const role = document.createElement('div');
      role.className = 'role';
      role.textContent = 'AI assistant';

      const body = document.createElement('div');
      body.className = 'body';

      const row = document.createElement('div');
      row.className = 'pending-row';

      const spinner = document.createElement('span');
      spinner.className = 'spinner';

      const label = document.createElement('span');
      const currentStep = this.progressSteps[this.progressStepIndex] || 'Thinking';
      label.textContent = `Pi is working… ${currentStep}`;

      row.appendChild(spinner);
      row.appendChild(label);

      const sub = document.createElement('div');
      sub.className = 'pending-sub';
      sub.textContent = `Elapsed ${formatElapsed(Date.now() - this.progressStartedAt)}`;

      const toolsHint = document.createElement('div');
      toolsHint.className = 'pending-tools';
      toolsHint.textContent = 'Tool calls will appear as collapsed entries below once available.';

      body.appendChild(row);
      body.appendChild(sub);
      body.appendChild(toolsHint);

      item.appendChild(role);
      item.appendChild(body);
      return item;
    }
  }

  function normalizePermissions(raw) {
    return {
      canWrite: raw.canWrite ?? raw.can_write ?? false,
      writeReason: raw.writeReason ?? raw.write_reason ?? '',
      owner: raw.owner ?? false,
      reviewer: raw.reviewer ?? false,
      loggedIn: raw.loggedIn ?? raw.logged_in ?? false,
    };
  }

  function getToolKey(msg) {
    if (msg && msg.id) return `id:${msg.id}`;
    return `tool:${deriveToolName(msg)}:${msg && msg.created ? msg.created : ''}`;
  }

  function renderMarkdownFragment(text) {
    const wrap = document.createElement('div');
    wrap.className = 'md';
    wrap.innerHTML = markdownToSafeHtml(text || '');
    return wrap;
  }

  function markdownToSafeHtml(markdown) {
    const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      if (/^\s*```/.test(line)) {
        const codeLines = [];
        i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) {
          codeLines.push(lines[i]);
          i++;
        }
        if (i < lines.length && /^\s*```/.test(lines[i])) i++;
        out.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
        continue;
      }

      if (/^\s*$/.test(line)) {
        i++;
        continue;
      }

      const headingMatch = line.match(/^\s*(#{1,6})\s+(.+)$/);
      if (headingMatch) {
        const level = headingMatch[1].length;
        out.push(`<h${level}>${formatInline(headingMatch[2])}</h${level}>`);
        i++;
        continue;
      }

      if (/^\s*>\s?/.test(line)) {
        const quote = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          quote.push(lines[i].replace(/^\s*>\s?/, ''));
          i++;
        }
        out.push(`<blockquote>${formatInline(quote.join('\n')).replace(/\n/g, '<br>')}</blockquote>`);
        continue;
      }

      if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
        const ordered = /^\s*\d+\.\s+/.test(line);
        const itemRe = ordered ? /^\s*\d+\.\s+(.+)$/ : /^\s*[-*+]\s+(.+)$/;
        const items = [];
        while (i < lines.length) {
          const m = lines[i].match(itemRe);
          if (!m) break;
          items.push(`<li>${formatInline(m[1])}</li>`);
          i++;
        }
        out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
        continue;
      }

      const para = [];
      while (
        i < lines.length &&
        !/^\s*$/.test(lines[i]) &&
        !/^\s*```/.test(lines[i]) &&
        !/^\s*(#{1,6})\s+/.test(lines[i]) &&
        !/^\s*>\s?/.test(lines[i]) &&
        !/^\s*[-*+]\s+/.test(lines[i]) &&
        !/^\s*\d+\.\s+/.test(lines[i])
      ) {
        para.push(lines[i]);
        i++;
      }
      out.push(`<p>${formatInline(para.join('\n')).replace(/\n/g, '<br>')}</p>`);
    }

    return out.join('');
  }

  function formatInline(raw) {
    let text = escapeHtml(raw || '');

    const codeSpans = [];
    text = text.replace(/`([^`]+)`/g, (_m, code) => {
      const token = `__GCHAT_CODE_${codeSpans.length}__`;
      codeSpans.push(`<code>${code}</code>`);
      return token;
    });

    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, href) => {
      const safeHref = sanitizeUrl(href);
      return `<a href="${escapeHtmlAttr(safeHref)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    });

    text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/(^|\W)\*([^*]+)\*(?=\W|$)/g, '$1<em>$2</em>');

    for (let idx = 0; idx < codeSpans.length; idx++) {
      text = text.replace(`__GCHAT_CODE_${idx}__`, codeSpans[idx]);
    }

    return text;
  }

  function sanitizeUrl(url) {
    const value = String(url || '').trim();
    if (!value) return '#';
    if (/^(https?:|mailto:|\/)/i.test(value)) return value;
    return `https://${value}`;
  }

  function escapeHtml(input) {
    return String(input || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escapeHtmlAttr(input) {
    return escapeHtml(input).replace(/`/g, '&#96;');
  }

  function deriveToolName(msg) {
    const author = msg.authorName || '';
    if (author.startsWith('tool:')) return author.slice('tool:'.length);
    return author || 'tool call';
  }

  function formatElapsed(ms) {
    if (ms < 1000) return '<1s';
    const sec = Math.floor(ms / 1000);
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    const rem = sec % 60;
    return `${min}m ${rem}s`;
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
