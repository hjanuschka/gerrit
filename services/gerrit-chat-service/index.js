const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const app = express();
app.use(express.json({limit: '1mb'}));

const PORT = Number(process.env.PORT || 8787);
const GERRIT_BASE_URL = (process.env.GERRIT_BASE_URL || 'http://localhost:8080').replace(/\/$/, '');
const GERRIT_USERNAME = process.env.GERRIT_USERNAME || '';
const GERRIT_PASSWORD = process.env.GERRIT_PASSWORD || '';
const PI_AI_URL = process.env.PI_AI_URL || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5.3-codex';

const CL_SESSION_TTL_MS = Number(process.env.CHAT_SESSION_TTL_MS || 30 * 60 * 1000);
const CHAT_SESSIONS_ROOT = process.env.CHAT_SESSIONS_ROOT || path.join(process.cwd(), '.chat-sessions');

/** @type {Map<string, {key: string, project: string, changeNumber: number, threadId: string, session: any, chain: Promise<any>, lastUsed: number}>} */
const clSessions = new Map();
let runtimeStatePromise;
let piAiModulePromise;
let serviceAccountIdPromise;

app.get('/health', (_req, res) => {
  res.json({ok: true, sessions: clSessions.size});
});

app.post('/chat/respond', async (req, res) => {
  const {
    project,
    changeNumber,
    message,
    history = [],
    threadId,
    senderAccountId,
    senderName,
  } = req.body || {};

  if (!changeNumber) {
    res.status(400).json({error: 'changeNumber is required'});
    return;
  }

  if (!message || !String(message).trim()) {
    res.status(400).json({error: 'message is required'});
    return;
  }

  try {
    const result = await promptInThreadSession({
      project: String(project || ''),
      changeNumber: Number(changeNumber),
      threadId: String(threadId || '_default'),
      message: String(message),
      history,
      senderAccountId: senderAccountId ? Number(senderAccountId) : null,
      senderName: senderName ? String(senderName) : null,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({
      assistantMessage: `Chat service error: ${String(err)}`,
      toolCalls: [],
    });
  }
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`gerrit-chat-service listening on :${PORT}`);
});

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of clSessions.entries()) {
    if (now - entry.lastUsed <= CL_SESSION_TTL_MS) continue;
    try {
      entry.session.dispose();
    } catch {
      // ignored
    }
    clSessions.delete(key);
  }
}, 60_000);

async function promptInThreadSession({
  project,
  changeNumber,
  threadId,
  message,
  history,
  senderAccountId,
  senderName,
}) {
  const files = await listChangedFiles(changeNumber, 'current');

  try {
    const sessionEntry = await getOrCreateThreadSession({
      project,
      changeNumber,
      threadId,
      senderAccountId,
      senderName,
    });
    const sessionResult = await enqueuePrompt(sessionEntry, message);
    return {
      assistantMessage:
        sessionResult.assistantMessage || fallbackAssistantMessage(message, files, changeNumber),
      toolCalls: sessionResult.toolCalls,
    };
  } catch (sessionErr) {
    const assistantMessage =
      (await maybeGenerateWithAi({project, changeNumber, message, history, files})) ||
      fallbackAssistantMessage(message, files, changeNumber);

    return {
      assistantMessage,
      toolCalls: [
        {
          name: 'session_fallback',
          summary: `Used non-session fallback: ${String(sessionErr)}`,
        },
      ],
    };
  }
}

async function getOrCreateThreadSession({project, changeNumber, threadId, senderAccountId, senderName}) {
  const key = `${project || '_'}~${changeNumber}~${threadId || '_default'}`;
  const existing = clSessions.get(key);
  if (existing) {
    existing.lastUsed = Date.now();
    return existing;
  }

  const runtime = await getRuntimeState();
  const {agent, Type, model, authStorage, modelRegistry} = runtime;

  const tools = createGerritTools(Type, {
    project,
    changeNumber,
    senderAccountId,
    senderName,
  });

  const isolatedAgentDir = path.join(CHAT_SESSIONS_ROOT, '.isolated-agent');
  const isolatedCwd = '/gerrit-chat';

  const loader = new agent.DefaultResourceLoader({
    cwd: isolatedCwd,
    agentDir: isolatedAgentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    systemPromptOverride: () => buildSystemPrompt(project, changeNumber, threadId),
  });
  await loader.reload();

  const clSessionDir = path.join(
    CHAT_SESSIONS_ROOT,
    sanitizeForFile(project || '_'),
    String(changeNumber),
    sanitizeForFile(threadId || '_default'),
  );
  fs.mkdirSync(clSessionDir, {recursive: true});

  const clCwd = path.join(
    '/gerrit-chat',
    sanitizeForFile(project || '_'),
    String(changeNumber),
    sanitizeForFile(threadId || '_default'),
  );

  const sessionManager = agent.SessionManager.continueRecent(clCwd, clSessionDir);

  const {session} = await agent.createAgentSession({
    model,
    thinkingLevel: 'low',
    tools: [],
    customTools: tools,
    sessionManager,
    settingsManager: agent.SettingsManager.inMemory({
      compaction: {enabled: true},
      retry: {enabled: true, maxRetries: 2},
      extensions: [],
    }),
    authStorage,
    modelRegistry,
    resourceLoader: loader,
  });

  const entry = {
    key,
    project,
    changeNumber,
    threadId,
    session,
    chain: Promise.resolve(),
    lastUsed: Date.now(),
  };
  clSessions.set(key, entry);
  return entry;
}

async function enqueuePrompt(entry, message) {
  const run = async () => {
    const textParts = [];
    const toolCalls = [];

    const unsubscribe = entry.session.subscribe(event => {
      if (
        event.type === 'message_update' &&
        event.assistantMessageEvent &&
        event.assistantMessageEvent.type === 'text_delta'
      ) {
        textParts.push(event.assistantMessageEvent.delta || '');
      }

      if (event.type === 'tool_execution_end') {
        toolCalls.push({
          name: event.toolName,
          summary: summarizeToolResult(event.result, event.isError),
        });
      }
    });

    try {
      await entry.session.prompt(message);
    } finally {
      unsubscribe();
      entry.lastUsed = Date.now();
    }

    const assistantMessage =
      textParts.join('').trim() || extractLastAssistantText(entry.session.messages || []);

    return {assistantMessage, toolCalls};
  };

  entry.chain = entry.chain.then(run, run);
  return entry.chain;
}

function summarizeToolResult(result, isError) {
  if (!result) return isError ? 'Tool failed.' : 'Tool finished.';

  if (Array.isArray(result.content)) {
    const text = result.content
      .filter(c => c && c.type === 'text' && typeof c.text === 'string')
      .map(c => c.text)
      .join('\n')
      .trim();
    if (text) return truncate(text, 320);
  }

  return truncate(JSON.stringify(result), 320);
}

function extractLastAssistantText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    const text = msg.content
      .filter(c => c && c.type === 'text' && typeof c.text === 'string')
      .map(c => c.text)
      .join('\n')
      .trim();
    if (text) return text;
  }
  return '';
}

function createGerritTools(Type, {project, changeNumber, senderAccountId, senderName}) {
  return [
    {
      name: 'list_changed_files',
      label: 'List Changed Files',
      description: 'List files changed in the current CL.',
      parameters: Type.Object({
        patchset: Type.Optional(Type.String({description: 'Patch set (default: current)'})),
      }),
      execute: async (_id, params = {}) => {
        const files = await listChangedFiles(changeNumber, params.patchset || 'current');
        return {
          content: [{type: 'text', text: files.join('\n') || '(no files)'}],
          details: {},
        };
      },
    },
    {
      name: 'get_diff',
      label: 'Get Diff',
      description: 'Get unified diff metadata for a file in the CL.',
      parameters: Type.Object({
        path: Type.String({description: 'File path'}),
        patchset: Type.Optional(Type.String({description: 'Patch set (default: current)'})),
        context: Type.Optional(Type.Number({description: 'Context lines (default: 3)'})),
      }),
      execute: async (_id, params) => {
        const diff = await getDiff(
          changeNumber,
          params.patchset || 'current',
          params.path,
          params.context || 3,
        );
        return {
          content: [{type: 'text', text: truncate(diff, 12000)}],
          details: {},
        };
      },
    },
    {
      name: 'get_file',
      label: 'Get File',
      description: 'Get file content at patch set revision.',
      parameters: Type.Object({
        path: Type.String({description: 'File path'}),
        patchset: Type.Optional(Type.String({description: 'Patch set (default: current)'})),
      }),
      execute: async (_id, params) => {
        const content = await getFile(changeNumber, params.patchset || 'current', params.path);
        return {
          content: [{type: 'text', text: truncate(content, 12000)}],
          details: {},
        };
      },
    },
    {
      name: 'search_in_change',
      label: 'Search in Change',
      description: 'Search changed file paths by substring (e.g. area name).',
      parameters: Type.Object({
        query: Type.String({description: 'Case-insensitive substring to search in paths'}),
        patchset: Type.Optional(Type.String({description: 'Patch set (default: current)'})),
      }),
      execute: async (_id, params) => {
        const files = await listChangedFiles(changeNumber, params.patchset || 'current');
        const q = String(params.query || '').toLowerCase();
        const matches = files.filter(f => f.toLowerCase().includes(q));
        return {
          content: [
            {
              type: 'text',
              text: matches.length
                ? `Matches for '${params.query}':\n${matches.join('\n')}`
                : `No changed files matched '${params.query}'.`,
            },
          ],
          details: {},
        };
      },
    },
    {
      name: 'get_change_metadata',
      label: 'Get Change Metadata',
      description: 'Get status, owner, labels, reviewers and subject for this CL.',
      parameters: Type.Object({}),
      execute: async () => {
        const metadata = await getChangeMetadata(changeNumber);
        return {
          content: [{type: 'text', text: JSON.stringify(metadata, null, 2)}],
          details: {},
        };
      },
    },
    {
      name: 'search_changes',
      label: 'Search Changes',
      description:
        'Search Gerrit changes by query string (e.g. "project:foo status:open owner:self").',
      parameters: Type.Object({
        query: Type.Optional(Type.String({description: 'Gerrit query expression'})),
        limit: Type.Optional(Type.Number({description: 'Result limit (default: 10, max: 50)'})),
      }),
      execute: async (_id, params = {}) => {
        const limit = clampInt(params.limit, 10, 1, 50);
        const q = params.query && String(params.query).trim()
          ? String(params.query).trim()
          : `project:${project || ''} status:open`;
        const changes = await searchChanges(q, limit);
        return {
          content: [{type: 'text', text: JSON.stringify(changes, null, 2)}],
          details: {},
        };
      },
    },
    {
      name: 'list_change_comments',
      label: 'List Change Comments',
      description: 'List inline comments and change messages for a change.',
      parameters: Type.Object({
        changeNumber: Type.Optional(Type.Number({description: 'Change number (default: current)'})),
      }),
      execute: async (_id, params = {}) => {
        const targetChange = Number(params.changeNumber || changeNumber);
        const comments = await listChangeComments(targetChange);
        return {
          content: [{type: 'text', text: JSON.stringify(comments, null, 2)}],
          details: {},
        };
      },
    },
    {
      name: 'search_change_comments',
      label: 'Search Change Comments',
      description: 'Search inline comments and change messages by text.',
      parameters: Type.Object({
        query: Type.String({description: 'Case-insensitive search text'}),
        changeNumber: Type.Optional(Type.Number({description: 'Change number (default: current)'})),
      }),
      execute: async (_id, params = {}) => {
        const targetChange = Number(params.changeNumber || changeNumber);
        const query = String(params.query || '').trim();
        const matches = await searchChangeComments(targetChange, query);
        return {
          content: [{type: 'text', text: JSON.stringify(matches, null, 2)}],
          details: {},
        };
      },
    },
    {
      name: 'post_change_comment',
      label: 'Post Change Comment',
      description:
        'Post a Gerrit review message or inline comment on the change, optionally on behalf of the chat sender.',
      parameters: Type.Object({
        message: Type.String({description: 'Comment text'}),
        filePath: Type.Optional(Type.String({description: 'Optional file path for inline comment'})),
        line: Type.Optional(Type.Number({description: 'Optional line number for inline comment'})),
        side: Type.Optional(
          Type.String({description: 'Optional side: REVISION or PARENT (default REVISION)'}),
        ),
        inReplyTo: Type.Optional(Type.String({description: 'Optional comment ID to reply to'})),
        unresolved: Type.Optional(Type.Boolean({description: 'Optional unresolved flag'})),
        patchset: Type.Optional(Type.String({description: 'Patch set (default: current)'})),
      }),
      execute: async (_id, params = {}) => {
        const targetPatchset = params.patchset || 'current';
        const result = await postChangeComment(
          changeNumber,
          {
            message: String(params.message || ''),
            filePath: params.filePath ? String(params.filePath) : null,
            line: params.line,
            side: params.side ? String(params.side) : 'REVISION',
            inReplyTo: params.inReplyTo ? String(params.inReplyTo) : null,
            unresolved:
              typeof params.unresolved === 'boolean' ? params.unresolved : undefined,
            patchset: targetPatchset,
          },
          senderAccountId,
        );

        const poster = result.postedAs || (result.usedOnBehalfOf
          ? senderAccountId && senderName
            ? `${senderName} (${senderAccountId})`
            : senderAccountId
              ? `account ${senderAccountId}`
              : 'service user'
          : 'service user');

        const notes = [];
        if (result.usedOnBehalfOf && result.fallbackToServiceUser) {
          notes.push('On-behalf-of posting was rejected; posted as service user instead.');
        }

        return {
          content: [
            {
              type: 'text',
              text:
                `Posted comment as ${poster}.` +
                (notes.length ? `\n${notes.join('\n')}` : '') +
                `\n${JSON.stringify(result, null, 2)}`,
            },
          ],
          details: {},
        };
      },
    },
  ];
}

function buildSystemPrompt(project, changeNumber, threadId) {
  return [
    'You are an AI assistant embedded in Gerrit change view.',
    `Project: ${project || '(unknown)'}`,
    `Change: ${changeNumber}`,
    `Thread: ${threadId || '_default'}`,
    'You are in a persistent per-thread conversation.',
    'You may ONLY use Gerrit tools provided in this session. Do not mention or use any external or local ~/.pi tools.',
    'Prefer tool-based answers over assumptions.',
    'If asked whether area/path is touched, use search_in_change and list explicit file names.',
    'If asked to add comments, use post_change_comment and summarize exactly what you posted.',
    'Be concise and practical for reviewers.',
  ].join('\n');
}

function fallbackAssistantMessage(message, files, changeNumber) {
  if (/touch|area|impact|affected/i.test(message)) {
    return [
      `I inspected change ${changeNumber}.`,
      files.length
        ? `It touches ${files.length} file(s): ${files.join(', ')}.`
        : 'I could not find changed files.',
      'Ask about a concrete area, path prefix, or request a diff preview.',
    ].join(' ');
  }

  return [
    `I reviewed change ${changeNumber}.`,
    files.length
      ? `Changed files: ${files.join(', ')}.`
      : 'No changed files were detected.',
    'I can use tools like get_diff, get_file, list_changed_files, and comments tools for deeper analysis.',
  ].join(' ');
}

async function maybeGenerateWithAi(context) {
  if (PI_AI_URL) {
    const text = await maybeGenerateWithPiAiHttp(context);
    if (text) return text;
  }

  if (OPENAI_API_KEY) {
    return maybeGenerateWithPiAiSdk(context);
  }

  return null;
}

async function maybeGenerateWithPiAiHttp(context) {
  const prompt = buildPrompt(context);

  const resp = await fetch(PI_AI_URL, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({prompt, context}),
  });

  if (!resp.ok) {
    throw new Error(`PI_AI_URL returned HTTP ${resp.status}`);
  }

  const data = await resp.json();
  return data.assistantMessage || data.text || null;
}

async function maybeGenerateWithPiAiSdk(context) {
  const {complete, getModel} = await loadPiAiModule();
  const requestedModel = OPENAI_MODEL;
  const normalizedModel = normalizeOpenAiModelId(requestedModel);
  const model = getModel('openai', normalizedModel);

  if (!model) {
    throw new Error(
      `pi-ai model openai/${normalizedModel} not found (requested OPENAI_MODEL=${requestedModel})`,
    );
  }

  const response = await complete(
    model,
    {
      systemPrompt:
        'You are an expert Gerrit code review assistant. Keep answers concise and evidence-based from the change context.',
      messages: [
        {
          role: 'user',
          content: [{type: 'text', text: buildPrompt(context)}],
          timestamp: Date.now(),
        },
      ],
    },
    {
      apiKey: OPENAI_API_KEY,
      reasoningEffort: 'high',
    },
  );

  const text = (response.content || [])
    .filter(c => c && c.type === 'text' && typeof c.text === 'string')
    .map(c => c.text)
    .join('\n')
    .trim();

  return text || null;
}

function buildPrompt(context) {
  const history = (context.history || [])
    .slice(-12)
    .map(m => `[${m.role || 'message'}] ${m.text || ''}`)
    .join('\n');

  return [
    'Analyze this Gerrit change and answer the user question.',
    `Change: ${context.changeNumber}`,
    `Project: ${context.project || '(unknown)'}`,
    `Files: ${context.files.join(', ') || '(none)'}`,
    'Recent chat history:',
    history || '(none)',
    `User message: ${context.message}`,
    'If asked about area/path impact, explicitly list matching files.',
  ].join('\n');
}

async function getRuntimeState() {
  if (!runtimeStatePromise) {
    runtimeStatePromise = (async () => {
      const [agent, ai, typebox] = await Promise.all([
        import('@mariozechner/pi-coding-agent'),
        import('@mariozechner/pi-ai'),
        import('@sinclair/typebox'),
      ]);

      const authStorage = new agent.AuthStorage();
      if (OPENAI_API_KEY) {
        authStorage.setRuntimeApiKey('openai', OPENAI_API_KEY);
      }

      const modelRegistry = new agent.ModelRegistry(authStorage);
      const normalizedModel = normalizeOpenAiModelId(OPENAI_MODEL);
      const model = modelRegistry.find('openai', normalizedModel) || ai.getModel('openai', normalizedModel);

      if (!model) {
        throw new Error(`Unable to resolve model openai/${normalizedModel}`);
      }

      let resolvedApiKey = OPENAI_API_KEY;
      if (!resolvedApiKey && typeof modelRegistry.getApiKeyForProvider === 'function') {
        resolvedApiKey = await modelRegistry.getApiKeyForProvider('openai');
      }
      if (!resolvedApiKey) {
        throw new Error('No OpenAI API key available (set OPENAI_API_KEY)');
      }

      return {
        agent,
        ai,
        Type: typebox.Type,
        authStorage,
        modelRegistry,
        model,
      };
    })();
  }

  return runtimeStatePromise;
}

async function loadPiAiModule() {
  if (!piAiModulePromise) {
    piAiModulePromise = import('@mariozechner/pi-ai');
  }
  return piAiModulePromise;
}

function normalizeOpenAiModelId(modelId) {
  if (modelId === 'gpt-5.3-codex') return 'gpt-5-codex';
  return modelId;
}

function sanitizeForFile(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, '_');
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

async function listChangedFiles(changeNumber, patchset = 'current') {
  const json = await gerritGet(
    `/changes/${encodeURIComponent(changeNumber)}/revisions/${encodeURIComponent(patchset)}/files`,
  );
  return Object.keys(json || {}).filter(name => name !== '/COMMIT_MSG');
}

async function getDiff(changeNumber, patchset, path, context = 3) {
  if (!path) throw new Error('path is required for get_diff');
  const encodedPath = encodeURIComponent(path);
  const json = await gerritGet(
    `/changes/${encodeURIComponent(changeNumber)}/revisions/${encodeURIComponent(
      patchset,
    )}/files/${encodedPath}/diff?context=${encodeURIComponent(context)}`,
  );
  return JSON.stringify(json, null, 2);
}

async function getFile(changeNumber, patchset, path) {
  if (!path) throw new Error('path is required for get_file');
  const encodedPath = encodeURIComponent(path);
  const body = await gerritGetRaw(
    `/changes/${encodeURIComponent(changeNumber)}/revisions/${encodeURIComponent(
      patchset,
    )}/files/${encodedPath}/content`,
  );
  const normalized = body.replace(/\n/g, '');
  return Buffer.from(normalized, 'base64').toString('utf8');
}

async function getChangeMetadata(changeNumber) {
  return gerritGet(`/changes/${encodeURIComponent(changeNumber)}/detail`);
}

async function searchChanges(query, limit = 10) {
  const path = `/changes/?q=${encodeURIComponent(query)}&n=${encodeURIComponent(limit)}&o=DETAILED_ACCOUNTS`;
  const result = await gerritGet(path);

  return (result || []).map(change => ({
    id: change.id,
    changeNumber: change._number,
    project: change.project,
    branch: change.branch,
    subject: change.subject,
    status: change.status,
    owner: change.owner ? change.owner.name || change.owner.username : null,
    updated: change.updated,
    url: `/c/${change.project}/+/${change._number}`,
  }));
}

async function listChangeComments(changeNumber) {
  const [inlineByPath, messages] = await Promise.all([
    gerritGet(`/changes/${encodeURIComponent(changeNumber)}/comments`),
    gerritGet(`/changes/${encodeURIComponent(changeNumber)}/messages`),
  ]);

  const inline = [];
  for (const [filePath, comments] of Object.entries(inlineByPath || {})) {
    if (!Array.isArray(comments)) continue;
    for (const c of comments) {
      inline.push({
        id: c.id,
        filePath,
        patchSet: c.patch_set,
        line: c.line,
        side: c.side,
        inReplyTo: c.in_reply_to,
        unresolved: c.unresolved,
        author: c.author ? c.author.name || c.author.username : null,
        updated: c.updated,
        message: c.message,
      });
    }
  }

  const changeMessages = (messages || []).map(m => ({
    id: m.id,
    author: m.author ? m.author.name || m.author.username : null,
    realAuthor: m.real_author ? m.real_author.name || m.real_author.username : null,
    date: m.date,
    tag: m.tag,
    message: m.message,
  }));

  return {changeNumber, inline, changeMessages};
}

async function searchChangeComments(changeNumber, query) {
  if (!query || !query.trim()) {
    throw new Error('query is required');
  }
  const q = query.toLowerCase();
  const comments = await listChangeComments(changeNumber);

  return {
    changeNumber,
    inline: comments.inline.filter(c => String(c.message || '').toLowerCase().includes(q)),
    changeMessages: comments.changeMessages.filter(c =>
      String(c.message || '').toLowerCase().includes(q),
    ),
  };
}

async function postChangeComment(changeNumber, input, senderAccountId) {
  const patchset = input.patchset || 'current';
  const message = String(input.message || '').trim();
  if (!message) {
    throw new Error('message is required');
  }

  const reviewPath = `/changes/${encodeURIComponent(changeNumber)}/revisions/${encodeURIComponent(patchset)}/review`;
  const serviceAccountId = await getServiceAccountId();

  const baseReviewInput = {
    tag: 'autogenerated:gerrit-chat',
    notify: 'OWNER_REVIEWERS',
  };

  if (input.filePath) {
    const comment = {message};

    if (typeof input.line !== 'undefined' && input.line !== null) {
      const line = Number(input.line);
      if (!Number.isFinite(line) || line <= 0) {
        throw new Error('line must be a positive integer when provided');
      }
      comment.line = Math.floor(line);
    }

    if (input.side) {
      const side = String(input.side).toUpperCase();
      if (side !== 'REVISION' && side !== 'PARENT') {
        throw new Error('side must be REVISION or PARENT');
      }
      comment.side = side;
    }

    if (input.inReplyTo) {
      comment.in_reply_to = String(input.inReplyTo);
    }

    if (typeof input.unresolved === 'boolean') {
      comment.unresolved = input.unresolved;
    }

    baseReviewInput.comments = {
      [String(input.filePath)]: [comment],
    };
  } else {
    baseReviewInput.message = message;
  }

  const canPostOnBehalfOf =
    senderAccountId &&
    Number.isFinite(senderAccountId) &&
    senderAccountId > 0 &&
    (!serviceAccountId || senderAccountId !== serviceAccountId);

  if (!canPostOnBehalfOf) {
    const result = await gerritPost(reviewPath, baseReviewInput);
    return {
      postedAs: 'service user',
      usedOnBehalfOf: false,
      fallbackToServiceUser: false,
      result,
    };
  }

  const withOnBehalf = {
    ...baseReviewInput,
    on_behalf_of: senderAccountId,
  };

  try {
    const result = await gerritPost(reviewPath, withOnBehalf);
    return {
      postedAs: `account ${senderAccountId}`,
      usedOnBehalfOf: true,
      fallbackToServiceUser: false,
      result,
    };
  } catch (err) {
    if (!isOnBehalfPermissionError(err)) {
      throw err;
    }

    const result = await gerritPost(reviewPath, baseReviewInput);
    return {
      postedAs: 'service user',
      usedOnBehalfOf: true,
      fallbackToServiceUser: true,
      error: String(err),
      result,
    };
  }
}

function isOnBehalfPermissionError(err) {
  const msg = String(err || '').toLowerCase();
  return (
    msg.includes('on behalf of') ||
    msg.includes('on_behalf_of') ||
    msg.includes('label required to post review')
  );
}

async function getServiceAccountId() {
  if (!serviceAccountIdPromise) {
    serviceAccountIdPromise = (async () => {
      try {
        const self = await gerritGet('/accounts/self');
        const id = Number(self && self._account_id);
        return Number.isFinite(id) && id > 0 ? id : null;
      } catch {
        return null;
      }
    })();
  }
  return serviceAccountIdPromise;
}

async function gerritGet(path) {
  const body = await gerritGetRaw(path);
  return JSON.parse(body || '{}');
}

async function gerritGetRaw(path) {
  const headers = authHeaders();
  const resp = await fetch(`${GERRIT_BASE_URL}/a${path}`, {headers});
  if (!resp.ok) {
    throw new Error(`Gerrit API ${path} returned HTTP ${resp.status}`);
  }
  const text = await resp.text();
  return stripGerritMagic(text);
}

async function gerritPost(path, payload) {
  const headers = {
    'Content-Type': 'application/json',
    ...authHeaders(),
  };

  const resp = await fetch(`${GERRIT_BASE_URL}/a${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Gerrit API ${path} returned HTTP ${resp.status}: ${stripGerritMagic(errText)}`);
  }

  const text = await resp.text();
  const normalized = stripGerritMagic(text).trim();
  if (!normalized) return {ok: true};

  try {
    return JSON.parse(normalized);
  } catch {
    return {ok: true, raw: normalized};
  }
}

function authHeaders() {
  const headers = {};
  if (GERRIT_USERNAME && GERRIT_PASSWORD) {
    const token = Buffer.from(`${GERRIT_USERNAME}:${GERRIT_PASSWORD}`).toString('base64');
    headers.Authorization = `Basic ${token}`;
  }
  return headers;
}

function stripGerritMagic(text) {
  return String(text || '').replace(/^\)\]\}'\n?/, '');
}

function truncate(str, maxLen) {
  if (!str || str.length <= maxLen) return str;
  return `${str.slice(0, maxLen)}...`;
}
