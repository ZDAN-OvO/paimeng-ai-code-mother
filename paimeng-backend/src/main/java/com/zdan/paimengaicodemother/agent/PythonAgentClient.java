package com.zdan.paimengaicodemother.agent;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.zdan.paimengaicodemother.model.dto.chathistory.ChatHistoryQueryRequest;
import com.zdan.paimengaicodemother.model.entity.ChatHistory;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.function.Consumer;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.stereotype.Component;
import org.springframework.web.util.UriComponentsBuilder;

@Component
@EnableConfigurationProperties(AgentServiceProperties.class)
public class PythonAgentClient {
    private static final Duration REQUEST_TIMEOUT = Duration.ofSeconds(10);
    private static final DateTimeFormatter HISTORY_TIME = DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm:ss");

    private final AgentServiceProperties properties;
    private final ObjectMapper mapper;
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2)).build();

    public PythonAgentClient(AgentServiceProperties properties, ObjectMapper mapper) {
        this.properties = properties;
        this.mapper = mapper;
    }

    public String route(String initPrompt) {
        return json("routing/code-gen-type", "POST", Map.of("initPrompt", initPrompt), JsonNode.class)
                .path("codeGenType").asText();
    }

    public HistoryPage appHistory(long appId, int pageSize, LocalDateTime time, Long lastId) {
        return appHistory(appId, pageSize, time, lastId, REQUEST_TIMEOUT);
    }

    public boolean hasHistory(long appId) {
        return !appHistory(appId, 1, null, null, Duration.ofSeconds(2)).records().isEmpty();
    }

    private HistoryPage appHistory(long appId, int pageSize, LocalDateTime time, Long lastId, Duration timeout) {
        var query = UriComponentsBuilder.fromPath(appPath(appId) + "/messages").queryParam("pageSize", pageSize);
        if (time != null) {
            query.queryParam("lastCreateTime", time.format(HISTORY_TIME));
        }
        if (lastId != null) {
            query.queryParam("lastId", lastId);
        }
        return exchange(request(query.build().toUriString(), timeout).GET().build(), HistoryPage.class);
    }

    public HistoryPage adminHistory(ChatHistoryQueryRequest query) {
        ObjectNode body = mapper.valueToTree(query);
        if (query.getLastCreateTime() != null) {
            body.put("lastCreateTime", query.getLastCreateTime().format(HISTORY_TIME));
        }
        if (query.getSortField() == null || query.getSortField().isBlank()) {
            body.remove("sortField");
        }
        if (body.has("sortField") && "ascend".equals(query.getSortOrder())) {
            body.put("sortOrder", "ascend");
        } else {
            body.put("sortOrder", "descend");
        }
        if (query.getMessageType() == null || query.getMessageType().isBlank()) {
            body.remove("messageType");
        } else {
            body.put("messageType", query.getMessageType().stripTrailing().toLowerCase(java.util.Locale.ROOT));
        }
        return json("admin/messages/page", "POST", body, HistoryPage.class);
    }

    public void deleteHistory(long appId) {
        json(appPath(appId) + "/history", "DELETE", null, Void.class);
    }

    public void registerFailedGeneration(long appId, String taskId, String userId, String message) {
        json(appPath(appId) + "/messages", "POST",
                Map.of("taskId", taskId, "userId", userId, "messageType", "user", "message", message), Void.class);
    }

    public void commitResult(long appId, CommitResult result) {
        json(appPath(appId) + "/messages/commit-result", "POST", result, Void.class);
    }

    public void generate(GenerationRequest body, Consumer<GenerationEvent> consumer) {
        var request = request("generation/runs", REQUEST_TIMEOUT).header("Accept", "text/event-stream");
        try {
            var response = http.send(withBody(request, "POST", body), HttpResponse.BodyHandlers.ofInputStream());
            try (InputStream stream = response.body()) {
                requireSuccess(response.statusCode(), null);
                try (var lines = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
                    readEvents(lines, consumer);
                }
            }
        } catch (IOException e) {
            throw new AgentException("读取生成事件失败", e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new AgentException("读取生成事件被中断", e);
        }
    }

    private void readEvents(BufferedReader lines, Consumer<GenerationEvent> consumer) throws IOException {
        String type = null;
        var data = new StringBuilder();
        for (String line; (line = lines.readLine()) != null; ) {
            if (line.isEmpty()) {
                if (type != null && !data.isEmpty()) {
                    consumer.accept(new GenerationEvent(type, mapper.readTree(data.toString())));
                    if (type.equals("completed") || type.equals("failed")) {
                        return;
                    }
                }
                type = null;
                data.setLength(0);
            } else if (line.startsWith("event:")) {
                type = sseValue(line, 6);
            } else if (line.startsWith("data:")) {
                if (!data.isEmpty()) {
                    data.append('\n');
                }
                data.append(sseValue(line, 5));
            }
        }
        throw new AgentException("生成连接在结果事件前关闭", null);
    }


    private static String sseValue(String line, int from) {
        if (line.length() > from && line.charAt(from) == ' ') {
            from++;
        }
        return line.substring(from);
    }

    private <T> T json(String path, String method, Object body, Class<T> resultType) {
        return exchange(withBody(request(path, REQUEST_TIMEOUT), method, body), resultType);
    }

    private <T> T exchange(HttpRequest request, Class<T> resultType) {
        var pending = http.sendAsync(request, HttpResponse.BodyHandlers.ofByteArray());
        try {
            // 请求期限覆盖完整响应体，防止历史复查持续占用准入锁。
            var response = pending.get(request.timeout().orElse(REQUEST_TIMEOUT).toMillis(), TimeUnit.MILLISECONDS);
            requireSuccess(response.statusCode(), response.body());
            return resultType == Void.class ? null : mapper.readValue(response.body(), resultType);
        } catch (IOException | ExecutionException error) {
            throw new AgentException("Python 内部请求失败", error);
        } catch (TimeoutException error) {
            pending.cancel(true);
            throw new AgentException("Python 内部请求超时", error);
        } catch (InterruptedException error) {
            pending.cancel(true);
            Thread.currentThread().interrupt();
            throw new AgentException("Python 内部请求被中断", error);
        }
    }

    private HttpRequest.Builder request(String path, Duration timeout) {
        var uri = URI.create(properties.baseUrl().toString().replaceFirst("/+$", "") + "/internal/v1/" + path);
        return HttpRequest.newBuilder(uri).header("X-Internal-Token", properties.internalToken()).timeout(timeout);
    }

    private HttpRequest withBody(HttpRequest.Builder request, String method, Object body) {
        try {
            if (body == null) {
                return request.method(method, HttpRequest.BodyPublishers.noBody()).build();
            }
            return request.header("Content-Type", "application/json")
                    .method(method, HttpRequest.BodyPublishers.ofByteArray(mapper.writeValueAsBytes(body))).build();
        } catch (IOException e) {
            throw new AgentException("Python 内部请求序列化失败", e);
        }
    }

    private static String appPath(long appId) {
        return "apps/" + appId;
    }

    private void requireSuccess(int status, byte[] body) {
        if (status >= 200 && status < 300) {
            return;
        }
        boolean missingGenerationUser = false;
        if (status == 404 && body != null) {
            try {
                JsonNode error = mapper.readTree(body);
                missingGenerationUser = error != null && "生成任务对应的用户消息不存在".equals(error.path("detail").asText());
            } catch (IOException ignored) {
                // 普通 404 保留为错误，不据此补写历史。
            }
        }
        throw new AgentException(status, missingGenerationUser);
    }

    public record HistoryPage(List<ChatHistory> records, long totalRow) {
    }

    public record GenerationRequest(String appId, String userId, String taskId, String codeGenType, String message) {
    }

    public record GenerationEvent(String type, JsonNode data) {
    }

    @JsonInclude(JsonInclude.Include.ALWAYS)
    public record CommitResult(String taskId, String status, String content, JsonNode buildResult) {
    }

    public static class AgentException extends RuntimeException {
        private final int status;

        private final boolean missingGenerationUser;

        AgentException(int status, boolean missingGenerationUser) {
            super("Python 内部接口返回 HTTP " + status);
            this.status = status;
            this.missingGenerationUser = missingGenerationUser;
        }

        AgentException(String message, Throwable cause) {
            super(message, cause);
            this.status = 0;
            this.missingGenerationUser = false;
        }

        public boolean missingGenerationUser() {
            return missingGenerationUser;
        }

        public int status() {
            return status;
        }
    }
}
