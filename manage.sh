#!/bin/bash
set -euo pipefail

COMPOSE_FILE="$(cd "$(dirname "$0")" && pwd)/docker-compose.yml"
SERVICE_NAME="pumasamplermusic"
CONTAINER_NAME="pumasamplermusic"

cd "$(dirname "$0")"

usage() {
    echo "Usage: $0 {start|stop|restart|status|logs|backup|update|clean|info}"
    exit 1
}

start() {
    echo "Starting PumaSamplerMusic..."
    docker compose -f "$COMPOSE_FILE" up -d --build
    echo "PumaSamplerMusic started at http://localhost:4070"
}

stop() {
    echo "Stopping PumaSamplerMusic..."
    docker compose -f "$COMPOSE_FILE" down
}

restart() {
    stop
    start
}

status() {
    docker compose -f "$COMPOSE_FILE" ps
    echo "---"
    docker stats --no-stream "$CONTAINER_NAME" 2>/dev/null || true
    echo "---"
    curl -s http://localhost:4070/api/health || echo "Health check failed"
}

logs() {
    docker compose -f "$COMPOSE_FILE" logs -f
}

backup() {
    local backup_dir="backups"
    mkdir -p "$backup_dir"
    local timestamp
    timestamp=$(date +%Y%m%d-%H%M%S)
    local backup_file="$backup_dir/pumasamplermusic-backup-$timestamp.tar.gz"

    echo "Creating backup: $backup_file"
    stop
    tar -czf "$backup_file" config data docker-compose.yml manage.sh
    start
    echo "Backup complete: $backup_file"
}

update() {
    echo "Updating PumaSamplerMusic..."
    docker compose -f "$COMPOSE_FILE" down
    docker compose -f "$COMPOSE_FILE" build --no-cache
    docker compose -f "$COMPOSE_FILE" up -d
}

clean() {
    echo "Cleaning dangling images..."
    docker image prune -f
}

info() {
    echo "PumaSamplerMusic"
    echo "  URL: http://localhost:4070"
    echo "  Config: ./config"
    echo "  Data: ./data"
    echo "  Compose: $COMPOSE_FILE"
}

case "${1:-}" in
    start) start ;;
    stop) stop ;;
    restart) restart ;;
    status) status ;;
    logs) logs ;;
    backup) backup ;;
    update) update ;;
    clean) clean ;;
    info) info ;;
    *) usage ;;
esac
