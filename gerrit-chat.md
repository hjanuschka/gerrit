# Gerrit AI Chat for Change/Review Screen — Implementation Plan

## Goal
Add an AI chat panel to Gerrit change pages (e.g. `/c/<project>/+/<change>`), backed by a Node.js service (pi-ai), with:

1. Node.js chat service integration
2. Gerrit-aware tools (`get_diff`, `get_file`, ...)
3. Chat history per CL/change
4. Read-only mode for non-logged-in users
5. Write access only for reviewers
6. Gerrit UI style and plugin best practices

---

## High-Level Architecture

- **Frontend:** Gerrit JS plugin mounted on change screen endpoint (`change-view-integration` or dedicated tab endpoints).
- **Gerrit plugin backend (Java):**
  - REST endpoints under `/plugins/gerrit-chat/...`
  - Permission checks against Gerrit ACLs/reviewer state
  - Optional proxy to Node service or direct client->Node call (recommended: proxy through Gerrit plugin)
- **Node.js AI service (pi-ai):**
  - Chat orchestration
  - Tool execution layer
  - LLM/provider integrations
- **Persistence:**
  - Preferred: plugin-owned DB tables (or plugin-owned git ref) keyed by change-id
  - Stores threads/messages/metadata/audit info

---

## Permissions & Access Rules

- Anonymous users:
  - [ ] Can view chat history for visible changes
  - [ ] Cannot post messages or invoke AI actions
- Logged-in non-reviewers:
  - [ ] Can view history
  - [ ] Cannot post (unless explicitly configured)
- Reviewers (or owner/uploader if configured):
  - [ ] Can post messages and trigger tool calls
- Admin/project owner:
  - [ ] Can configure policy (who can write, retention, model/tool limits)

---

## Data Model (Draft)

- `chat_threads`
  - [ ] `id`
  - [ ] `change_num` / `project` / `patchset` scope
  - [ ] `created_by`, `created_at`, `updated_at`
- `chat_messages`
  - [ ] `id`, `thread_id`
  - [ ] `role` (`user`, `assistant`, `tool`)
  - [ ] `author_account_id` (nullable for assistant)
  - [ ] `content` (markdown)
  - [ ] `tool_name`, `tool_payload`, `tool_result` (optional)
  - [ ] `created_at`
- `chat_audit`
  - [ ] request/response metadata, token usage, errors

---

## API Surface (Draft)

### Gerrit plugin REST
- [ ] `GET /plugins/gerrit-chat/changes/{changeNum}/threads`
- [ ] `POST /plugins/gerrit-chat/changes/{changeNum}/threads`
- [ ] `GET /plugins/gerrit-chat/threads/{threadId}/messages`
- [ ] `POST /plugins/gerrit-chat/threads/{threadId}/messages`
- [ ] `POST /plugins/gerrit-chat/threads/{threadId}/ai/respond`
- [ ] `GET /plugins/gerrit-chat/changes/{changeNum}/permissions`

### Node service internal/proxied
- [ ] `POST /chat/respond`
- [ ] `POST /tools/get_diff`
- [ ] `POST /tools/get_file`
- [ ] `POST /tools/search_in_change`
- [ ] `POST /tools/list_changed_files`

---

## Tooling for Gerrit Context (Phase 1)

- [ ] `get_diff(change, patchset, file?, contextLines?)`
- [ ] `get_file(change, patchset, path)`
- [ ] `list_changed_files(change, patchset)`
- [ ] `search_in_change(change, patchset, query)`
- [ ] `get_change_metadata(change)` (owner, reviewers, labels, status)
- [ ] `get_comments(change, patchset)`

Rules:
- [ ] All tool calls enforce caller visibility/permissions
- [ ] Tool execution is scoped to current change by default
- [ ] Add rate limits and max payload sizes

---

## UI/UX Plan (Gerrit-consistent)

- [ ] Use plugin endpoint with full-width panel or dedicated tab
- [ ] Reuse Gerrit typography, spacing, buttons, chips, and theme variables
- [ ] Display:
  - [ ] Thread selector
  - [ ] Message timeline
  - [ ] Tool activity cards (collapsed by default)
  - [ ] Composer with disabled state for read-only users
- [ ] Empty/read-only states:
  - [ ] "Login to interact"
  - [ ] "Only reviewers can chat on this change"
- [ ] Accessibility:
  - [ ] Keyboard navigation
  - [ ] ARIA labels
  - [ ] Sufficient contrast in dark/light themes

---

## Security & Compliance

- [ ] Gerrit auth passthrough (identify user from Gerrit session)
- [ ] CSRF-safe REST usage via Gerrit plugin APIs
- [ ] Input validation + output encoding
- [ ] Secrets only on server side (never in browser)
- [ ] Audit logging for AI/tool calls
- [ ] Configurable data retention and deletion for chat history

---

## Delivery Plan

### Phase 0 — Foundations
- [ ] Create Gerrit plugin skeleton (`plugins/gerrit-chat`)
- [ ] Add frontend mounting on change screen
- [ ] Add backend health/config endpoint

### Phase 1 — Read-only chat history
- [ ] Persist per-change thread/messages
- [ ] Render history for all users with change visibility
- [ ] Read-only composer for anonymous users

### Phase 2 — Reviewer-only posting
- [ ] Permission check endpoint
- [ ] Enforce reviewer-only posting in backend
- [ ] UI gating and clear error messages

### Phase 3 — Node.js (pi-ai) integration
- [ ] Add Node service deployment profile
- [ ] Add Gerrit plugin -> Node proxy client
- [ ] Add `ai/respond` flow with streaming or polling

### Phase 4 — Gerrit tools
- [ ] Implement `get_diff`, `get_file`, `list_changed_files`
- [ ] Add tool call trace in chat timeline
- [ ] Add limits, timeouts, and retries

### Phase 5 — Polish & hardening
- [ ] Style/theme parity with Gerrit UI
- [ ] E2E tests on change screen
- [ ] Load testing + failure mode handling
- [ ] Admin docs and rollout playbook

---

## Open Decisions

- [ ] Storage backend: SQL vs NoteDb/plugin ref
- [ ] Thread scope: per change vs per patchset
- [ ] Whether non-reviewer logged-in users may post (config toggle?)
- [ ] Model/provider defaults and fallback strategy
- [ ] Streaming responses in UI now vs later

---

## Acceptance Criteria (MVP)

- [ ] Chat panel appears on change screen
- [ ] Existing messages shown to all users who can see the change
- [ ] Anonymous users cannot post
- [ ] Only reviewers can post messages
- [ ] AI responses can use `get_diff` and `get_file`
- [ ] Chat history persists per change across page reloads
- [ ] UI matches Gerrit themes and does not break core change view
