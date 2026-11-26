package com.zdan.paimengaicodemother.task;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import com.zdan.paimengaicodemother.agent.AgentServiceProperties;
import com.zdan.paimengaicodemother.agent.PythonAgentClient;
import com.zdan.paimengaicodemother.config.JsonConfig;
import com.zdan.paimengaicodemother.config.WorkspaceProperties;
import com.zdan.paimengaicodemother.controller.AppController;
import com.zdan.paimengaicodemother.exception.BusinessException;
import com.zdan.paimengaicodemother.exception.GlobalExceptionHandler;
import com.zdan.paimengaicodemother.model.entity.User;
import com.zdan.paimengaicodemother.ratelimiter.aspect.RateLimitAspect;
import com.zdan.paimengaicodemother.service.AppService;
import com.zdan.paimengaicodemother.service.ProjectDownloadService;
import com.zdan.paimengaicodemother.service.UserService;
import io.lettuce.core.RedisURI;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;
import org.junit.jupiter.params.provider.ValueSource;
import org.redisson.Redisson;
import org.redisson.config.Config;
import org.springframework.aop.aspectj.annotation.AspectJProxyFactory;
import org.springframework.data.redis.connection.lettuce.LettuceConnectionFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.http.MediaType;
import org.springframework.http.converter.json.Jackson2ObjectMapperBuilder;
import org.springframework.http.converter.json.MappingJackson2HttpMessageConverter;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.awaitility.Awaitility.await;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

@EnabledIfEnvironmentVariable(named = "PG_TEST_JDBC_URL", matches = "jdbc:postgresql:.+")
@EnabledIfEnvironmentVariable(named = "TASK_REDIS_URL", matches = "rediss?://.+/2")
class GenerationTaskIntegrationTest {
    private static final Duration WAIT = Duration.ofSeconds(10);
    private static final String BODY = "第一行\n第二行";
    private static final String OLD = "<p>旧预览</p>";
    private static final String NEW = "<p>新预览</p>";
    private static final Crash CRASH = new Crash();

    @TempDir
    Path root;

    private final ObjectMapper mapper = new JsonConfig().jacksonObjectMapper(new Jackson2ObjectMapperBuilder());
    private final String prefix = "java-task-integration:" + UUID.randomUUID() + ":";
    private final long user = ThreadLocalRandom.current().nextLong(1_000_000L, Long.MAX_VALUE - 100L);
    private final long app = user + 1;
    private final AtomicReference<CrashPoint> crash = new AtomicReference<>();
    private final AtomicInteger runs = new AtomicInteger();
    private final AtomicInteger attempts = new AtomicInteger();
    private final AtomicInteger registrationRequests = new AtomicInteger();
    private final AtomicInteger forcedCommitStatus = new AtomicInteger();
    private final AtomicReference<Runnable> deleteHistoryHook = new AtomicReference<>(() -> { });
    private final AtomicReference<Runnable> getHistoryHook = new AtomicReference<>(() -> { });
    private final Map<String, String> registered = new ConcurrentHashMap<>();
    private final Map<String, JsonNode> committed = new ConcurrentHashMap<>();
    private final AtomicReference<RunScript> runScript = new AtomicReference<>(this::completeNormally);
    private final List<GenerationTaskCoordinator> coordinators = new ArrayList<>();
    private HikariDataSource db;
    private JdbcTemplate jdbc;
    private LettuceConnectionFactory redisConnection;
    private StringRedisTemplate redis;
    private HttpServer server;
    private ExecutorService httpWorkers;
    private WorkspaceProperties workspace;
    private TaskEventStreamService events;
    private GenerationTaskStore store;
    private FaultyWorkspace manager;
    private PythonAgentClient agent;

    @BeforeEach
    void prepare() throws IOException {
        HikariConfig config = new HikariConfig();
        config.setJdbcUrl(System.getenv("PG_TEST_JDBC_URL"));
        config.setUsername(System.getenv("PG_TEST_USERNAME"));
        config.setPassword(System.getenv("PG_TEST_PASSWORD"));
        config.setMaximumPoolSize(5);
        db = new HikariDataSource(config);
        jdbc = new JdbcTemplate(db);
        addApp(app);

        TaskRedisConfig redisConfig = new TaskRedisConfig();
        redisConnection = redisConfig.taskRedisConnectionFactory(System.getenv("TASK_REDIS_URL"));
        redisConnection.afterPropertiesSet();
        redis = redisConfig.taskRedisTemplate(redisConnection);
        redis.afterPropertiesSet();
        events = new TaskEventStreamService(redis, mapper, prefix, Duration.ofSeconds(6));

        workspace = new WorkspaceProperties(root.toString(), "code_output", "code_staging", "code_deploy", "screenshots");
        manager = new FaultyWorkspace(workspace);
        store = new GenerationTaskStore(db);
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        httpWorkers = Executors.newVirtualThreadPerTaskExecutor();
        server.setExecutor(httpWorkers);
        server.createContext("/internal/v1/generation/runs", this::generate);
        server.createContext("/internal/v1/apps/", this::history);
        server.start();
        agent = new PythonAgentClient(new AgentServiceProperties(URI.create("http://127.0.0.1:"
                + server.getAddress().getPort()), "test-token"), mapper) {
            @Override
            public void commitResult(long appId, CommitResult result) {
                crashAt(CrashPoint.BEFORE_HISTORY);
                super.commitResult(appId, result);
                crashAt(CrashPoint.AFTER_HISTORY);
            }
        };
    }

    @AfterEach
    void close() {
        coordinators.forEach(GenerationTaskCoordinator::shutdown);
        if (server != null) {
            server.stop(0);
            httpWorkers.shutdownNow();
        }
        if (db != null) {
            if (jdbc != null) {
                jdbc.update("DELETE FROM generation_task WHERE user_id = ?", user);
                jdbc.update("DELETE FROM generation_history_deletion WHERE app_id IN (?, ?)", app, app + 1);
                jdbc.update("DELETE FROM app WHERE \"userId\" = ?", user);
            }
            db.close();
        }
        if (redisConnection != null) {
            // 只清理本用例独有的键前缀。
            redis.delete(redis.keys(prefix + "*"));
            redisConnection.destroy();
        }
    }

    @Test
    void parallelPostAndLegacyAttachToOneTaskAndOnlyANewTaskConsumesQuota() throws Exception {
        addApp(app + 1);
        var entered = new CountDownLatch(1);
        var finish = new CountDownLatch(1);
        runScript.set((exchange, request) -> {
            startEvents(exchange);
            send(exchange, "delta", Map.of("text", "第一行\n"));
            entered.countDown();
            waitFor(finish);
            send(exchange, "tool_start", Map.of("toolName", "write", "toolCallId", "call-1", "isError", false,
                    "message", "修改文件"));
            send(exchange, "tool_result", Map.of("toolName", "write", "toolCallId", "call-1", "isError", true,
                    "message", "工具失败"));
            send(exchange, "build_status", Map.of("attempt", 1, "phase", "building", "message", "构建"));
            send(exchange, "build_status", Map.of("attempt", 2, "phase", "repairing", "message", "修复"));
            Files.writeString(staging(request).resolve("index.html"), NEW);
            send(exchange, "delta", Map.of("text", "第二行"));
            send(exchange, "completed", Map.of("content", BODY, "buildResult", Map.of("success", true)));
        });
        var users = mock(UserService.class);
        when(users.getLoginUser(any())).thenReturn(User.builder().id(user).build());
        RedisURI uri = RedisURI.create(System.getenv("TASK_REDIS_URL"));
        Config redissonConfig = new Config();
        var connection = redissonConfig.useSingleServer().setAddress((uri.isSsl() ? "rediss://" : "redis://") + uri.getHost() + ":" + uri.getPort())
                .setDatabase(0).setConnectionMinimumIdleSize(1).setSubscriptionConnectionMinimumIdleSize(1);
        if (uri.getPassword() != null) {
            connection.setPassword(new String(uri.getPassword()));
        }
        var limiterRedis = Redisson.create(redissonConfig);
        String rateKey = "rate_limit:user:" + user;
        try (var callers = Executors.newVirtualThreadPerTaskExecutor()) {
            var proxy = new AspectJProxyFactory(new GenerationRateLimitService());
            proxy.addAspect(new RateLimitAspect(limiterRedis, users));
            GenerationTaskCoordinator coordinator = coordinator(proxy.getProxy());
            var subscriptions = new TaskEventSubscriptions(coordinator, store, events, mapper);
            try {
                MockMvc mvc = MockMvcBuilders.standaloneSetup(new AppController(mock(AppService.class), users,
                                mock(ProjectDownloadService.class), workspace, coordinator, subscriptions))
                        .setControllerAdvice(new GlobalExceptionHandler())
                        .setMessageConverters(new MappingJackson2HttpMessageConverter(mapper)).build();
                var gate = new CountDownLatch(1);
                var first = callers.submit(() -> {
                    waitFor(gate);
                    return submit(mvc, app, "request");
                });
                var duplicate = callers.submit(() -> {
                    waitFor(gate);
                    return submit(mvc, app, "request");
                });
                gate.countDown();
                JsonNode response = first.get(10, TimeUnit.SECONDS).path("data");
                JsonNode repeated = duplicate.get(10, TimeUnit.SECONDS).path("data");
                UUID id = UUID.fromString(response.path("taskId").asText());
                assertThat(repeated.path("taskId").asText()).isEqualTo(id.toString());
                assertThat(List.of(response.path("reused").asBoolean(), repeated.path("reused").asBoolean()))
                        .containsExactlyInAnyOrder(true, false);
                assertThat(response.path("appId").textValue()).isEqualTo(Long.toString(app));
                assertThat(entered.await(10, TimeUnit.SECONDS)).isTrue();

                var conflict = submit(mvc, app, "other").path("data");
                assertThat(conflict.path("taskId").asText()).isEqualTo(id.toString());
                assertThat(conflict.path("conflict").asBoolean()).isTrue();
                assertThat(submit(mvc, app + 1, "other").path("code").asInt()).isEqualTo(42900);
                assertThatThrownBy(() -> coordinator.deleteApp(app)).isInstanceOf(BusinessException.class)
                        .hasMessageContaining("正在生成");
                assertThat(coordinator.active(app, user).taskId()).isEqualTo(id);

                MvcResult legacy = mvc.perform(get("/app/chat/gen/code").param("appId", Long.toString(app))
                                .param("message", "旧入口").accept(MediaType.TEXT_EVENT_STREAM)).andReturn();
                MvcResult original = mvc.perform(get("/app/chat/tasks/{id}/events", id)).andReturn();
                var firstFrame = events.read(id, "0-0").getFirst();
                String after = firstFrame.getId().getValue();
                MvcResult reconnected = mvc.perform(get("/app/chat/tasks/{id}/events", id)
                        .header("Last-Event-ID", after).param("lastEventId", "1-1")).andReturn();
                finish.countDown();

                String full = responseStream(original);
                String resumed = responseStream(reconnected);
                String oldContract = responseStream(legacy);
                assertThat(full).contains("id:" + after, "event:message", "event:status", "event:done",
                        "\"tool_failed\"", "\"building\"", "\"repairing\"", "\"committing\"");
                assertThat(resumed).isEqualTo(full.substring(full.indexOf("\n\n") + 2));
                assertThat(oldContract).contains("第一行", "第二行", "event:done").doesNotContain("event:message", "\"phase\"");
                assertThat(runs.get()).isEqualTo(1);
                assertThat(committed).hasSize(1);
                assertThat(committed.get(id.toString()).path("content").textValue()).isEqualTo(BODY);
                await().atMost(WAIT).untilAsserted(() -> assertThat(coordinator.active(app, user).status()).isEqualTo("succeeded"));
                assertThat(coordinator.active(app, user).resultCommitted()).isTrue();
                assertThat(coordinator.active(app, user).streamAvailable()).isTrue();

                redis.delete(prefix + "stream:" + id);
                MvcResult expired = mvc.perform(get("/app/chat/tasks/{id}/events", id)
                        .param("lastEventId", after)).andReturn();
                assertThat(responseStream(expired)).contains("event:status", "resync_required").doesNotContain("event:done");
                assertThat(coordinator.active(app, user).streamAvailable()).isFalse();
                assertThat(coordinator.active(app, user).taskId()).isEqualTo(id);
            } finally {
                finish.countDown();
                subscriptions.shutdown();
            }
        } finally {
            limiterRedis.getRateLimiter(rateKey).delete();
            limiterRedis.shutdown();
        }
    }

    @ParameterizedTest
    @EnumSource(value = CrashPoint.class, names = {"AFTER_BACKUP", "AFTER_CURRENT", "BEFORE_HISTORY", "AFTER_HISTORY",
            "BEFORE_RESTORE", "AFTER_RESTORE", "NEW_APP_DELIVERY_FAILED"})
    void resumesFromThePersistedPhaseWithoutRepeatingTheRunOrDuplicatingHistory(CrashPoint point) throws Exception {
        boolean newApp = point == CrashPoint.NEW_APP_DELIVERY_FAILED;
        boolean mustRestore = point == CrashPoint.BEFORE_RESTORE || point == CrashPoint.AFTER_RESTORE || newApp;
        GenerationTask task = seedTask();
        if (!newApp) {
            Files.createDirectories(task.paths().current());
            Files.writeString(task.paths().current().resolve("index.html"), OLD);
        }
        manager.failDelivery = mustRestore;
        crash.set(point);
        var before = coordinator(mock(GenerationRateLimitService.class));
        assertThatThrownBy(() -> before.runOrRecover(task.id(), app)).isSameAs(CRASH);
        before.shutdown();

        GenerationTask saved = store.byId(task.id());
        assertThat(saved.status()).isEqualTo(GenerationTask.Status.COMMITTING);
        assertThat(mapper.readTree(saved.commitPayload()).path("content").asText()).isEqualTo(BODY);
        if (mustRestore) {
            assertThat(saved.phase()).isEqualTo(GenerationTask.Phase.RESTORING);
            assertThat(mapper.readTree(saved.commitPayload()).path("status").asText()).isEqualTo("failed");
        }
        if (point == CrashPoint.AFTER_BACKUP) {
            assertThat(saved.phase()).isEqualTo(GenerationTask.Phase.CURRENT_TO_BACKUP);
            assertThat(saved.paths().current()).doesNotExist();
            assertThat(saved.paths().backup().resolve("index.html")).hasContent(OLD);
        }
        if (point == CrashPoint.AFTER_CURRENT) {
            assertThat(saved.phase()).isEqualTo(GenerationTask.Phase.STAGING_TO_CURRENT);
            assertThat(saved.paths().current().resolve("index.html")).hasContent(NEW);
            assertThat(saved.paths().staging()).doesNotExist();
        }
        if (point == CrashPoint.AFTER_HISTORY) {
            assertThat(saved.phase()).isEqualTo(GenerationTask.Phase.DELIVERED);
            assertThat(committed).hasSize(1);
            assertThat(saved.resultCommitted()).isFalse();
        }

        expireLease();
        coordinator(mock(GenerationRateLimitService.class)).runOrRecover(task.id(), app);
        assertThat(store.byId(task.id()).status()).isEqualTo(mustRestore ? GenerationTask.Status.FAILED : GenerationTask.Status.SUCCEEDED);
        assertThat(store.byId(task.id()).resultCommitted()).isTrue();
        assertThat(runs.get()).isEqualTo(1);
        assertThat(committed).hasSize(1);
        assertThat(committed.get(task.id().toString()).path("content").asText()).isEqualTo(BODY);
        assertThat(attempts.get()).isEqualTo(point == CrashPoint.AFTER_HISTORY ? 2 : 1);
        if (newApp) {
            assertThat(task.paths().current()).doesNotExist();
        } else {
            assertThat(task.paths().current().resolve("index.html")).hasContent(mustRestore ? OLD : NEW);
        }
        assertThat(task.paths().staging()).doesNotExist();
        assertThat(task.paths().backup()).doesNotExist();
        assertThat(events.read(task.id(), "0-0").getLast().getValue().get("event"))
                .isEqualTo(mustRestore ? "business-error" : "done");
    }

    @Test
    void expiredRunningOwnerCannotDeliverEvenAfterTheSameTaskIsRecovered() throws Exception {
        GenerationTask task = seedTask();
        var ran = new CountDownLatch(1);
        var releasePython = new CountDownLatch(1);
        runScript.set((exchange, request) -> {
            startEvents(exchange);
            Files.writeString(staging(request).resolve("index.html"), NEW);
            ran.countDown();
            waitFor(releasePython);
            send(exchange, "delta", Map.of("text", "stale"));
            send(exchange, "completed", Map.of("content", BODY));
        });
        var old = coordinator(mock(GenerationRateLimitService.class));
        var recovery = coordinator(mock(GenerationRateLimitService.class));
        try (var caller = Executors.newVirtualThreadPerTaskExecutor()) {
            var running = caller.submit(() -> old.runOrRecover(task.id(), app));
            try {
                assertThat(ran.await(10, TimeUnit.SECONDS)).isTrue();
                expireLease();
                recovery.runOrRecover(task.id(), app);
            } finally {
                releasePython.countDown();
            }
            running.get(10, TimeUnit.SECONDS);
        }
        assertThat(store.byId(task.id()).status()).isEqualTo(GenerationTask.Status.FAILED);
        assertThat(task.paths().current()).doesNotExist();
        assertThat(runs.get()).isEqualTo(1);
        assertThat(committed).hasSize(1);
        var frames = events.read(task.id(), "0-0");
        assertThat(frames).noneMatch(event -> event.getValue().get("data").contains("stale"));
        assertThat(frames.getLast().getValue().get("data")).contains("GENERATION_INTERRUPTED");
    }

    @Test
    void committingTaskKeepsDeliveryAuthorityAfterRedisExpiryAndBlocksAnotherSubmission() throws Exception {
        GenerationTask task = seedTask();
        manager.holdDelivery = true;
        var active = coordinator(mock(GenerationRateLimitService.class));
        var other = coordinator(mock(GenerationRateLimitService.class));
        try (var caller = Executors.newVirtualThreadPerTaskExecutor()) {
            var committing = caller.submit(() -> active.runOrRecover(task.id(), app));
            try {
                assertThat(manager.insideMove.await(10, TimeUnit.SECONDS)).isTrue();
                assertThat(store.byId(task.id()).status()).isEqualTo(GenerationTask.Status.COMMITTING);
                expireLease();
                other.runOrRecover(task.id(), app);
                var collision = other.submit(app, "second", "collision", user);
                assertThat(collision.conflict()).isTrue();
                assertThat(collision.taskId()).isEqualTo(task.id());
                assertThat(jdbc.queryForObject("SELECT count(*) FROM generation_task WHERE app_id=?", Integer.class, app))
                        .isEqualTo(1);
            } finally {
                manager.allowMove.countDown();
            }
            committing.get(10, TimeUnit.SECONDS);
        }
        assertThat(store.byId(task.id()).status()).isEqualTo(GenerationTask.Status.SUCCEEDED);
        assertThat(task.paths().current().resolve("index.html")).hasContent(NEW);
        assertThat(events.read(task.id(), "0-0").getLast().getValue().get("event")).isEqualTo("done");
        assertThat(runs.get()).isEqualTo(1);
    }

    @Test
    void missingPythonUserMessageIsRegisteredOnlyForConfirmed404AndNeverRestartsGeneration() throws Exception {
        GenerationTask task = seedTask();
        Files.createDirectories(task.paths().staging());

        coordinator(mock(GenerationRateLimitService.class)).runOrRecover(task.id(), app);

        assertThat(store.byId(task.id()).status()).isEqualTo(GenerationTask.Status.FAILED);
        assertThat(runs.get()).isZero();
        assertThat(registrationRequests.get()).isEqualTo(1);
        assertThat(registered).containsEntry(task.id().toString(), "原始用户消息");
        assertThat(attempts.get()).isEqualTo(2);
        assertThat(committed).hasSize(1);
        assertThat(committed.get(task.id().toString()).path("status").asText()).isEqualTo("failed");
        assertThat(task.paths().current()).doesNotExist();
    }

    @Test
    void initializationHistoryConflictAndDeletionDoNotConsumeQuota() {
        var rate = mock(GenerationRateLimitService.class);
        var coordinator = coordinator(rate);
        registered.put("migrated", "legacy");
        var conflict = coordinator.submit(app, "init", "init:" + app, user);
        assertThat(conflict.code()).isEqualTo("HISTORY_EXISTS");
        assertThat(conflict.taskId()).isNull();
        assertThat(conflict.conflict()).isTrue();

        assertThat(coordinator.deleteApp(app)).isTrue();
        assertThatThrownBy(() -> coordinator.submit(app, "regular", "different", user))
                .isInstanceOf(BusinessException.class).hasMessageContaining("删除");
        await().atMost(WAIT).until(() -> store.pendingHistoryDeletions().stream().noneMatch(id -> id == app));
        verifyNoInteractions(rate);
        assertThat(runs.get()).isZero();
    }

    @Test
    void initializationHistoryTimeoutLeavesQuotaAndTaskTableUntouched() throws Exception {
        var entered = new CountDownLatch(1);
        var release = new CountDownLatch(1);
        getHistoryHook.set(() -> {
            entered.countDown();
            waitFor(release);
        });
        var rate = mock(GenerationRateLimitService.class);
        var coordinator = coordinator(rate);
        try (var caller = Executors.newVirtualThreadPerTaskExecutor()) {
            var request = caller.submit(() -> assertThatThrownBy(
                    () -> coordinator.submit(app, "init", "init:" + app, user))
                    .isInstanceOf(BusinessException.class).hasMessageContaining("稍后重试"));
            try {
                assertThat(entered.await(5, TimeUnit.SECONDS)).isTrue();
                request.get(5, TimeUnit.SECONDS);
            } finally {
                release.countDown();
            }
        }
        verifyNoInteractions(rate);
        assertThat(coordinator.active(app, user)).isNull();
        assertThat(runs.get()).isZero();
    }

    @ParameterizedTest
    @ValueSource(ints = {404, 409, 503})
    void unrelatedCommitErrorsKeepTheTaskCommittingAndDoNotRegisterMissingHistory(int httpStatus) throws Exception {
        GenerationTask task = seedTask();
        Files.createDirectories(task.paths().staging());
        forcedCommitStatus.set(httpStatus);

        var active = coordinator(mock(GenerationRateLimitService.class));
        assertThatThrownBy(() -> active.runOrRecover(task.id(), app)).isInstanceOf(PythonAgentClient.AgentException.class);
        assertThat(store.byId(task.id()).status()).isEqualTo(GenerationTask.Status.COMMITTING);
        assertThat(store.byId(task.id()).resultCommitted()).isFalse();
        assertThat(registrationRequests.get()).isZero();
        assertThat(runs.get()).isZero();
        assertThat(active.submit(app, "new", "another", user).taskId()).isEqualTo(task.id());
        assertThat(events.read(task.id(), "0-0")).noneMatch(frame -> frame.getValue().get("event").equals("business-error"));
    }

    @Test
    void submissionRacingWithAnInProgressHistoryDeletionSeesTheDeletedApp() throws Exception {
        var entered = new CountDownLatch(1);
        var release = new CountDownLatch(1);
        deleteHistoryHook.set(() -> {
            entered.countDown();
            waitFor(release);
        });
        var rate = mock(GenerationRateLimitService.class);
        var coordinator = coordinator(rate);
        try (var caller = Executors.newVirtualThreadPerTaskExecutor()) {
            assertThat(coordinator.deleteApp(app)).isTrue();
            try {
                assertThat(entered.await(10, TimeUnit.SECONDS)).isTrue();
                var submission = caller.submit(() -> assertThatThrownBy(
                        () -> coordinator.submit(app, "regular", "different", user))
                        .isInstanceOf(BusinessException.class).hasMessageContaining("删除"));
                release.countDown();
                submission.get(10, TimeUnit.SECONDS);
            } finally {
                release.countDown();
            }
        }
        verifyNoInteractions(rate);
        assertThat(runs.get()).isZero();
    }

    private void expireLease() {
        assertThat(redis.expire(prefix + "lease:" + app, Duration.ofMillis(50))).isTrue();
        assertThat(redis.expire(prefix + "lease:" + app + ":fence", Duration.ofMillis(50))).isTrue();
        await().pollInterval(Duration.ofMillis(15)).atMost(WAIT)
                .until(() -> !Boolean.TRUE.equals(redis.hasKey(prefix + "lease:" + app)));
    }

    private GenerationTask seedTask() {
        UUID id = UUID.randomUUID();
        var task = new GenerationTask(id, app, user, "request", "html", "原始用户消息", GenerationTask.Status.RUNNING,
                null, null, null, null, manager.paths(app, "html", id), null, false, false);
        store.admission(app, session -> {
            session.create(task);
            return null;
        });
        return task;
    }

    private GenerationTaskCoordinator coordinator(GenerationRateLimitService rate) {
        var coordinator = new GenerationTaskCoordinator(store, events, manager, rate, agent, mapper);
        coordinators.add(coordinator);
        return coordinator;
    }

    private void addApp(long id) {
        jdbc.update("INSERT INTO app (id, \"userId\", \"codeGenType\", \"initPrompt\") VALUES (?, ?, 'html', 'init')",
                id, user);
    }

    private JsonNode submit(MockMvc mvc, long appId, String requestId) throws Exception {
        return mapper.readTree(mvc.perform(post("/app/chat/tasks").contentType(MediaType.APPLICATION_JSON)
                        .content(mapper.writeValueAsString(Map.of("appId", Long.toString(appId), "message", "指令",
                                "clientRequestId", requestId))))
                .andReturn().getResponse().getContentAsByteArray());
    }

    private static String responseStream(MvcResult result) throws Exception {
        result.getAsyncResult(10_000);
        return result.getResponse().getContentAsString(StandardCharsets.UTF_8);
    }

    private void generate(HttpExchange exchange) throws IOException {
        try (exchange) {
            var request = mapper.readTree(exchange.getRequestBody());
            runs.incrementAndGet();
            registered.put(request.path("taskId").asText(), request.path("message").asText());
            runScript.get().run(exchange, request);
        }
    }

    private void completeNormally(HttpExchange exchange, JsonNode request) throws IOException {
        startEvents(exchange);
        Files.writeString(staging(request).resolve("index.html"), NEW);
        send(exchange, "delta", Map.of("text", BODY));
        send(exchange, "completed", Map.of("content", BODY, "buildResult", Map.of("success", true)));
    }

    private Path staging(JsonNode request) {
        return workspace.getCodeStagingRootDir().resolve(request.path("codeGenType").asText() + "_"
                + request.path("appId").asText()).resolve(request.path("taskId").asText());
    }

    private static void startEvents(HttpExchange exchange) throws IOException {
        exchange.getResponseHeaders().set("Content-Type", "text/event-stream");
        exchange.sendResponseHeaders(200, 0);
    }

    private void send(HttpExchange exchange, String type, Object payload) throws IOException {
        var output = exchange.getResponseBody();
        output.write(("event: " + type + "\ndata: " + mapper.writeValueAsString(payload) + "\n\n")
                .getBytes(StandardCharsets.UTF_8));
        output.flush();
    }

    private void history(HttpExchange exchange) throws IOException {
        try (exchange) {
            if (exchange.getRequestMethod().equals("GET")) {
                byte[] data = (registered.isEmpty() ? "{\"records\":[],\"totalRow\":0}"
                        : "{\"records\":[{}],\"totalRow\":1}").getBytes(StandardCharsets.UTF_8);
                exchange.sendResponseHeaders(200, data.length);
                getHistoryHook.get().run();
                exchange.getResponseBody().write(data);
                return;
            }
            if (exchange.getRequestMethod().equals("DELETE")) {
                deleteHistoryHook.get().run();
                exchange.sendResponseHeaders(204, -1);
                return;
            }
            var result = mapper.readTree(exchange.getRequestBody());
            String taskId = result.path("taskId").asText();
            int status = 200;
            if (exchange.getRequestURI().getPath().endsWith("/commit-result")) {
                attempts.incrementAndGet();
                int forced = forcedCommitStatus.get();
                if (forced != 0) {
                    byte[] message = "{\"detail\":\"HTTP 接口不可用\"}".getBytes(StandardCharsets.UTF_8);
                    exchange.sendResponseHeaders(forced, message.length);
                    exchange.getResponseBody().write(message);
                    return;
                }
                if (!registered.containsKey(taskId)) {
                    status = 404;
                } else {
                    JsonNode existing = committed.putIfAbsent(taskId, result);
                    if (existing != null && !existing.equals(result)) {
                        status = 409;
                    }
                }
            } else {
                registrationRequests.incrementAndGet();
                registered.putIfAbsent(taskId, result.path("message").asText());
            }
            if (status == 404) {
                byte[] data = "{\"detail\":\"生成任务对应的用户消息不存在\"}".getBytes(StandardCharsets.UTF_8);
                exchange.sendResponseHeaders(status, data.length);
                exchange.getResponseBody().write(data);
            } else {
                exchange.sendResponseHeaders(status, -1);
            }
        }
    }

    private void crashAt(CrashPoint point) {
        if (crash.compareAndSet(point, null)) {
            throw CRASH;
        }
    }

    private static void waitFor(CountDownLatch latch) {
        try {
            if (!latch.await(15, TimeUnit.SECONDS)) {
                throw new IllegalStateException("等待测试故障注入超时");
            }
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException(error);
        }
    }

    @FunctionalInterface
    private interface RunScript {
        void run(HttpExchange exchange, JsonNode request) throws IOException;
    }

    private enum CrashPoint {
        AFTER_BACKUP, AFTER_CURRENT, BEFORE_HISTORY, AFTER_HISTORY, BEFORE_RESTORE, AFTER_RESTORE, NEW_APP_DELIVERY_FAILED
    }

    private static final class Crash extends Error {
    }

    private final class FaultyWorkspace extends WorkspaceStagingManager {
        private final CountDownLatch insideMove = new CountDownLatch(1);
        private final CountDownLatch allowMove = new CountDownLatch(1);
        private boolean holdDelivery;
        private boolean failDelivery;

        FaultyWorkspace(WorkspaceProperties workspace) {
            super(workspace);
        }

        @Override
        void atomicMove(Path source, Path target) throws IOException {
            if (target.getFileName().toString().endsWith(".bak")) {
                super.atomicMove(source, target);
                crashAt(CrashPoint.AFTER_BACKUP);
                return;
            }
            if (source.getFileName().toString().endsWith(".bak")) {
                crashAt(CrashPoint.BEFORE_RESTORE);
                super.atomicMove(source, target);
                crashAt(CrashPoint.AFTER_RESTORE);
                return;
            }
            if (holdDelivery) {
                insideMove.countDown();
                waitFor(allowMove);
            }
            if (failDelivery) {
                throw new IOException("模拟文件占用");
            }
            super.atomicMove(source, target);
            crashAt(CrashPoint.AFTER_CURRENT);
        }

        @Override
        void restore(GenerationTask task) throws IOException {
            crashAt(CrashPoint.NEW_APP_DELIVERY_FAILED);
            super.restore(task);
        }
    }
}
