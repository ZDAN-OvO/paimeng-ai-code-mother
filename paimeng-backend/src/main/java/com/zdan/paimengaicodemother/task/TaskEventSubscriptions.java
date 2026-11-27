package com.zdan.paimengaicodemother.task;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.PreDestroy;
import java.io.IOException;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Pattern;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

@Slf4j
@Service
public class TaskEventSubscriptions {
    private static final String BEGINNING = "0-0";
    private static final Pattern EVENT_ID = Pattern.compile("[0-9]{1,19}-[0-9]{1,19}");

    private final GenerationTaskCoordinator coordinator;
    private final GenerationTaskStore store;
    private final TaskEventStreamService events;
    private final ObjectMapper mapper;
    private final ExecutorService readers = Executors.newVirtualThreadPerTaskExecutor();

    public TaskEventSubscriptions(GenerationTaskCoordinator coordinator, GenerationTaskStore store,
                                  TaskEventStreamService events, ObjectMapper mapper) {
        this.coordinator = coordinator;
        this.store = store;
        this.events = events;
        this.mapper = mapper;
    }

    public SseEmitter subscribe(UUID id, long userId, String cursor, boolean legacy) {
        coordinator.authorizedTask(id, userId);
        SseEmitter emitter = new SseEmitter(0L);
        var stopped = new AtomicBoolean();
        emitter.onCompletion(() -> stopped.set(true));
        emitter.onTimeout(() -> stopped.set(true));
        emitter.onError(error -> stopped.set(true));
        readers.execute(() -> follow(id, cursor, legacy, emitter, stopped));
        return emitter;
    }

    private void follow(UUID id, String cursor, boolean legacy, SseEmitter emitter, AtomicBoolean stopped) {
        String after = cursor == null || cursor.isEmpty() ? BEGINNING : cursor;
        try {
            if (!EVENT_ID.matcher(after).matches() || (!after.equals(BEGINNING) && !events.contains(id, after))) {
                resync(id, BEGINNING, legacy, emitter);
                return;
            }
            int idle = 0;
            while (!stopped.get() && !Thread.currentThread().isInterrupted()) {
                if (after.equals(events.terminalId(id))) {
                    return;
                }
                var records = events.read(id, after);
                if (records == null || records.isEmpty()) {
                    GenerationTask task = store.byId(id);
                    if (task.status().terminal() && !events.available(id)) {
                        resync(id, after, legacy, emitter);
                        return;
                    }
                    if (++idle == 15) {
                        emitter.send(SseEmitter.event().id(after).comment("keepalive"));
                        idle = 0;
                    }
                    continue;
                }
                idle = 0;
                for (var record : records) {
                    if (stopped.get()) {
                        return;
                    }
                    after = record.getId().getValue();
                    String name = record.getValue().get("event");
                    String data = record.getValue().get("data");
                    if (legacy) {
                        sendLegacy(emitter, after, name, data);
                    } else {
                        emitter.send(SseEmitter.event().id(after).name(name).data(data));
                    }
                    if (name.equals("done") || name.equals("business-error")) {
                        return;
                    }
                }
            }
        } catch (IOException disconnect) {
            log.debug("事件订阅已断开，taskId={}", id);
        } catch (RuntimeException error) {
            log.warn("读取任务流失败，taskId={}", id, error);
        } finally {
            emitter.complete();
        }
    }

    private void sendLegacy(SseEmitter emitter, String id, String name, String data) throws IOException {
        switch (name) {
            case "message" -> {
                JsonNode chunk = mapper.readTree(data).path("d");
                emitter.send(SseEmitter.event().id(id).data(mapper.writeValueAsString(Map.of("d", chunk.asText()))));
            }
            case "done" -> emitter.send(SseEmitter.event().id(id).name("done").data("{}"));
            case "business-error" -> {
                var error = mapper.readTree(data);
                emitter.send(SseEmitter.event().id(id).name(name).data(mapper.writeValueAsString(Map.of(
                        "error", true, "code", error.path("code").asText(), "message", error.path("message").asText()))));
            }
            default -> { }
        }
    }

    private void resync(UUID taskId, String id, boolean legacy, SseEmitter emitter) throws IOException {
        String message = "任务事件已过期，请重新加载对话历史";
        if (legacy) {
            emitter.send(SseEmitter.event().id(id).name("business-error").data(mapper.writeValueAsString(Map.of(
                    "error", true, "code", "RESYNC_REQUIRED", "message", message))));
        } else {
            emitter.send(SseEmitter.event().id(id).name("status").data(mapper.writeValueAsString(Map.of(
                    "taskId", taskId.toString(), "phase", "resync_required", "message", message))));
        }
    }

    @PreDestroy
    void shutdown() {
        readers.shutdownNow();
    }
}
