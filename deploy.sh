#!/usr/bin/env bash
set -euo pipefail

APP_NAME="we-term"
SERVICE_NAME="${SERVICE_NAME:-we-term}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_FILE="$SCRIPT_DIR/${SERVICE_NAME}.service"
SYSTEMD_SERVICE_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
DEPLOY_STATE_DIR="$SCRIPT_DIR/.deploy"
DIST_DIR="$DEPLOY_STATE_DIR/dist"
LAST_PACKAGE_HASH_FILE="$DEPLOY_STATE_DIR/last-package.sha256"
LAST_REQUIREMENTS_HASH_FILE="$DEPLOY_STATE_DIR/last-requirements.sha256"
LATEST_ARTIFACT_LINK="$DIST_DIR/${APP_NAME}-latest.tar.gz"
VENV_DIR="${VENV_DIR:-$SCRIPT_DIR/venv}"
PYTHON_BIN="${PYTHON_BIN:-python3}"
REQUIREMENTS_FILE="$SCRIPT_DIR/requirements.txt"
PACKAGE_JSON="$SCRIPT_DIR/package.json"

APP_CHANGED=0
DEPENDENCIES_CHANGED=0
SERVICE_CHANGED=0
SYSTEMD_RELOADED=0
SERVICE_WAS_INACTIVE=0
CURRENT_PACKAGE_HASH=""
CURRENT_REQUIREMENTS_HASH=""

log() {
    printf '==> %s\n' "$1" >&2
}

fail() {
    printf 'ERROR: %s\n' "$1" >&2
    exit 1
}

require_command() {
    command -v "$1" >/dev/null 2>&1 || fail "Required command not found: $1"
}

trim_trailing_whitespace() {
    sed 's/[[:space:]]*$//'
}

compute_file_hash() {
    sha256sum "$1" | awk '{print $1}'
}

read_saved_hash() {
    local hash_file="$1"
    if [[ -f "$hash_file" ]]; then
        tr -d '[:space:]' < "$hash_file"
    fi
}

save_hash() {
    local target_file="$1"
    local value="$2"
    printf '%s\n' "$value" > "$target_file"
}

has_npm_build_script() {
    [[ -f "$PACKAGE_JSON" ]] || return 1
    require_command "$PYTHON_BIN"
    "$PYTHON_BIN" - "$PACKAGE_JSON" <<'PY'
import json
import pathlib
import sys

package_json = pathlib.Path(sys.argv[1])
data = json.loads(package_json.read_text())
raise SystemExit(0 if data.get("scripts", {}).get("build") else 1)
PY
}

run_optional_build() {
    if ! [[ -f "$PACKAGE_JSON" ]]; then
        log "No package.json found; skipping frontend build."
        return
    fi

    if ! has_npm_build_script; then
        log "No npm build script found; skipping frontend build."
        return
    fi

    require_command npm

    log "Installing Node dependencies for build."
    if [[ -f "$SCRIPT_DIR/package-lock.json" ]]; then
        (cd "$SCRIPT_DIR" && npm ci)
    else
        (cd "$SCRIPT_DIR" && npm install)
    fi

    log "Running npm build."
    (cd "$SCRIPT_DIR" && npm run build)
}

package_application() {
    local timestamp artifact_path current_hash previous_hash

    mkdir -p "$DIST_DIR"
    timestamp="$(date +%Y%m%d-%H%M%S)"
    artifact_path="$DIST_DIR/${APP_NAME}-${timestamp}.tar.gz"

    log "Packaging application snapshot."
    tar \
        --exclude='.git' \
        --exclude='.deploy' \
        --exclude='node_modules' \
        --exclude='venv' \
        --exclude='test-results' \
        --exclude='playwright-report' \
        --exclude='__pycache__' \
        --exclude='.pytest_cache' \
        -czf "$artifact_path" \
        -C "$SCRIPT_DIR" .

    ln -sfn "$(basename "$artifact_path")" "$LATEST_ARTIFACT_LINK"

    current_hash="$(compute_file_hash "$artifact_path")"
    previous_hash="$(read_saved_hash "$LAST_PACKAGE_HASH_FILE")"
    CURRENT_PACKAGE_HASH="$current_hash"

    if [[ "$current_hash" != "$previous_hash" ]]; then
        APP_CHANGED=1
    fi

    printf '%s\n' "$artifact_path"
}

ensure_virtualenv() {
    require_command "$PYTHON_BIN"

    if [[ ! -d "$VENV_DIR" ]]; then
        log "Creating virtual environment."
        "$PYTHON_BIN" -m venv "$VENV_DIR"
        DEPENDENCIES_CHANGED=1
    fi

    "$VENV_DIR/bin/python" -m pip install --upgrade pip >/dev/null
}

install_python_dependencies() {
    local current_hash previous_hash

    if [[ ! -f "$REQUIREMENTS_FILE" ]]; then
        log "No requirements.txt found; skipping Python dependency install."
        return
    fi

    current_hash="$(compute_file_hash "$REQUIREMENTS_FILE")"
    previous_hash="$(read_saved_hash "$LAST_REQUIREMENTS_HASH_FILE")"
    CURRENT_REQUIREMENTS_HASH="$current_hash"

    if [[ "$current_hash" != "$previous_hash" || "$DEPENDENCIES_CHANGED" -eq 1 ]]; then
        log "Installing Python dependencies."
        "$VENV_DIR/bin/pip" install -r "$REQUIREMENTS_FILE"
        DEPENDENCIES_CHANGED=1
    else
        log "Python dependencies unchanged; skipping pip install."
    fi
}

update_systemd_service() {
    [[ -f "$SERVICE_FILE" ]] || fail "Missing service file: $SERVICE_FILE"
    require_command sudo

    if ! sudo test -f "$SYSTEMD_SERVICE_PATH" || ! sudo cmp -s "$SERVICE_FILE" "$SYSTEMD_SERVICE_PATH"; then
        log "Updating systemd unit."
        sudo cp "$SERVICE_FILE" "$SYSTEMD_SERVICE_PATH"
        sudo systemctl daemon-reload
        SYSTEMD_RELOADED=1
        SERVICE_CHANGED=1
    else
        log "Systemd unit unchanged."
    fi

    sudo systemctl enable "$SERVICE_NAME" >/dev/null
}

restart_service_if_needed() {
    if ! sudo systemctl is-active --quiet "$SERVICE_NAME"; then
        SERVICE_WAS_INACTIVE=1
    fi

    if [[ "$SERVICE_WAS_INACTIVE" -eq 1 ]]; then
        log "Starting ${SERVICE_NAME} service."
        sudo systemctl start "$SERVICE_NAME"
        return
    fi

    if [[ "$APP_CHANGED" -eq 1 || "$DEPENDENCIES_CHANGED" -eq 1 || "$SERVICE_CHANGED" -eq 1 ]]; then
        log "Restarting ${SERVICE_NAME} service."
        sudo systemctl restart "$SERVICE_NAME"
        return
    fi

    log "No deployable changes detected; service restart not needed."
}

verify_service() {
    local host port verify_host url attempt

    host="$(sed -n 's/^Environment=WETERM_HOST=//p' "$SERVICE_FILE" | tail -n 1 | trim_trailing_whitespace | tr -d '"')"
    port="$(sed -n 's/^Environment=WETERM_PORT=//p' "$SERVICE_FILE" | tail -n 1 | trim_trailing_whitespace | tr -d '"')"
    host="${host:-127.0.0.1}"
    port="${port:-9090}"
    verify_host="$host"
    if [[ "$verify_host" == "0.0.0.0" || "$verify_host" == "::" ]]; then
        verify_host="127.0.0.1"
    fi
    url="http://${verify_host}:${port}/"

    require_command curl

    log "Verifying ${SERVICE_NAME} service is active."
    sudo systemctl is-active --quiet "$SERVICE_NAME" || fail "${SERVICE_NAME} service is not active after deploy."

    log "Checking service endpoint at ${url}."
    for attempt in $(seq 1 15); do
        if curl --fail --silent --show-error --max-time 5 "$url" >/dev/null; then
            return
        fi
        sleep 1
    done
    fail "Service did not respond successfully at ${url}"
}

persist_deploy_state() {
    if [[ -n "$CURRENT_PACKAGE_HASH" ]]; then
        save_hash "$LAST_PACKAGE_HASH_FILE" "$CURRENT_PACKAGE_HASH"
    fi

    if [[ -n "$CURRENT_REQUIREMENTS_HASH" ]]; then
        save_hash "$LAST_REQUIREMENTS_HASH_FILE" "$CURRENT_REQUIREMENTS_HASH"
    fi
}

main() {
    local artifact_path

    require_command tar
    require_command sha256sum

    mkdir -p "$DEPLOY_STATE_DIR" "$DIST_DIR"

    run_optional_build
    artifact_path="$(package_application)"
    ensure_virtualenv
    install_python_dependencies
    update_systemd_service
    restart_service_if_needed
    verify_service
    persist_deploy_state

    log "Deploy complete."
    printf 'Artifact: %s\n' "$artifact_path"
    if [[ "$SYSTEMD_RELOADED" -eq 1 ]]; then
        printf 'Systemd: reloaded\n'
    fi
    if [[ "$SERVICE_WAS_INACTIVE" -eq 1 ]]; then
        printf 'Service action: started\n'
    elif [[ "$APP_CHANGED" -eq 1 || "$DEPENDENCIES_CHANGED" -eq 1 || "$SERVICE_CHANGED" -eq 1 ]]; then
        printf 'Service action: restarted\n'
    else
        printf 'Service action: unchanged\n'
    fi
}

main "$@"
