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

import com.google.common.flogger.FluentLogger;
import com.google.gerrit.extensions.annotations.PluginName;
import com.google.gerrit.server.change.ChangeResource;
import com.google.gerrit.server.config.PluginConfigFactory;
import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.inject.Inject;
import com.google.inject.Singleton;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

@Singleton
public class ChatAiClient {
  private static final FluentLogger logger = FluentLogger.forEnclosingClass();

  private final PluginConfigFactory pluginConfigFactory;
  private final String pluginName;
  private final HttpClient httpClient;
  private final Gson gson;

  @Inject
  ChatAiClient(PluginConfigFactory pluginConfigFactory, @PluginName String pluginName) {
    this.pluginConfigFactory = pluginConfigFactory;
    this.pluginName = pluginName;
    this.httpClient = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).build();
    this.gson = new GsonBuilder().create();
  }

  public Response respond(
      ChangeResource resource,
      List<ChatMessageInfo> messages,
      String userMessage,
      String threadId,
      Integer senderAccountId,
      String senderName) {
    String serviceUrl =
        pluginConfigFactory
            .getFromGerritConfig(pluginName)
            .getString("nodeUrl", "http://127.0.0.1:8877");

    Map<String, Object> payload = new HashMap<>();
    payload.put("project", resource.getProject().get());
    payload.put("changeNumber", resource.getId().get());
    payload.put("message", userMessage);
    payload.put("history", messages);
    payload.put("threadId", threadId);
    payload.put("senderAccountId", senderAccountId);
    payload.put("senderName", senderName);

    HttpRequest request =
        HttpRequest.newBuilder()
            .uri(URI.create(serviceUrl + "/chat/respond"))
            .header("Content-Type", "application/json")
            .timeout(Duration.ofSeconds(20))
            .POST(HttpRequest.BodyPublishers.ofString(gson.toJson(payload)))
            .build();

    try {
      HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
      if (response.statusCode() >= 200 && response.statusCode() < 300) {
        NodeResponse parsed = gson.fromJson(response.body(), NodeResponse.class);
        if (parsed != null && parsed.assistantMessage != null && !parsed.assistantMessage.isBlank()) {
          Response out = new Response();
          out.assistantMessage = parsed.assistantMessage;
          out.toolCalls = parsed.toolCalls != null ? parsed.toolCalls : new ArrayList<>();
          return out;
        }
      }
      logger.atWarning().log(
          "gerrit-chat node service returned status %d with body: %s",
          response.statusCode(), response.body());
    } catch (Exception e) {
      logger.atWarning().withCause(e).log("gerrit-chat node service call failed");
    }

    Response fallback = new Response();
    fallback.assistantMessage =
        "I couldn't reach the chat service right now. "
            + "Please check the node service configured in [plugin \"gerrit-chat\"] nodeUrl.";
    fallback.toolCalls = new ArrayList<>();
    return fallback;
  }

  public static class Response {
    public String assistantMessage;
    public List<ToolCallInfo> toolCalls;
  }

  private static class NodeResponse {
    String assistantMessage;
    List<ToolCallInfo> toolCalls;
  }
}
