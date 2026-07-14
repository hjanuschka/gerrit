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

import java.util.List;
import java.util.Map;

public class ChatStateInfo {
  public ChatPermissionsInfo permissions;
  public List<ChatThreadInfo> threads;
  public String activeThreadId;
  public List<ChatMessageInfo> messages;
  public Map<String, List<ChatMessageInfo>> threadMessagesById;

  public ChatStateInfo(
      ChatPermissionsInfo permissions,
      List<ChatThreadInfo> threads,
      String activeThreadId,
      List<ChatMessageInfo> messages,
      Map<String, List<ChatMessageInfo>> threadMessagesById) {
    this.permissions = permissions;
    this.threads = threads;
    this.activeThreadId = activeThreadId;
    this.messages = messages;
    this.threadMessagesById = threadMessagesById;
  }
}
