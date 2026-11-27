-- 在 Python 历史数据库执行，依赖 02_init_python_history_db.sql。
CREATE TABLE IF NOT EXISTS generation_message_tasks (
    app_id            BIGINT NOT NULL REFERENCES chat_sessions (app_id),
    task_id           UUID NOT NULL,
    user_message_id   BIGINT NOT NULL UNIQUE REFERENCES chat_messages (id),
    result_message_id BIGINT UNIQUE REFERENCES chat_messages (id),
    status            VARCHAR(8) CHECK (status IN ('success', 'failed')),
    build_result      JSONB CHECK (jsonb_typeof(build_result) = 'object'),
    PRIMARY KEY (app_id, task_id),
    CHECK ((result_message_id IS NULL) = (status IS NULL)),
    CHECK (status IS NOT NULL OR build_result IS NULL)
);
