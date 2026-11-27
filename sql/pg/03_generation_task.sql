BEGIN;

CREATE TABLE IF NOT EXISTS generation_task (
    task_id            UUID PRIMARY KEY,
    app_id             BIGINT NOT NULL,
    user_id            BIGINT NOT NULL,
    client_request_id  VARCHAR(200) NOT NULL,
    code_gen_type      VARCHAR(64) NOT NULL,
    message            TEXT NOT NULL,
    status             VARCHAR(16) NOT NULL CHECK (status IN ('RUNNING', 'COMMITTING', 'SUCCEEDED', 'FAILED')),
    workspace_phase    VARCHAR(24) CHECK (workspace_phase IN
                            ('STAGED', 'CURRENT_TO_BACKUP', 'STAGING_TO_CURRENT', 'DELIVERED', 'RESTORING')),
    commit_payload     JSONB,
    failure_code       TEXT,
    failure_message    TEXT,
    staging_path       TEXT NOT NULL,
    current_path       TEXT NOT NULL,
    backup_path        TEXT NOT NULL,
    had_current        BOOLEAN,
    result_committed   BOOLEAN NOT NULL DEFAULT FALSE,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    started_at         TIMESTAMPTZ,
    finished_at        TIMESTAMPTZ,
    cleaned_at         TIMESTAMPTZ,
    UNIQUE (app_id, client_request_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS generation_task_one_active_app
    ON generation_task (app_id) WHERE status IN ('RUNNING', 'COMMITTING');
CREATE INDEX IF NOT EXISTS generation_task_recent_app
    ON generation_task (app_id, finished_at DESC) WHERE finished_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS generation_task_recovery
    ON generation_task (created_at) WHERE cleaned_at IS NULL;

-- 应用逻辑删除和历史清理请求在同一条语句中写入，服务重启后可继续清理。
CREATE TABLE IF NOT EXISTS generation_history_deletion (
    app_id BIGINT PRIMARY KEY
);

COMMIT;
