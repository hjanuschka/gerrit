# Gerrit Chat Plugin

Adds an AI chat panel to the change screen.

- Chat history is stored per change.
- Anonymous and non-reviewers are read-only.
- Only reviewers can post.
- AI responses are delegated to an external Node.js service.

REST endpoints are exposed on the change resource as:

- `GET /changes/{change-id}/gerrit-chat~chat`
- `POST /changes/{change-id}/gerrit-chat~chat`
- `GET /changes/{change-id}/gerrit-chat~chat.permissions`
