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
import java.time.Instant;
import java.util.UUID;

public class ChatMessageInfo {
  public String id;
  public String role;
  public String text;
  public String authorName;
  public Integer authorAccountId;
  public String authorEmail;
  public String authorAvatarUrl;
  public String created;

  public static ChatMessageInfo user(
      Account.Id accountId,
      String authorName,
      String authorEmail,
      String authorAvatarUrl,
      String text) {
    ChatMessageInfo info = base("user", text);
    info.authorName = authorName;
    info.authorAccountId = accountId.get();
    info.authorEmail = authorEmail;
    info.authorAvatarUrl = authorAvatarUrl;
    return info;
  }

  public static ChatMessageInfo assistant(String text) {
    ChatMessageInfo info = base("assistant", text);
    info.authorName = "AI assistant";
    return info;
  }

  public static ChatMessageInfo tool(String toolName, String text) {
    ChatMessageInfo info = base("tool", text);
    info.authorName = "tool:" + toolName;
    return info;
  }

  private static ChatMessageInfo base(String role, String text) {
    ChatMessageInfo info = new ChatMessageInfo();
    info.id = UUID.randomUUID().toString();
    info.role = role;
    info.text = text;
    info.created = Instant.now().toString();
    return info;
  }
}
