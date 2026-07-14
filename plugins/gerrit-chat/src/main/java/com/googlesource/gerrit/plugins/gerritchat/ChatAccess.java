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
import com.google.gerrit.server.change.ChangeResource;
import com.google.gerrit.server.notedb.ReviewerStateInternal;
import java.util.Set;

public final class ChatAccess {
  private ChatAccess() {}

  public static ChatPermissionsInfo getPermissions(ChangeResource resource) {
    ChatPermissionsInfo info = new ChatPermissionsInfo();
    info.loggedIn = resource.getUser().isIdentifiedUser();
    if (!info.loggedIn) {
      info.canWrite = false;
      info.reviewer = false;
      info.writeReason = "Login required. Anonymous users are read-only.";
      return info;
    }

    Account.Id accountId = resource.getUser().asIdentifiedUser().getAccountId();
    Set<Account.Id> reviewers =
        resource.getChangeData().reviewers().byState(ReviewerStateInternal.REVIEWER);
    info.reviewer = reviewers.contains(accountId);
    info.owner = resource.isUserOwner();
    info.canWrite = info.reviewer || info.owner;
    if (!info.canWrite) {
      info.writeReason = "Only reviewers and the change owner can post in chat for this change.";
    }
    return info;
  }
}
