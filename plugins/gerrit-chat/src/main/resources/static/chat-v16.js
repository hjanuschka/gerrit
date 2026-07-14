Gerrit.install(plugin => {
  const api = plugin.restApi();
  let widget = null;

  class GerritChatWidget extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({mode: 'open'});

      this.changeNum = null;
      this.permissions = {};
      this.threads = [];
      this.threadMessagesById = {};
      this.activeThreadId = null;
      this.messages = [];

      this.inFlight = false;
      this.optimisticUserText = '';
      this.progressTimer = null;
      this.progressStepIndex = 0;
      this.progressSteps = [
        'tool: get_change_metadata',
        'tool: list_changed_files',
        'tool: list_change_comments',
        'tool: search_in_change',
        'tool: get_diff',
        'tool: get_file',
        'drafting response',
      ];
      this.progressToolTrail = [];
      this.progressStartedAt = 0;

      this.assistantStream = null;
      this.assistantStreamTimer = null;
      this.openToolIds = new Set();
      this.stickToBottom = true;
      this.markedReady = false;
      this.defaultThreadEnsuredForChange = false;
      this.reloadTriggeredByToolMessageIds = new Set();
      this.hasLoadedStateOnceForChange = false;

      this.render();

      ensureMarkedLoaded().then(ok => {
        this.markedReady = Boolean(ok);
        this.renderMessages();
      });
    }

    disconnectedCallback() {
      this.stopProgress();
      this.stopAssistantStream();
    }

    setContext(changeNum) {
      if (this.changeNum !== changeNum) {
        this.openToolIds.clear();
        this.defaultThreadEnsuredForChange = false;
        this.reloadTriggeredByToolMessageIds.clear();
        this.hasLoadedStateOnceForChange = false;
      }
      this.changeNum = changeNum;
      this.updateHeader();
      this.reload({ensureDefaultThread: false});
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
            width: min(460px, calc(100vw - 24px));
            height: min(68vh, 780px);
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

          .thread-bar {
            display: flex;
            gap: 8px;
            align-items: center;
            padding: 8px 10px;
            border-bottom: 1px solid #e8ecf0;
            background: #fafbfc;
          }

          .thread-select {
            flex: 1;
            border: 1px solid #cfd6de;
            border-radius: 8px;
            background: #fff;
            color: #111827;
            font-size: 12px;
            padding: 6px 8px;
            min-width: 0;
          }

          .thread-new {
            border: 1px solid #cfd6de;
            border-radius: 8px;
            background: #fff;
            color: #111827;
            cursor: pointer;
            font-size: 11px;
            font-weight: 600;
            padding: 6px 8px;
            white-space: nowrap;
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
            max-width: 93%;
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

          .role-account {
            display: flex;
            align-items: center;
            padding: 0 2px;
          }

          .role-account gr-account-chip {
            --account-chip-border-radius: 12px;
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
            color: #111827;
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
          .tool-summary::-webkit-details-marker { display: none; }

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
          .input[disabled],
          .thread-select[disabled],
          .thread-new[disabled] {
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

          <div class="thread-bar">
            <select class="thread-select" aria-label="Chat thread"></select>
            <button class="thread-new" type="button">New thread</button>
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
      this.threadSelectEl = this.shadowRoot.querySelector('.thread-select');
      this.newThreadEl = this.shadowRoot.querySelector('.thread-new');
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
          await this.reload({ensureDefaultThread: true});
        }
      });

      this.closeEl.addEventListener('click', () => {
        this.panelEl.classList.remove('open');
      });

      this.threadSelectEl.addEventListener('change', () => {
        this.activeThreadId = this.threadSelectEl.value || null;
        this.stickToBottom = true;
        this.messages = this.getCurrentThreadMessages();
        this.renderMessages();
      });

      this.newThreadEl.addEventListener('click', () => this.createThread());
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

    async reload(options = {}) {
      if (!this.changeNum) return;

      const ensureDefaultThread = Boolean(options.ensureDefaultThread);

      try {
        const state = await api.get(`/a/changes/${this.changeNum}/gerrit-chat~chat`);
        this.stopAssistantStream();
        this.applyState(state, true);

        if (ensureDefaultThread) {
          await this.maybeEnsureDefaultThread();
        }
      } catch (err) {
        this.statusEl.textContent = `Load failed: ${String(err)}`;
      }
    }

    async maybeEnsureDefaultThread() {
      if (this.defaultThreadEnsuredForChange) return;
      this.defaultThreadEnsuredForChange = true;

      const p = normalizePermissions(this.permissions || {});
      if (!p.canWrite) return;
      if (this.threads.length > 0) return;

      try {
        await this.createThreadWithTitle('default', {silent: true, baseThreadId: null});
      } catch (err) {
        this.statusEl.textContent = `Failed to create default thread: ${String(err)}`;
      }
    }

    async createThread() {
      const p = normalizePermissions(this.permissions || {});
      if (!p.canWrite || this.inFlight || this.assistantStream) {
        return;
      }

      const defaultTitle = `Thread ${Math.max(1, this.threads.length + 1)}`;
      const title = window.prompt('New thread title', defaultTitle);
      if (title == null) return;

      const trimmed = title.trim();
      if (!trimmed) {
        this.statusEl.textContent = 'Thread title cannot be empty.';
        return;
      }

      try {
        await this.createThreadWithTitle(trimmed, {silent: false, baseThreadId: this.activeThreadId});
      } catch (err) {
        this.statusEl.textContent = `Create thread failed: ${String(err)}`;
      }
    }

    async createThreadWithTitle(title, options = {}) {
      const silent = Boolean(options.silent);
      const baseThreadId =
        typeof options.baseThreadId === 'undefined' ? this.activeThreadId : options.baseThreadId;

      const state = await api.post(`/a/changes/${this.changeNum}/gerrit-chat~chat`, {
        new_thread_title: title,
        thread_id: baseThreadId,
      });

      this.applyState(state, false);
      if (!silent) {
        this.statusEl.textContent = 'Thread created.';
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
        const state = await api.post(`/a/changes/${this.changeNum}/gerrit-chat~chat`, {
          message: text,
          thread_id: this.activeThreadId,
        });

        this.optimisticUserText = '';
        this.stopProgress();
        this.applyState(state, false);

        const lastAssistant = this.findLastAssistantMessage(this.messages);
        if (lastAssistant && lastAssistant.id && lastAssistant.text) {
          this.startAssistantStream(lastAssistant.id, lastAssistant.text);
        } else {
          this.statusEl.textContent = 'Updated.';
        }
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
      this.progressToolTrail = [];
      this.progressStartedAt = Date.now();

      const firstStep = this.progressSteps[this.progressStepIndex] || 'working';
      this.recordProgressStep(firstStep);
      this.statusEl.textContent = `Working… ${formatProgressStepForStatus(firstStep)}`;

      this.progressTimer = window.setInterval(() => {
        this.progressStepIndex = (this.progressStepIndex + 1) % this.progressSteps.length;
        const step = this.progressSteps[this.progressStepIndex];
        this.recordProgressStep(step);
        this.statusEl.textContent = `Working… ${formatProgressStepForStatus(step)}`;
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

    recordProgressStep(step) {
      if (!step || !String(step).startsWith('tool:')) return;
      if (this.progressToolTrail.includes(step)) return;
      this.progressToolTrail.push(step);
      if (this.progressToolTrail.length > 8) {
        this.progressToolTrail = this.progressToolTrail.slice(-8);
      }
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
        if (this.assistantStream.shown >= total) {
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
          this.assistantStream.shown,
        );
        this.renderMessages();
      };

      tick();
      this.assistantStreamTimer = window.setInterval(tick, 24);
      this.updateComposer();
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

    applyState(rawState, preserveThreadSelection) {
      const state = normalizeState(rawState || {});
      this.permissions = state.permissions;
      this.threads = state.threads;
      this.threadMessagesById = state.threadMessagesById;

      let nextActive = null;
      if (
        preserveThreadSelection &&
        this.activeThreadId &&
        this.threadMessagesById[this.activeThreadId]
      ) {
        nextActive = this.activeThreadId;
      } else if (state.activeThreadId && this.threadMessagesById[state.activeThreadId]) {
        nextActive = state.activeThreadId;
      } else if (state.newestThreadId && this.threadMessagesById[state.newestThreadId]) {
        nextActive = state.newestThreadId;
      }

      this.activeThreadId = nextActive;
      this.messages = this.getCurrentThreadMessages();
      this.renderThreadOptions();
      this.renderMessages();
      this.updateComposer();

      if (!this.hasLoadedStateOnceForChange) {
        this.primeReloadGuardFromCurrentToolMessages();
        this.hasLoadedStateOnceForChange = true;
      } else {
        this.maybeRefreshHostChangeViewFromToolMessages();
      }
    }

    getCurrentThreadMessages() {
      if (!this.activeThreadId) return [];
      return this.threadMessagesById[this.activeThreadId] || [];
    }

    collectAllMessages() {
      const allMessages = [];
      for (const msgs of Object.values(this.threadMessagesById || {})) {
        if (Array.isArray(msgs)) allMessages.push(...msgs);
      }
      return allMessages;
    }

    primeReloadGuardFromCurrentToolMessages() {
      for (const msg of this.collectAllMessages()) {
        if (
          msg &&
          msg.id &&
          msg.role === 'tool' &&
          deriveToolName(msg) === 'post_change_comment'
        ) {
          this.reloadTriggeredByToolMessageIds.add(msg.id);
        }
      }
    }

    maybeRefreshHostChangeViewFromToolMessages() {
      const triggerMessages = this.collectAllMessages().filter(
        msg =>
          msg &&
          msg.id &&
          msg.role === 'tool' &&
          deriveToolName(msg) === 'post_change_comment' &&
          !this.reloadTriggeredByToolMessageIds.has(msg.id),
      );

      if (!triggerMessages.length) return;

      for (const msg of triggerMessages) {
        this.reloadTriggeredByToolMessageIds.add(msg.id);
      }

      this.statusEl.textContent = 'Comment posted. Refreshing change view…';
      window.setTimeout(() => {
        document.dispatchEvent(new CustomEvent('reload'));
      }, 0);
    }

    renderThreadOptions() {
      const previous = this.threadSelectEl.value;
      this.threadSelectEl.textContent = '';

      if (!this.threads.length) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'No threads yet';
        this.threadSelectEl.appendChild(option);
        this.threadSelectEl.value = '';
        return;
      }

      for (const thread of this.threads) {
        const option = document.createElement('option');
        option.value = thread.id;
        const count = Number.isFinite(thread.messageCount) ? thread.messageCount : 0;
        option.textContent = `${thread.title} (${count})`;
        this.threadSelectEl.appendChild(option);
      }

      if (this.activeThreadId && this.threadMessagesById[this.activeThreadId]) {
        this.threadSelectEl.value = this.activeThreadId;
      } else if (previous && this.threadMessagesById[previous]) {
        this.threadSelectEl.value = previous;
        this.activeThreadId = previous;
      } else {
        this.threadSelectEl.selectedIndex = 0;
        this.activeThreadId = this.threadSelectEl.value || null;
      }
    }

    updateComposer() {
      const p = normalizePermissions(this.permissions || {});
      const canWrite = Boolean(p.canWrite);
      const busy = this.inFlight || Boolean(this.assistantStream);

      this.inputEl.disabled = !canWrite || busy;
      this.sendEl.disabled = !canWrite || busy;
      this.threadSelectEl.disabled = busy;
      this.newThreadEl.disabled = !canWrite || busy;

      if (this.inFlight) {
        this.inputEl.placeholder = 'Working…';
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

      this.inputEl.placeholder = this.activeThreadId
        ? 'Ask about this change...'
        : 'Create a thread first, then ask.';
      if (!this.activeThreadId) {
        this.sendEl.disabled = true;
      }
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
        });
      }

      if (!items.length && !this.inFlight) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = this.activeThreadId
          ? 'No messages in this thread yet.'
          : 'No thread selected.';
        this.listEl.appendChild(empty);
        return;
      }

      for (const msg of items) {
        const roleName = msg.role || 'assistant';
        const item = document.createElement('div');
        item.className = `msg ${roleName}`;

        item.appendChild(this.renderAuthorBadge(msg, roleName));

        if (roleName === 'tool') {
          item.appendChild(this.renderToolDetails(msg));
        } else {
          const body = document.createElement('div');
          body.className = 'body';

          if (roleName === 'assistant') {
            body.classList.add('markdown');
            const text = this.getRenderedMessageText(msg);
            body.appendChild(renderMarkdownFragment(text, this.markedReady));
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

    renderAuthorBadge(msg, roleName) {
      const accountId = getAuthorAccountId(msg);
      const authorName = getAuthorName(msg);

      if (roleName === 'user' && accountId) {
        const wrap = document.createElement('div');
        wrap.className = 'role-account';

        const chip = document.createElement('gr-account-chip');
        chip.account = {
          _account_id: accountId,
          name: authorName || undefined,
        };
        chip.showAvatar = true;

        wrap.appendChild(chip);
        return wrap;
      }

      const role = document.createElement('div');
      role.className = 'role';
      role.textContent = authorName || roleName;
      return role;
    }

    renderToolDetails(msg) {
      const details = document.createElement('details');
      details.className = 'tool-details';

      const toolKey = getToolKey(msg);
      details.open = this.openToolIds.has(toolKey);
      details.addEventListener('toggle', () => {
        if (details.open) this.openToolIds.add(toolKey);
        else this.openToolIds.delete(toolKey);
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
      const step = this.progressSteps[this.progressStepIndex] || 'working';
      label.textContent = `Working… ${formatProgressStepForStatus(step)}`;

      row.appendChild(spinner);
      row.appendChild(label);

      const sub = document.createElement('div');
      sub.className = 'pending-sub';
      sub.textContent = `Elapsed ${formatElapsed(Date.now() - this.progressStartedAt)}`;

      const toolsHint = document.createElement('div');
      toolsHint.className = 'pending-tools';
      if (this.progressToolTrail.length) {
        toolsHint.textContent = this.progressToolTrail
          .map(name => `• ${name}`)
          .join('\n');
        toolsHint.style.whiteSpace = 'pre-wrap';
      } else {
        toolsHint.textContent = 'Waiting for first tool call…';
      }

      body.appendChild(row);
      body.appendChild(sub);
      body.appendChild(toolsHint);

      item.appendChild(role);
      item.appendChild(body);
      return item;
    }

    isNearBottom() {
      const threshold = 32;
      return this.listEl.scrollHeight - (this.listEl.scrollTop + this.listEl.clientHeight) <= threshold;
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

  function normalizeState(raw) {
    const permissions = normalizePermissions(raw.permissions || {});
    const threads = Array.isArray(raw.threads)
      ? raw.threads.map(t => ({
          id: t.id,
          title: t.title || 'Thread',
          created: t.created || '',
          updated: t.updated || '',
          messageCount: t.messageCount ?? t.message_count ?? 0,
        }))
      : [];

    const threadMessagesByIdRaw =
      raw.threadMessagesById || raw.thread_messages_by_id || raw.thread_messages || {};

    const threadMessagesById = {};
    if (threadMessagesByIdRaw && typeof threadMessagesByIdRaw === 'object') {
      for (const [id, messages] of Object.entries(threadMessagesByIdRaw)) {
        threadMessagesById[id] = Array.isArray(messages) ? messages : [];
      }
    }

    const activeThreadId = raw.activeThreadId || raw.active_thread_id || null;
    const newestThreadId = threads.length ? threads[0].id : null;

    if (Object.keys(threadMessagesById).length === 0 && Array.isArray(raw.messages)) {
      const fallbackId = activeThreadId || newestThreadId || 'default';
      threadMessagesById[fallbackId] = raw.messages;
    }

    return {
      permissions,
      threads,
      threadMessagesById,
      activeThreadId,
      newestThreadId,
    };
  }

  function getAuthorAccountId(msg) {
    const id = msg && (msg.authorAccountId ?? msg.author_account_id);
    const n = Number(id);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  function getAuthorName(msg) {
    const name = msg && (msg.authorName ?? msg.author_name);
    if (name && String(name).trim()) return String(name).trim();

    const id = getAuthorAccountId(msg);
    if (id) return `a/${id}`;
    return '';
  }

  function deriveToolName(msg) {
    const author = getAuthorName(msg);
    if (author.startsWith('tool:')) return author.slice('tool:'.length);
    return author || 'tool call';
  }

  function getToolKey(msg) {
    if (msg && msg.id) return `id:${msg.id}`;
    return `tool:${deriveToolName(msg)}:${msg && msg.created ? msg.created : ''}`;
  }

  let markedLoadPromise = null;

  function ensureMarkedLoaded() {
    if (window.marked && typeof window.marked.parse === 'function') {
      return Promise.resolve(true);
    }

    if (markedLoadPromise) return markedLoadPromise;

    markedLoadPromise = new Promise(resolve => {
      const existing = document.querySelector('script[data-gchat-marked="1"]');
      if (existing) {
        existing.addEventListener('load', () => resolve(true), {once: true});
        existing.addEventListener('error', () => resolve(false), {once: true});
        return;
      }

      const script = document.createElement('script');
      script.src = '/plugins/gerrit-chat/static/marked.min.js';
      script.async = true;
      script.dataset.gchatMarked = '1';
      script.onload = () => resolve(Boolean(window.marked && window.marked.parse));
      script.onerror = () => resolve(false);
      document.head.appendChild(script);
    });

    return markedLoadPromise;
  }

  function renderMarkdownFragment(text, markedReady) {
    const wrap = document.createElement('div');
    wrap.className = 'md';

    if (markedReady && window.marked && typeof window.marked.parse === 'function') {
      const html = window.marked.parse(text || '', {
        gfm: true,
        breaks: true,
        mangle: false,
        headerIds: false,
      });
      wrap.innerHTML = sanitizeMarkdownHtml(html);
      return wrap;
    }

    wrap.textContent = text || '';
    wrap.style.whiteSpace = 'pre-wrap';
    return wrap;
  }

  function sanitizeMarkdownHtml(html) {
    const template = document.createElement('template');
    template.innerHTML = String(html || '');

    const allowedTags = new Set([
      'A',
      'P',
      'BR',
      'UL',
      'OL',
      'LI',
      'EM',
      'STRONG',
      'CODE',
      'PRE',
      'BLOCKQUOTE',
      'H1',
      'H2',
      'H3',
      'H4',
      'H5',
      'H6',
      'HR',
      'TABLE',
      'THEAD',
      'TBODY',
      'TR',
      'TH',
      'TD',
    ]);

    const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_ELEMENT);
    const toRemove = [];

    while (walker.nextNode()) {
      const el = walker.currentNode;
      if (!allowedTags.has(el.tagName)) {
        toRemove.push(el);
        continue;
      }

      for (const attr of [...el.attributes]) {
        const name = attr.name.toLowerCase();
        if (name.startsWith('on') || name === 'style') {
          el.removeAttribute(attr.name);
          continue;
        }

        if (el.tagName === 'A' && name === 'href') {
          const href = sanitizeUrl(attr.value);
          el.setAttribute('href', href);
          el.setAttribute('target', '_blank');
          el.setAttribute('rel', 'noopener noreferrer');
          continue;
        }

        if (el.tagName !== 'A') {
          el.removeAttribute(attr.name);
        }
      }
    }

    for (const el of toRemove) {
      el.replaceWith(...el.childNodes);
    }

    return template.innerHTML;
  }

  function sanitizeUrl(url) {
    const value = String(url || '').trim();
    if (!value) return '#';
    if (/^(https?:|mailto:|\/)/i.test(value)) return value;
    return '#';
  }

  function formatProgressStepForStatus(step) {
    const raw = String(step || '').trim();
    if (!raw) return 'working';
    if (raw.startsWith('tool:')) return raw;
    return raw;
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
    if (!widget || !document.body.contains(widget)) {
      widget = document.createElement('gchat-widget');
      document.body.appendChild(widget);
    }
    widget.setContext(changeNum);
  }

  function unmount() {
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
