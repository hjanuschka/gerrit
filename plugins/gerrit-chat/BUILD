load("//tools/bzl:plugin.bzl", "gerrit_plugin")

gerrit_plugin(
    name = "gerrit-chat",
    srcs = glob(["src/main/java/**/*.java"]),
    manifest_entries = [
        "Gerrit-PluginName: gerrit-chat",
        "Gerrit-Module: com.googlesource.gerrit.plugins.gerritchat.PluginModule",
        "Implementation-Title: Gerrit AI Chat plugin",
    ],
    resources = glob(["src/main/resources/**/*"]),
)
