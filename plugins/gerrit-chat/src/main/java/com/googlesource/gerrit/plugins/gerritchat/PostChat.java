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

import com.google.gerrit.entities.Account;
import com.google.gerrit.extensions.restapi.AuthException;
import com.google.gerrit.extensions.restapi.BadRequestException;
import com.google.gerrit.extensions.restapi.Response;
import com.google.gerrit.extensions.restapi.RestModifyView;
import com.google.gerrit.server.IdentifiedUser;
import com.google.gerrit.server.change.ChangeResource;
import com.google.inject.Inject;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

public class PostChat implements RestModifyView<ChangeResource, PostChatInput> {
  private final ChatStore chatStore;
  private final ChatAiClient chatAiClient;

  @Inject
  PostChat(ChatStore chatStore, ChatAiClient chatAiClient) {
    this.chatStore = chatStore;
    this.chatAiClient = chatAiClient;
  }

  @Override
  public Response<ChatStateInfo> apply(ChangeResource resource, PostChatInput input)
      throws AuthException, BadRequestException, IOException {
    ChatPermissionsInfo permissions = ChatAccess.getPermissions(resource);
    if (!permissions.canWrite) {
      throw new AuthException(
          permissions.writeReason != null
              ? permissions.writeReason
              : "Only reviewers or owner can post in chat for this change.");
    }

    String project = resource.getProject().get();
    int changeNumber = resource.getId().get();

    String createThreadTitle = sanitizeOptionalTitle(input != null ? input.newThreadTitle : null);
    ChatStore.ChatSnapshot snapshot = chatStore.readSnapshot(project, changeNumber);

    String activeThreadId = resolveActiveThreadId(snapshot, input != null ? input.threadId : null);
    if (createThreadTitle != null) {
      activeThreadId = chatStore.createThread(project, changeNumber, createThreadTitle);
      snapshot = chatStore.readSnapshot(project, changeNumber);
    }

    String message = sanitizeMessageOrNull(input != null ? input.message : null);
    if (message == null) {
      return Response.ok(buildState(permissions, snapshot, activeThreadId));
    }

    if (activeThreadId == null) {
      activeThreadId = chatStore.createThread(project, changeNumber, "Thread 1");
      snapshot = chatStore.readSnapshot(project, changeNumber);
    }

    List<ChatMessageInfo> history =
        new ArrayList<>(snapshot.threadMessagesById.getOrDefault(activeThreadId, new ArrayList<>()));

    IdentifiedUser identifiedUser = resource.getUser().asIdentifiedUser();
    Account.Id accountId = identifiedUser.getAccountId();
    String authorName = computeDisplayName(identifiedUser);
    String authorEmail = computeAuthorEmail(identifiedUser);
    String authorAvatarUrl = computeGravatarUrl(authorEmail);

    ChatMessageInfo userMessage =
        ChatMessageInfo.user(accountId, authorName, authorEmail, authorAvatarUrl, message);
    history.add(userMessage);

    ChatAiClient.Response aiResponse =
        chatAiClient.respond(
            resource,
            history,
            message,
            activeThreadId,
            accountId.get(),
            authorName);

    if (aiResponse.toolCalls != null) {
      for (ToolCallInfo toolCall : aiResponse.toolCalls) {
        if (toolCall == null || toolCall.name == null || toolCall.summary == null) {
          continue;
        }
        history.add(ChatMessageInfo.tool(toolCall.name, toolCall.summary));
      }
    }
    history.add(ChatMessageInfo.assistant(aiResponse.assistantMessage));

    chatStore.writeMessages(project, changeNumber, activeThreadId, createThreadTitle, history);
    ChatStore.ChatSnapshot latest = chatStore.readSnapshot(project, changeNumber);
    return Response.ok(buildState(permissions, latest, activeThreadId));
  }

  private static ChatStateInfo buildState(
      ChatPermissionsInfo permissions, ChatStore.ChatSnapshot snapshot, String activeThreadId) {
    String threadId = activeThreadId != null ? activeThreadId : snapshot.newestThreadId;
    Map<String, List<ChatMessageInfo>> byId = snapshot.threadMessagesById;
    List<ChatMessageInfo> messages =
        threadId != null ? byId.getOrDefault(threadId, new ArrayList<>()) : new ArrayList<>();

    return new ChatStateInfo(permissions, snapshot.threads, threadId, messages, byId);
  }

  private static String resolveActiveThreadId(ChatStore.ChatSnapshot snapshot, String requestedThreadId) {
    if (requestedThreadId != null
        && !requestedThreadId.isBlank()
        && snapshot.threadMessagesById.containsKey(requestedThreadId)) {
      return requestedThreadId;
    }
    return snapshot.newestThreadId;
  }

  private static String sanitizeOptionalTitle(String title) throws BadRequestException {
    if (title == null) {
      return null;
    }
    String trimmed = title.trim();
    if (trimmed.isEmpty()) {
      throw new BadRequestException("newThreadTitle must not be empty when provided");
    }
    if (trimmed.length() > 120) {
      throw new BadRequestException("newThreadTitle too long (max 120 chars)");
    }
    return trimmed;
  }

  private static String sanitizeMessageOrNull(String message) throws BadRequestException {
    if (message == null) {
      return null;
    }
    String trimmed = message.trim();
    if (trimmed.isEmpty()) {
      return null;
    }
    if (trimmed.length() > 4000) {
      throw new BadRequestException("message too long (max 4000 chars)");
    }
    return trimmed;
  }

  private static String computeDisplayName(IdentifiedUser user) {
    String name = user.getName();
    if (name != null && !name.isBlank()) {
      return name;
    }

    String userName = user.getUserName().orElse(null);
    if (userName != null && !userName.isBlank()) {
      return userName;
    }

    String loggable = user.getLoggableName();
    if (loggable != null && !loggable.isBlank()) {
      return loggable;
    }

    return "a/" + user.getAccountId().get();
  }

  private static String computeAuthorEmail(IdentifiedUser user) {
    String preferredEmail = user.getAccount().preferredEmail();
    if (preferredEmail != null && !preferredEmail.isBlank()) {
      return preferredEmail.trim().toLowerCase();
    }

    String userName = user.getUserName().orElse("user" + user.getAccountId().get());
    return userName.toLowerCase() + "@example.invalid";
  }

  private static String computeGravatarUrl(String email) {
    String normalized = email == null ? "" : email.trim().toLowerCase();
    if (normalized.isBlank()) {
      normalized = "unknown@example.invalid";
    }

    return "https://www.gravatar.com/avatar/"
        + md5Hex(normalized)
        + "?d=identicon&s=64&r=g";
  }

  private static String md5Hex(String input) {
    try {
      MessageDigest md = MessageDigest.getInstance("MD5");
      byte[] digest = md.digest(input.getBytes(StandardCharsets.UTF_8));
      StringBuilder out = new StringBuilder(digest.length * 2);
      for (byte b : digest) {
        out.append(Character.forDigit((b >> 4) & 0xF, 16));
        out.append(Character.forDigit((b & 0xF), 16));
      }
      return out.toString();
    } catch (Exception e) {
      return "00000000000000000000000000000000";
    }
  }
}
