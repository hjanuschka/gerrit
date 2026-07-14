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

import com.google.gerrit.extensions.restapi.Response;
import com.google.gerrit.extensions.restapi.RestReadView;
import com.google.gerrit.server.change.ChangeResource;
import com.google.inject.Inject;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;

public class GetChat implements RestReadView<ChangeResource> {
  private final ChatStore chatStore;

  @Inject
  GetChat(ChatStore chatStore) {
    this.chatStore = chatStore;
  }

  @Override
  public Response<ChatStateInfo> apply(ChangeResource resource) throws IOException {
    ChatPermissionsInfo permissions = ChatAccess.getPermissions(resource);
    ChatStore.ChatSnapshot snapshot =
        chatStore.readSnapshot(resource.getProject().get(), resource.getId().get());

    String activeThreadId = snapshot.newestThreadId;
    List<ChatMessageInfo> messages =
        activeThreadId != null
            ? snapshot.threadMessagesById.getOrDefault(activeThreadId, new ArrayList<>())
            : new ArrayList<>();

    return Response.ok(
        new ChatStateInfo(
            permissions,
            snapshot.threads,
            activeThreadId,
            messages,
            snapshot.threadMessagesById));
  }
}
