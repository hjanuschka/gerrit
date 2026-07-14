# gerrit-chat plugin

Adds an AI chat panel to Gerrit change pages.

## Build

```bash
cd /path/to/gerrit
bazel build plugins/gerrit-chat:gerrit-chat
```

Jar output:

```bash
bazel-bin/plugins/gerrit-chat/gerrit-chat.jar
```

## Install in local testsite

```bash
cp bazel-bin/plugins/gerrit-chat/gerrit-chat.jar "$GERRIT_SITE/plugins/"
```

## Endpoints

- `GET /changes/{change-id}/gerrit-chat~chat`
  - returns permissions + thread list + newest thread messages
- `POST /changes/{change-id}/gerrit-chat~chat`
  - send message in a thread: `{ "message": "...", "thread_id": "..." }`
  - create thread: `{ "new_thread_title": "My thread" }`
- `GET /changes/{change-id}/gerrit-chat~chat.permissions`

## Access model

- Anonymous users: read-only
- Logged-in non-reviewers: read-only
- Reviewers: read/write
- Change owner: read/write (even if not reviewer)
