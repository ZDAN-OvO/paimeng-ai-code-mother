package com.zdan.paimengaicodemother.task;

import com.zdan.paimengaicodemother.exception.BusinessException;
import com.zdan.paimengaicodemother.exception.ErrorCode;
import com.zdan.paimengaicodemother.model.entity.App;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.List;
import java.util.UUID;
import java.util.function.Consumer;
import java.util.function.Function;
import java.util.function.Supplier;
import javax.sql.DataSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.datasource.SingleConnectionDataSource;
import org.springframework.stereotype.Repository;

@Repository
public class GenerationTaskStore {
    private static final String ADMISSION = "admission:";
    private static final String DELIVERY = "delivery:";
    private static final String ACTIVE = "status IN ('RUNNING', 'COMMITTING')";
    private static final RowMapper<GenerationTask> TASK = (row, number) -> mapTask(row);

    private final DataSource dataSource;
    private final JdbcTemplate jdbc;

    public GenerationTaskStore(DataSource dataSource) {
        this.dataSource = dataSource;
        this.jdbc = new JdbcTemplate(dataSource);
    }

    <T> T admission(long appId, Function<Session, T> work) {
        return locked(ADMISSION + appId, true, work);
    }

    <T> T withDelivery(long appId, Function<Session, T> work) {
        return locked(DELIVERY + appId, false, work);
    }

    void ownDelivery(long appId, Consumer<Session> work) {
        locked(DELIVERY + appId, true, session -> {
            work.accept(session);
            return null;
        });
    }

    public <T> T readDeliveredWorkspace(long appId, Supplier<T> read) {
        return locked(DELIVERY + appId, true, session -> {
            GenerationTask active = session.active(appId);
            if (active != null && active.status() == GenerationTask.Status.COMMITTING) {
                throw new BusinessException(ErrorCode.OPERATION_ERROR, "生成结果正在交付，请稍后部署");
            }
            return read.get();
        });
    }

    private <T> T locked(String name, boolean wait, Function<Session, T> work) {
        // 会话锁跨越多次自动提交，目录交换之前写入的阶段必须立即持久化。
        try (Connection connection = dataSource.getConnection()) {
            connection.setAutoCommit(true);
            var locked = new JdbcTemplate(new SingleConnectionDataSource(connection, true));
            if (wait) {
                locked.query("SELECT pg_advisory_lock(hashtextextended(?, 0))", row -> { }, name);
            } else if (!Boolean.TRUE.equals(locked.queryForObject(
                    "SELECT pg_try_advisory_lock(hashtextextended(?, 0))", Boolean.class, name))) {
                return null;
            }
            try {
                return work.apply(new Session(locked));
            } finally {
                try {
                    if (!Boolean.TRUE.equals(locked.queryForObject(
                            "SELECT pg_advisory_unlock(hashtextextended(?, 0))", Boolean.class, name))) {
                        throw new IllegalStateException("任务数据库锁已丢失");
                    }
                } catch (RuntimeException error) {
                    connection.abort(Runnable::run);
                    throw error;
                }
            }
        } catch (SQLException error) {
            throw new IllegalStateException("任务数据库会话失败", error);
        }
    }

    App app(long appId) {
        return new Session(jdbc).app(appId);
    }

    GenerationTask byId(UUID taskId) {
        return first(jdbc.query("SELECT * FROM generation_task WHERE task_id = ?", TASK, taskId));
    }

    GenerationTask activeOrRecent(long appId) {
        return first(jdbc.query("""
                SELECT * FROM generation_task
                WHERE app_id = ? AND (%s OR finished_at >= clock_timestamp() - interval '30 minutes')
                ORDER BY (%s) DESC, finished_at DESC LIMIT 1
                """.formatted(ACTIVE, ACTIVE), TASK, appId));
    }

    List<RecoveryTask> pending() {
        return jdbc.query("""
                SELECT task_id, app_id FROM generation_task WHERE cleaned_at IS NULL ORDER BY created_at
                """, (row, number) -> new RecoveryTask(row.getObject("task_id", UUID.class), row.getLong("app_id")));
    }

    List<Long> pendingHistoryDeletions() {
        return jdbc.queryForList("SELECT app_id FROM generation_history_deletion", Long.class);
    }

    static final class Session {
        private final JdbcTemplate jdbc;

        Session(JdbcTemplate jdbc) {
            this.jdbc = jdbc;
        }

        App app(long appId) {
            return first(jdbc.query("""
                    SELECT id, "userId", "codeGenType", "initPrompt" FROM app WHERE id = ? AND "isDelete" = 0
                    """, (row, number) -> {
                var app = new App();
                app.setId(row.getLong("id"));
                app.setUserId(row.getLong("userId"));
                app.setCodeGenType(row.getString("codeGenType"));
                app.setInitPrompt(row.getString("initPrompt"));
                return app;
            }, appId));
        }

        GenerationTask byId(UUID taskId) {
            return first(jdbc.query("SELECT * FROM generation_task WHERE task_id = ?", TASK, taskId));
        }

        GenerationTask byRequest(long appId, String clientRequestId) {
            return first(jdbc.query("SELECT * FROM generation_task WHERE app_id = ? AND client_request_id = ?",
                    TASK, appId, clientRequestId));
        }

        GenerationTask active(long appId) {
            return first(jdbc.query("SELECT * FROM generation_task WHERE app_id = ? AND " + ACTIVE, TASK, appId));
        }

        void create(GenerationTask task) {
            jdbc.update("""
                    INSERT INTO generation_task (task_id, app_id, user_id, client_request_id, code_gen_type,
                        message, status, staging_path, current_path, backup_path)
                    VALUES (?, ?, ?, ?, ?, ?, 'RUNNING', ?, ?, ?)
                    """, task.id(), task.appId(), task.userId(), task.clientRequestId(), task.codeGenType(),
                    task.message(), task.paths().staging().toString(), task.paths().current().toString(),
                    task.paths().backup().toString());
        }

        void start(UUID id) {
            jdbc.update("UPDATE generation_task SET started_at = clock_timestamp() WHERE task_id = ?", id);
        }

        void prepareCommit(UUID id, String payload, String code, String message, Boolean hadCurrent) {
            jdbc.update("""
                    UPDATE generation_task SET status = 'COMMITTING', workspace_phase = 'STAGED',
                        commit_payload = CAST(? AS jsonb), failure_code = ?, failure_message = ?, had_current = ?
                    WHERE task_id = ?
                    """, payload, code, message, hadCurrent, id);
        }

        void phase(UUID id, GenerationTask.Phase phase) {
            jdbc.update("UPDATE generation_task SET workspace_phase = ? WHERE task_id = ?", phase.name(), id);
        }

        void restore(UUID id, String payload, String code, String message) {
            jdbc.update("""
                    UPDATE generation_task SET workspace_phase = 'RESTORING', commit_payload = CAST(? AS jsonb),
                        failure_code = ?, failure_message = ? WHERE task_id = ?
                    """, payload, code, message, id);
        }

        void recordCommit(UUID id) {
            jdbc.update("UPDATE generation_task SET result_committed = TRUE WHERE task_id = ?", id);
        }

        void finish(UUID id, GenerationTask.Status status) {
            jdbc.update("UPDATE generation_task SET status = ?, finished_at = clock_timestamp() WHERE task_id = ?",
                    status.name(), id);
        }

        void cleaned(UUID id) {
            jdbc.update("UPDATE generation_task SET cleaned_at = clock_timestamp() WHERE task_id = ?", id);
        }

        boolean historyDeletionPending(long appId) {
            return Boolean.TRUE.equals(jdbc.queryForObject(
                    "SELECT EXISTS (SELECT 1 FROM generation_history_deletion WHERE app_id = ?)", Boolean.class, appId));
        }

        void historyDeleted(long appId) {
            jdbc.update("DELETE FROM generation_history_deletion WHERE app_id = ?", appId);
        }

        boolean deleteApp(long appId) {
            return jdbc.update("""
                    WITH removed AS (
                        UPDATE app SET "isDelete" = 1 WHERE id = ? AND "isDelete" = 0 RETURNING id
                    )
                    INSERT INTO generation_history_deletion(app_id) SELECT id FROM removed
                    """, appId) == 1;
        }
    }

    record RecoveryTask(UUID id, long appId) {
    }

    private static <T> T first(List<T> records) {
        return records.isEmpty() ? null : records.getFirst();
    }

    private static GenerationTask mapTask(ResultSet row) throws SQLException {
        var phase = row.getString("workspace_phase");
        return new GenerationTask(row.getObject("task_id", UUID.class), row.getLong("app_id"), row.getLong("user_id"),
                row.getString("client_request_id"), row.getString("code_gen_type"), row.getString("message"),
                GenerationTask.Status.valueOf(row.getString("status")),
                phase == null ? null : GenerationTask.Phase.valueOf(phase), row.getString("commit_payload"),
                row.getString("failure_code"), row.getString("failure_message"), new WorkspaceStagingManager.Paths(
                Path.of(row.getString("staging_path")), Path.of(row.getString("current_path")),
                Path.of(row.getString("backup_path"))), row.getObject("had_current", Boolean.class),
                row.getTimestamp("started_at") != null, row.getBoolean("result_committed"));
    }
}
