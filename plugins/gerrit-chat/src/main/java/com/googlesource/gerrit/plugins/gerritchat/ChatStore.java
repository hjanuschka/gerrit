// Copyright (C) 2026 The Android Open Source Project
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

package com.googlesource.gerrit.plugins.gerritchat;

import com.google.gerrit.extensions.annotations.PluginData;
import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.inject.Inject;
import com.google.inject.Singleton;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;

@Singleton
public class ChatStore {
  private final Path dataDir;
  private final Gson gson;

  @Inject
  ChatStore(@PluginData Path pluginData) {
    this.dataDir = pluginData.resolve("chat-history");
    this.gson = new GsonBuilder().setPrettyPrinting().create();
  }

  public synchronized ChatSnapshot readSnapshot(String projectName, int changeNumber) throws IOException {
    StoredChat chat = read(projectName, changeNumber);

    List<StoredThread> sorted = new ArrayList<>(chat.threads);
    sorted.sort(Comparator.comparing(ChatStore::safeInstant).reversed());

    List<ChatThreadInfo> threads = new ArrayList<>();
    Map<String, List<ChatMessageInfo>> threadMessagesById = new LinkedHashMap<>();
    for (StoredThread thread : sorted) {
      ChatThreadInfo info = new ChatThreadInfo();
      info.id = thread.id;
      info.title = thread.title;
      info.created = thread.created;
      info.updated = thread.updated;
      info.messageCount = thread.messages.size();
      threads.add(info);
      threadMessagesById.put(thread.id, new ArrayList<>(thread.messages));
    }

    String newestThreadId = threads.isEmpty() ? null : threads.get(0).id;
    return new ChatSnapshot(threads, threadMessagesById, newestThreadId);
  }

  public synchronized String createThread(String projectName, int changeNumber, String requestedTitle)
      throws IOException {
    StoredChat chat = read(projectName, changeNumber);
    StoredThread created = newThread(chat, requestedTitle);
    writeStored(projectName, changeNumber, chat);
    return created.id;
  }

  public synchronized List<ChatMessageInfo> readMessages(
      String projectName, int changeNumber, String threadId) throws IOException {
    StoredChat chat = read(projectName, changeNumber);
    StoredThread thread = getThread(chat, threadId);
    if (thread == null) {
      return new ArrayList<>();
    }
    return new ArrayList<>(thread.messages);
  }

  public synchronized void writeMessages(
      String projectName,
      int changeNumber,
      String threadId,
      String threadTitleIfNew,
      List<ChatMessageInfo> messages)
      throws IOException {
    StoredChat chat = read(projectName, changeNumber);
    StoredThread thread = getThread(chat, threadId);
    if (thread == null) {
      thread = newThread(chat, threadTitleIfNew);
      if (threadId != null && !threadId.isBlank()) {
        thread.id = threadId;
      }
    }

    thread.messages = new ArrayList<>(messages);
    thread.updated = Instant.now().toString();

    writeStored(projectName, changeNumber, chat);
  }

  private StoredChat read(String projectName, int changeNumber) throws IOException {
    Path path = historyPath(projectName, changeNumber);
    if (!Files.exists(path)) {
      StoredChat empty = new StoredChat();
      empty.project = projectName;
      empty.changeNumber = changeNumber;
      empty.threads = new ArrayList<>();
      return empty;
    }

    String json = Files.readString(path, StandardCharsets.UTF_8);
    StoredChat chat = gson.fromJson(json, StoredChat.class);
    if (chat == null) {
      chat = new StoredChat();
    }
    if (chat.project == null) {
      chat.project = projectName;
    }
    chat.changeNumber = changeNumber;

    migrateLegacy(chat);
    normalize(chat);
    return chat;
  }

  private void migrateLegacy(StoredChat chat) {
    if (chat.threads != null && !chat.threads.isEmpty()) {
      return;
    }
    if (chat.messages == null || chat.messages.isEmpty()) {
      chat.threads = new ArrayList<>();
      return;
    }

    StoredThread thread = new StoredThread();
    thread.id = "legacy";
    thread.title = "General";
    thread.created = firstNonBlankTimestamp(chat.messages);
    thread.updated = lastNonBlankTimestamp(chat.messages);
    thread.messages = new ArrayList<>(chat.messages);

    chat.threads = new ArrayList<>();
    chat.threads.add(thread);
    chat.messages = null;
  }

  private void normalize(StoredChat chat) {
    if (chat.threads == null) {
      chat.threads = new ArrayList<>();
    }

    for (StoredThread thread : chat.threads) {
      if (thread.id == null || thread.id.isBlank()) {
        thread.id = UUID.randomUUID().toString();
      }
      if (thread.title == null || thread.title.isBlank()) {
        thread.title = "Thread";
      }
      if (thread.messages == null) {
        thread.messages = new ArrayList<>();
      }
      if (thread.created == null || thread.created.isBlank()) {
        thread.created = firstNonBlankTimestamp(thread.messages);
      }
      if (thread.updated == null || thread.updated.isBlank()) {
        thread.updated = lastNonBlankTimestamp(thread.messages);
      }
    }

    chat.threads.removeIf(Objects::isNull);
  }

  private StoredThread newThread(StoredChat chat, String requestedTitle) {
    StoredThread thread = new StoredThread();
    thread.id = UUID.randomUUID().toString();
    thread.title = sanitizeThreadTitle(requestedTitle, chat.threads.size() + 1);
    thread.created = Instant.now().toString();
    thread.updated = thread.created;
    thread.messages = new ArrayList<>();
    chat.threads.add(thread);
    return thread;
  }

  private StoredThread getThread(StoredChat chat, String threadId) {
    if (threadId == null || threadId.isBlank()) {
      return newestThread(chat);
    }

    for (StoredThread thread : chat.threads) {
      if (threadId.equals(thread.id)) {
        return thread;
      }
    }
    return newestThread(chat);
  }

  private static StoredThread newestThread(StoredChat chat) {
    return chat.threads.stream().max(Comparator.comparing(ChatStore::safeInstant)).orElse(null);
  }

  private static Instant safeInstant(StoredThread thread) {
    try {
      return Instant.parse(thread.updated);
    } catch (Exception ignored) {
      return Instant.EPOCH;
    }
  }

  private static String firstNonBlankTimestamp(List<ChatMessageInfo> messages) {
    for (ChatMessageInfo msg : messages) {
      if (msg != null && msg.created != null && !msg.created.isBlank()) {
        return msg.created;
      }
    }
    return Instant.now().toString();
  }

  private static String lastNonBlankTimestamp(List<ChatMessageInfo> messages) {
    for (int i = messages.size() - 1; i >= 0; i--) {
      ChatMessageInfo msg = messages.get(i);
      if (msg != null && msg.created != null && !msg.created.isBlank()) {
        return msg.created;
      }
    }
    return Instant.now().toString();
  }

  private static String sanitizeThreadTitle(String requestedTitle, int fallbackIndex) {
    if (requestedTitle == null) {
      return "Thread " + fallbackIndex;
    }
    String trimmed = requestedTitle.trim();
    if (trimmed.isEmpty()) {
      return "Thread " + fallbackIndex;
    }
    if (trimmed.length() > 120) {
      return trimmed.substring(0, 120);
    }
    return trimmed;
  }

  private void writeStored(String projectName, int changeNumber, StoredChat chat) throws IOException {
    Files.createDirectories(dataDir);
    Path path = historyPath(projectName, changeNumber);
    Files.writeString(path, gson.toJson(chat), StandardCharsets.UTF_8);
  }

  private Path historyPath(String projectName, int changeNumber) {
    String safeProject = projectName.replace('/', '_');
    return dataDir.resolve(safeProject + "~" + changeNumber + ".json");
  }

  public static class ChatSnapshot {
    public final List<ChatThreadInfo> threads;
    public final Map<String, List<ChatMessageInfo>> threadMessagesById;
    public final String newestThreadId;

    ChatSnapshot(
        List<ChatThreadInfo> threads,
        Map<String, List<ChatMessageInfo>> threadMessagesById,
        String newestThreadId) {
      this.threads = threads;
      this.threadMessagesById = threadMessagesById;
      this.newestThreadId = newestThreadId;
    }
  }

  private static class StoredChat {
    String project;
    int changeNumber;
    List<StoredThread> threads;

    // Legacy single-thread schema support.
    List<ChatMessageInfo> messages;
  }

  private static class StoredThread {
    String id;
    String title;
    String created;
    String updated;
    List<ChatMessageInfo> messages;
  }
}
