package com.zdan.paimengaicodemother.task;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.zdan.paimengaicodemother.agent.PythonAgentClient;
import com.zdan.paimengaicodemother.agent.PythonAgentClient.AgentException;
import com.zdan.paimengaicodemother.agent.PythonAgentClient.CommitResult;
import com.zdan.paimengaicodemother.agent.PythonAgentClient.GenerationRequest;
import com.zdan.paimengaicodemother.ai.enums.CodeGenTypeEnum;
import com.zdan.paimengaicodemother.cutover.WriteBarrier;
import com.zdan.paimengaicodemother.exception.BusinessException;
import com.zdan.paimengaicodemother.exception.ErrorCode;
import com.zdan.paimengaicodemother.exception.ThrowUtils;
import com.zdan.paimengaicodemother.model.entity.App;
import com.zdan.paimengaicodemother.task.GenerationTask.Status;
import com.zdan.paimengaicodemother.task.TaskEventStreamService.Lease;
import jakarta.annotation.PreDestroy;
import java.io.IOException;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Service;

@Slf4j
@Service
public class GenerationTaskCoordinator {
    private final GenerationTaskStore store;
    private final TaskEventStreamService events;
    private final WorkspaceStagingManager workspace;
    private final GenerationRateLimitService rateLimit;
    private final PythonAgentClient agent;
    private final ObjectMapper mapper;
    private final WriteBarrier writeBarrier;
    private final ExecutorService workers = Executors.newVirtualThreadPerTaskExecutor();
    private final ScheduledExecutorService clock = Executors.newScheduledThreadPool(2);
    private final Set<UUID> working = ConcurrentHashMap.newKeySet();
    private final Set<Long> deletingHistory = ConcurrentHashMap.newKeySet();

    public GenerationTaskCoordinator(GenerationTaskStore store, TaskEventStreamService events, WorkspaceStagingManager workspace,
                                     GenerationRateLimitService rateLimit, PythonAgentClient agent, ObjectMapper mapper,
                                     WriteBarrier writeBarrier) {
        this.store = store;
        this.events = events;
        this.workspace = workspace;
        this.rateLimit = rateLimit;
        this.agent = agent;
        this.mapper = mapper;
        this.writeBarrier = writeBarrier;
    }

    public Submission submit(Long appId, String message, String requestId, long userId) {
        return writeBarrier.write("generation.submit:" + appId, () -> submitAdmitted(appId, message, requestId, userId));
    }

    private Submission submitAdmitted(Long appId, String message, String requestId, long userId) {
        ThrowUtils.throwIf(appId == null || appId <= 0 || message == null || message.isBlank()
                || message.indexOf(0) >= 0 || requestId == null || requestId.isBlank()
                || requestId.length() > 200 || requestId.indexOf(0) >= 0,
                ErrorCode.PARAMS_ERROR, "应用、指令或请求标识无效");

        Submission submission = store.admission(appId, session -> {
            App app = requireOwner(session.app(appId), userId);
            GenerationTask existing = session.byRequest(appId, requestId);
            if (existing != null) {
                return submission(existing, true, false, "");
            }
            GenerationTask active = session.active(appId);
            if (active != null) {
                return submission(active, false, true, "该应用正在生成");
            }
            if (requestId.equals("init:" + appId)) {
                try {
                    if (agent.hasHistory(appId)) {
                        return new Submission(null, appId.toString(), null, false, true, "该应用已有对话", "HISTORY_EXISTS");
                    }
                } catch (AgentException error) {
                    log.warn("初始化历史复查失败，appId={}", appId, error);
                    throw new BusinessException(ErrorCode.OPERATION_ERROR, "暂时无法核对对话历史，请稍后重试");
                }
            }
            String type = app.getCodeGenType();
            ThrowUtils.throwIf(CodeGenTypeEnum.getEnumByValue(type) == null, ErrorCode.PARAMS_ERROR, "代码生成类型无效");
            rateLimit.acquire();
            UUID id = UUID.randomUUID();
            var task = new GenerationTask(id, appId, userId, requestId, type, message, Status.RUNNING, null,
                    null, null, null, workspace.paths(appId, type, id), null, false, false);
            session.create(task);
            return submission(task, false, false, "");
        });
        if (submission.taskId() != null && !submission.reused() && !submission.conflict()) {
            enqueue(submission.taskId(), appId);
        }
        return submission;
    }

    public Summary active(Long appId, long userId) {
        ThrowUtils.throwIf(appId == null || appId <= 0, ErrorCode.PARAMS_ERROR, "应用 ID 无效");
        requireOwner(store.app(appId), userId);
        GenerationTask task = store.activeOrRecent(appId);
        if (task == null) {
            return null;
        }
        return new Summary(task.id(), appId.toString(), task.status().apiValue(), task.resultCommitted(),
                events.available(task.id()));
    }

    GenerationTask authorizedTask(UUID taskId, long userId) {
        GenerationTask task = store.byId(taskId);
        ThrowUtils.throwIf(task == null, ErrorCode.NOT_FOUND_ERROR, "任务不存在");
        requireOwner(store.app(task.appId()), userId);
        return task;
    }

    public boolean deleteApp(long appId) {
        return writeBarrier.write("app.delete:" + appId, () -> deleteAdmitted(appId));
    }

    private boolean deleteAdmitted(long appId) {
        boolean deleted = store.admission(appId, session -> {
            ThrowUtils.throwIf(session.active(appId) != null, ErrorCode.OPERATION_ERROR, "应用正在生成，请稍后删除");
            boolean removed = session.deleteApp(appId);
            ThrowUtils.throwIf(!removed, ErrorCode.OPERATION_ERROR, "删除应用失败");
            return removed;
        });
        // 删除事务已登记待清理的历史，恢复扫描也会处理这条记录。
        enqueueDeletion(appId);
        return deleted;
    }

    @EventListener(ApplicationReadyEvent.class)
    void startRecovery() {
        clock.scheduleWithFixedDelay(() -> {
            try {
                store.pending().forEach(task -> enqueue(task.id(), task.appId()));
                store.pendingHistoryDeletions().forEach(this::enqueueDeletion);
            } catch (RuntimeException error) {
                log.error("扫描待恢复任务失败", error);
            }
        }, 0, 5, TimeUnit.SECONDS);
    }

    private void enqueue(UUID id, long appId) {
        if (!working.add(id)) {
            return;
        }
        workers.execute(() -> {
            try {
                runOrRecover(id, appId);
            } catch (RuntimeException error) {
                log.error("生成任务等待恢复，appId={} taskId={}", appId, id, error);
            } finally {
                working.remove(id);
            }
        });
    }

    private void enqueueDeletion(long appId) {
        if (!deletingHistory.add(appId)) {
            return;
        }
        workers.execute(() -> {
            try (var ticket = writeBarrier.recover("history.delete:" + appId)) {
                if (ticket != null) {
                    store.admission(appId, session -> {
                        if (session.historyDeletionPending(appId)) {
                            agent.deleteHistory(appId);
                            session.historyDeleted(appId);
                        }
                        return null;
                    });
                }
            } catch (RuntimeException error) {
                log.error("清理历史等待恢复，appId={}", appId, error);
            } finally {
                deletingHistory.remove(appId);
            }
        });
    }

    void runOrRecover(UUID id, long appId) {
        try (var ticket = writeBarrier.recover("generation.run:" + id)) {
            if (ticket != null) {
                runRegistered(id, appId);
            }
        }
    }

    private void runRegistered(UUID id, long appId) {
        Attempt attempt = store.withDelivery(appId, session -> {
            GenerationTask task = session.byId(id);
            if (task == null) {
                return null;
            }
            if (task.status().terminal()) {
                clean(session, task);
                return null;
            }
            Lease lease = events.acquire(appId, id);
            if (lease == null) {
                return null;
            }
            if (task.status() == Status.COMMITTING) {
                finishCommit(session, task, lease);
                return null;
            }
            if (task.started()) {
                Candidate failed = failure(id, "", null, "GENERATION_INTERRUPTED", "生成任务中断，请重新提交");
                persistCandidate(session, task, failed, null);
                finishCommit(session, session.byId(id), lease);
                return null;
            }
            session.start(id);
            return new Attempt(task, lease);
        });
        if (attempt != null) {
            generate(attempt.task(), attempt.lease());
        }
    }

    private void generate(GenerationTask task, Lease lease) {
        var result = new GenerationOutput(task.id(), lease);
        try (var heartbeat = new Heartbeat(lease)) {
            try {
                workspace.prepare(task);
                if (!events.renew(lease)) {
                    return;
                }
                agent.generate(new GenerationRequest(Long.toString(task.appId()), Long.toString(task.userId()),
                        task.id().toString(), task.codeGenType(), task.message()), result::accept);
            } catch (IOException error) {
                log.warn("准备临时目录失败，taskId={}", task.id(), error);
                result.candidate = failure(task.id(), "", null, "WORKSPACE_FAILED", "准备生成工作区失败");
            } catch (AgentException error) {
                log.warn("Python 生成提前终止，taskId={}", task.id(), error);
                result.candidate = failure(task.id(), result.content.toString(), null, "GENERATION_FAILED", "生成任务提前中断");
            } catch (LostLease error) {
                return;
            }
            if (heartbeat.lost()) {
                return;
            }
        }
        Candidate candidate = result.candidate;
        if (candidate != null && !Thread.currentThread().isInterrupted()) {
            store.ownDelivery(task.appId(), session -> {
                GenerationTask latest = session.byId(task.id());
                if (latest.status() != Status.RUNNING || !events.renew(lease)) {
                    return;
                }
                Candidate validated = candidate;
                Boolean hadCurrent = null;
                if (candidate.success()) {
                    try {
                        if (CodeGenTypeEnum.VUE_PROJECT.getValue().equals(latest.codeGenType())
                                && (candidate.result().buildResult() == null
                                    || !candidate.result().buildResult().path("success").asBoolean())) {
                            throw new IOException("Vue 任务缺少成功的构建结果");
                        }
                        hadCurrent = workspace.verifyCandidate(latest);
                    } catch (IOException error) {
                        log.warn("生成产物验收失败，taskId={}", task.id(), error);
                        validated = failure(task.id(), candidate.result().content(), candidate.result().buildResult(),
                                "INVALID_ARTIFACT", "生成结果未通过工作区验收");
                    }
                }
                if (events.renew(lease)) {
                    persistCandidate(session, latest, validated, hadCurrent);
                    finishCommit(session, session.byId(task.id()), lease);
                }
            });
        }
    }

    private void persistCandidate(GenerationTaskStore.Session session, GenerationTask task,
                                  Candidate candidate, Boolean hadCurrent) {
        session.prepareCommit(task.id(), encode(candidate.result()), candidate.code(), candidate.message(), hadCurrent);
    }

    private void finishCommit(GenerationTaskStore.Session session, GenerationTask task, Lease lease) {
        CommitResult result = decode(task.commitPayload());
        String code = task.failureCode();
        String message = task.failureMessage();
        boolean success = result.status().equals("success");
        events.append(lease, "status", Map.of("taskId", task.id().toString(), "phase", "committing",
                "message", "正在提交生成结果"), false);
        try {
            if (success && !workspace.exchange(task, session)) {
                Candidate failed = failure(task.id(), result.content(), result.buildResult(),
                        "WORKSPACE_DELIVERY_FAILED", "生成目录切换失败");
                session.restore(task.id(), encode(failed.result()), failed.code(), failed.message());
                task = session.byId(task.id());
                result = failed.result();
                code = failed.code();
                message = failed.message();
                success = false;
            }
            if (task.phase() == GenerationTask.Phase.RESTORING) {
                workspace.restore(task);
            }
        } catch (IOException error) {
            throw new IllegalStateException("交付目录状态等待恢复，taskId=" + task.id(), error);
        }
        if (!task.resultCommitted()) {
            commitHistory(task, result);
            session.recordCommit(task.id());
        }
        Lease terminalLease = events.renew(lease) ? lease : events.acquire(task.appId(), task.id());
        if (terminalLease == null) {
            throw new IllegalStateException("无法取得提交终态所需的租约");
        }
        String taskId = task.id().toString();
        Map<String, String> payload = success ? Map.of("taskId", taskId, "status", "success")
                : Map.of("taskId", taskId, "status", "failed", "code", code, "message", message);
        if (!events.append(terminalLease, success ? "done" : "business-error", payload, true)) {
            throw new IllegalStateException("终态写流时租约已过期");
        }
        session.finish(task.id(), success ? Status.SUCCEEDED : Status.FAILED);
        clean(session, task);
    }

    private void commitHistory(GenerationTask task, CommitResult result) {
        try {
            agent.commitResult(task.appId(), result);
        } catch (AgentException error) {
            if (!error.missingGenerationUser() || !result.status().equals("failed")) {
                throw error;
            }
            agent.registerFailedGeneration(task.appId(), task.id().toString(), Long.toString(task.userId()), task.message());
            agent.commitResult(task.appId(), result);
        }
    }

    private void clean(GenerationTaskStore.Session session, GenerationTask task) {
        events.release(task.appId(), task.id());
        try {
            workspace.clean(task);
            session.cleaned(task.id());
        } catch (IOException error) {
            throw new IllegalStateException("清理任务目录失败，taskId=" + task.id(), error);
        }
    }

    private static App requireOwner(App app, long userId) {
        ThrowUtils.throwIf(app == null, ErrorCode.NOT_FOUND_ERROR, "应用不存在或正在删除");
        ThrowUtils.throwIf(!app.getUserId().equals(userId), ErrorCode.NO_AUTH_ERROR, "无权为该应用生成代码");
        return app;
    }

    private static Submission submission(GenerationTask task, boolean reused, boolean conflict, String message) {
        return new Submission(task.id(), Long.toString(task.appId()), task.status().apiValue(), reused, conflict, message, null);
    }

    private static Candidate failure(UUID id, String content, JsonNode buildResult, String code, String message) {
        // 失败终态的原因随模型正文写入历史，刷新后仍可查看。
        String historyContent = content.isBlank() ? message : message + "\n\n" + content;
        return new Candidate(new CommitResult(id.toString(), "failed", historyContent, buildResult), code, message);
    }

    private String encode(CommitResult result) {
        try {
            return mapper.writeValueAsString(result);
        } catch (JsonProcessingException error) {
            throw new IllegalStateException("无法保存生成结果", error);
        }
    }

    private CommitResult decode(String result) {
        try {
            return mapper.readValue(result, CommitResult.class);
        } catch (JsonProcessingException error) {
            throw new IllegalStateException("无法读取已保存的生成结果", error);
        }
    }

    @PreDestroy
    void shutdown() {
        clock.shutdownNow();
        workers.shutdownNow();
    }

    public record SubmitRequest(Long appId, String message, String clientRequestId) {
    }

    public record Submission(UUID taskId, String appId, String status, boolean reused, boolean conflict, String message,
                             @JsonInclude(JsonInclude.Include.NON_NULL) String code) {
    }

    public record Summary(UUID taskId, String appId, String status, boolean resultCommitted, boolean streamAvailable) {
    }

    private record Attempt(GenerationTask task, Lease lease) {
    }

    private record Candidate(CommitResult result, String code, String message) {
        boolean success() {
            return result.status().equals("success");
        }
    }

    private final class GenerationOutput {
        private final UUID id;
        private final Lease lease;
        private final StringBuilder content = new StringBuilder();
        private Candidate candidate;

        GenerationOutput(UUID id, Lease lease) {
            this.id = id;
            this.lease = lease;
        }

        void accept(PythonAgentClient.GenerationEvent event) {
            var data = event.data();
            switch (event.type()) {
                case "delta" -> {
                    String chunk = data.path("text").asText();
                    emit("message", Map.of("taskId", id.toString(), "d", chunk));
                    content.append(chunk);
                }
                case "tool_start", "tool_result" -> {
                    boolean error = data.path("isError").asBoolean();
                    String phase = event.type().equals("tool_start") ? "tool_running"
                            : error ? "tool_failed" : "tool_completed";
                    emit("status", Map.of("taskId", id.toString(), "phase", phase,
                            "toolName", data.path("toolName").asText(), "toolCallId", data.path("toolCallId").asText(),
                            "isError", error, "message", data.path("message").asText()));
                }
                case "build_status" -> {
                    int attempt = data.path("attempt").asInt(1);
                    emit("status", Map.of("taskId", id.toString(), "phase", attempt <= 1 ? "building" : "repairing",
                            "attempt", attempt, "message", data.path("message").asText()));
                }
                case "completed", "failed" -> {
                    JsonNode build = data.path("buildResult");
                    build = build.isObject() ? build : null;
                    String full = data.path("content").asText(content.toString());
                    candidate = event.type().equals("completed")
                            ? new Candidate(new CommitResult(id.toString(), "success", full, build), null, null)
                            : failure(id, full, build, data.path("code").asText("GENERATION_FAILED"),
                                    data.path("message").asText("生成失败"));
                }
                default -> log.debug("忽略未知 Python 事件，taskId={} type={}", id, event.type());
            }
        }

        private void emit(String type, Object payload) {
            if (!events.append(lease, type, payload, false)) {
                throw new LostLease();
            }
        }
    }

    private static final class LostLease extends RuntimeException {
    }

    private final class Heartbeat implements AutoCloseable {
        private final Lease lease;
        private final Thread worker = Thread.currentThread();
        private final ScheduledFuture<?> future;
        private boolean closed;
        private boolean lost;

        Heartbeat(Lease lease) {
            this.lease = lease;
            long interval = events.renewalInterval().toMillis();
            future = clock.scheduleWithFixedDelay(this::renew, interval, interval, TimeUnit.MILLISECONDS);
        }

        synchronized boolean lost() {
            return lost;
        }

        private synchronized void renew() {
            if (closed || lost) {
                return;
            }
            try {
                if (events.renew(lease)) {
                    return;
                }
            } catch (RuntimeException error) {
                log.warn("任务租约续期失败，taskId={}", lease.taskId(), error);
            }
            lost = true;
            worker.interrupt();
        }

        @Override
        public synchronized void close() {
            closed = true;
            future.cancel(false);
        }
    }
}
