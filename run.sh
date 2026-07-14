#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

if ! command -v bazel >/dev/null 2>&1; then
  echo "Error: bazel is not installed or not in PATH."
  echo "Install Bazelisk (recommended) or Bazel, then re-run ./run.sh"
  exit 1
fi

export GERRIT_SITE="${GERRIT_SITE:-$HOME/gerrit_testsite}"

echo "[1/6] Syncing submodules..."
git submodule update --init --recursive

echo "[2/6] Building Gerrit (bazel build release)..."
bazel build release

if [[ -f "bazel-bin/gerrit.war" ]]; then
  WAR_FILE="bazel-bin/gerrit.war"
elif [[ -f "bazel-bin/release.war" ]]; then
  WAR_FILE="bazel-bin/release.war"
else
  echo "Error: Could not find built WAR file in bazel-bin/."
  exit 1
fi

HOMEBREW_JAVA_BIN="/opt/homebrew/opt/openjdk/bin/java"
LEGACY_JAVA_BIN="$(bazel info output_base)/external/local_jdk/bin/java"
JAVA_HOME_BIN="$(bazel info java-home)/bin/java"

if [[ -x "$HOMEBREW_JAVA_BIN" ]]; then
  JAVA_BIN="$HOMEBREW_JAVA_BIN"
elif [[ -x "$LEGACY_JAVA_BIN" ]]; then
  JAVA_BIN="$LEGACY_JAVA_BIN"
elif [[ -x "$JAVA_HOME_BIN" ]]; then
  JAVA_BIN="$JAVA_HOME_BIN"
else
  echo "Error: Could not find a Java binary."
  echo "Checked:"
  echo "  - $HOMEBREW_JAVA_BIN"
  echo "  - $LEGACY_JAVA_BIN"
  echo "  - $JAVA_HOME_BIN"
  exit 1
fi

echo "Using Java: $JAVA_BIN"

CHAT_PID=""
cleanup() {
  if [[ -n "${CHAT_PID:-}" ]] && kill -0 "$CHAT_PID" >/dev/null 2>&1; then
    echo "Stopping gerrit-chat-service (pid=$CHAT_PID)..."
    kill "$CHAT_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

if [[ ! -x "$GERRIT_SITE/bin/gerrit.sh" ]]; then
  echo "[3/6] Initializing dev site at $GERRIT_SITE ..."
  "$JAVA_BIN" -jar "$WAR_FILE" init --batch --dev -d "$GERRIT_SITE"
  echo "Stopping auto-started daemon after init..."
  "$GERRIT_SITE/bin/gerrit.sh" stop || true
else
  echo "[3/6] Reusing existing site at $GERRIT_SITE"
fi

if [[ "${START_GERRIT_CHAT_PLUGIN:-1}" == "1" ]]; then
  if [[ -d "$ROOT_DIR/plugins/gerrit-chat" ]]; then
    echo "[4/6] Building and installing gerrit-chat plugin..."
    bazel build plugins/gerrit-chat:gerrit-chat
    mkdir -p "$GERRIT_SITE/plugins"
    cp "$ROOT_DIR/bazel-bin/plugins/gerrit-chat/gerrit-chat.jar" "$GERRIT_SITE/plugins/gerrit-chat.jar"
    echo "Installed $GERRIT_SITE/plugins/gerrit-chat.jar"
  else
    echo "[4/6] Skipping gerrit-chat plugin install (plugins/gerrit-chat not found)"
  fi
else
  echo "[4/6] Skipping gerrit-chat plugin build/install (START_GERRIT_CHAT_PLUGIN=0)"
fi

is_port_in_use() {
  local port="$1"
  lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
}

pick_free_port() {
  local start_port="$1"
  local p="$start_port"
  while is_port_in_use "$p"; do
    p=$((p + 1))
  done
  echo "$p"
}

CHAT_SERVICE_PORT="${GERRIT_CHAT_SERVICE_PORT:-8877}"
CHAT_SERVICE_PORT="$(pick_free_port "$CHAT_SERVICE_PORT")"
CHAT_NODE_URL="${GERRIT_CHAT_NODE_URL:-http://127.0.0.1:$CHAT_SERVICE_PORT}"

mkdir -p "$GERRIT_SITE/etc"
git config -f "$GERRIT_SITE/etc/gerrit.config" plugin.gerrit-chat.nodeUrl "$CHAT_NODE_URL"
echo "Configured plugin.gerrit-chat.nodeUrl=$CHAT_NODE_URL"

if [[ "${START_GERRIT_CHAT_SERVICE:-1}" == "1" ]]; then
  CHAT_SERVICE_DIR="$ROOT_DIR/services/gerrit-chat-service"
  if [[ -f "$CHAT_SERVICE_DIR/package.json" ]]; then
    if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
      echo "Warning: node/npm not found. Skipping gerrit-chat-service startup."
    else
      echo "[5/6] Starting gerrit-chat-service..."
      if [[ ! -d "$CHAT_SERVICE_DIR/node_modules" ]]; then
        echo "Installing gerrit-chat-service dependencies..."
        (cd "$CHAT_SERVICE_DIR" && npm install)
      fi

      CHAT_GERRIT_URL="${GERRIT_CHAT_GERRIT_URL:-http://localhost:8080}"
      CHAT_GERRIT_USERNAME="${GERRIT_CHAT_GERRIT_USERNAME:-admin}"
      CHAT_GERRIT_PASSWORD="${GERRIT_CHAT_GERRIT_PASSWORD:-secret}"
      CHAT_PI_AI_URL="${GERRIT_CHAT_PI_AI_URL:-}"
      CHAT_OPENAI_API_KEY="${OPENAI_API_KEY:-${GERRIT_CHAT_OPENAI_API_KEY:-}}"
      CHAT_OPENAI_MODEL="${GERRIT_CHAT_OPENAI_MODEL:-gpt-5.3-codex}"
      CHAT_SESSIONS_ROOT="${GERRIT_CHAT_SESSIONS_ROOT:-$GERRIT_SITE/chat-sessions}"

      mkdir -p "$GERRIT_SITE/logs"
      (
        cd "$CHAT_SERVICE_DIR"
        PORT="$CHAT_SERVICE_PORT" \
          GERRIT_BASE_URL="$CHAT_GERRIT_URL" \
          GERRIT_USERNAME="$CHAT_GERRIT_USERNAME" \
          GERRIT_PASSWORD="$CHAT_GERRIT_PASSWORD" \
          PI_AI_URL="$CHAT_PI_AI_URL" \
          OPENAI_API_KEY="$CHAT_OPENAI_API_KEY" \
          OPENAI_MODEL="$CHAT_OPENAI_MODEL" \
          CHAT_SESSIONS_ROOT="$CHAT_SESSIONS_ROOT" \
          node index.js
      ) >"$GERRIT_SITE/logs/gerrit-chat-service.log" 2>&1 &
      CHAT_PID=$!
      echo "gerrit-chat-service started on :$CHAT_SERVICE_PORT (pid=$CHAT_PID)"

      if command -v curl >/dev/null 2>&1; then
        CHAT_HEALTH_OK=0
        for _ in 1 2 3 4 5; do
          if curl -sf "$CHAT_NODE_URL/health" >/dev/null 2>&1; then
            CHAT_HEALTH_OK=1
            break
          fi
          sleep 0.4
        done
        if [[ "$CHAT_HEALTH_OK" != "1" ]]; then
          echo "Warning: gerrit-chat-service health check failed at $CHAT_NODE_URL/health"
          echo "Check logs: $GERRIT_SITE/logs/gerrit-chat-service.log"
        fi
      fi
    fi
  else
    echo "Warning: $CHAT_SERVICE_DIR/package.json not found. Skipping gerrit-chat-service startup."
  fi
else
  echo "[5/6] Skipping gerrit-chat-service startup (START_GERRIT_CHAT_SERVICE=0)"
fi

echo "[6/6] Starting Gerrit in foreground (Ctrl+C to stop)..."
"$JAVA_BIN" -jar "$WAR_FILE" daemon -d "$GERRIT_SITE" --console-log
