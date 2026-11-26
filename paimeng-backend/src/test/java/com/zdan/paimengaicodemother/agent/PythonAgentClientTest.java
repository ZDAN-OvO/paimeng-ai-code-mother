package com.zdan.paimengaicodemother.agent;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import com.zdan.paimengaicodemother.config.JsonConfig;
import com.zdan.paimengaicodemother.controller.ChatHistoryController;
import com.zdan.paimengaicodemother.model.dto.chathistory.ChatHistoryQueryRequest;
import com.zdan.paimengaicodemother.model.entity.App;
import com.zdan.paimengaicodemother.model.entity.User;
import com.zdan.paimengaicodemother.service.AppService;
import com.zdan.paimengaicodemother.service.UserService;
import com.zdan.paimengaicodemother.service.impl.ChatHistoryServiceImpl;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.converter.json.Jackson2ObjectMapperBuilder;
import org.springframework.http.converter.json.MappingJackson2HttpMessageConverter;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

class PythonAgentClientTest {
    private static final String TOKEN = "test-token";
    private static final long APP = 1900000000000000001L;
    private static final long USER = 1900000000000000002L;
    private static final String TIME = "2026-11-25T21:32:00";
    private static final String TASK = "4caf46cc-6873-42f5-b11c-f9aeeca1af68";

    private final ObjectMapper mapper = new JsonConfig().jacksonObjectMapper(new Jackson2ObjectMapperBuilder());
    private HttpServer server;
    private PythonAgentClient client;

    @BeforeEach
    void start() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        client = new PythonAgentClient(new AgentServiceProperties(
                URI.create("http://127.0.0.1:" + server.getAddress().getPort()), TOKEN), mapper);
        server.start();
    }

    @AfterEach
    void stop() {
        server.stop(0);
    }

    @Test
    void historyCursorRoundTripsFromPythonThroughJavaAndBackWithoutLosingTheSecondOrId() throws Exception {
        var received = new ArrayList<String>();
        server.createContext("/internal/v1/apps/" + APP + "/messages", exchange -> {
            String query = exchange.getRequestURI().getRawQuery();
            received.add(query);
            long id = query.contains("lastId") ? APP - 2 : APP - 1;
            respond(exchange, 200, """
                    {"records":[{"id":"%d","appId":"%d","userId":"%d","messageType":"ai","message":"正文",
                    "createTime":"%s","updateTime":"%s","isDelete":0}],"totalRow":2}
                    """.formatted(id, APP, USER, TIME, TIME));
        });

        AppService apps = mock(AppService.class);
        when(apps.getById(APP)).thenReturn(App.builder().id(APP).userId(USER).build());
        UserService users = mock(UserService.class);
        when(users.getLoginUser(any())).thenReturn(User.builder().id(USER).build());
        var mvc = MockMvcBuilders.standaloneSetup(new ChatHistoryController(new ChatHistoryServiceImpl(apps, client), users))
                .setMessageConverters(new MappingJackson2HttpMessageConverter(mapper)).build();

        var page = mapper.readTree(mvc.perform(get("/chatHistory/app/{id}", APP).param("pageSize", "1"))
                .andReturn().getResponse().getContentAsByteArray()).path("data");
        assertThat(page.path("totalRow").isIntegralNumber()).isTrue();
        assertThat(page.path("totalRow").asInt()).isEqualTo(2);
        var first = page.at("/records/0");
        assertThat(first.path("id").textValue()).isEqualTo(Long.toString(APP - 1));
        assertThat(first.path("createTime").textValue()).isEqualTo(TIME);
        assertThat(first.path("appId").textValue()).isEqualTo(Long.toString(APP));
        assertThat(first.path("userId").textValue()).isEqualTo(Long.toString(USER));

        var second = mapper.readTree(mvc.perform(get("/chatHistory/app/{id}", APP)
                        .param("pageSize", "1").param("lastId", first.path("id").textValue())
                        .param("lastCreateTime", first.path("createTime").textValue()))
                .andReturn().getResponse().getContentAsByteArray()).at("/data/records/0");
        assertThat(second.path("id").textValue()).isEqualTo(Long.toString(APP - 2));
        assertThat(received).containsExactly("pageSize=1",
                "pageSize=1&lastCreateTime=" + TIME + "&lastId=" + (APP - 1));
    }

    @Test
    void sendsAdminFiltersAndPreservesInternalAuthenticationAndResultObject() throws Exception {
        var admin = new AtomicReference<String>();
        var registered = new AtomicReference<String>();
        var committed = new AtomicReference<String>();
        var incomingHeader = new AtomicReference<String>();
        server.createContext("/internal/v1/admin/messages/page", exchange -> {
            admin.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            respond(exchange, 200, "{\"records\":[],\"totalRow\":0}");
        });
        server.createContext("/internal/v1/apps/" + APP + "/messages/commit-result", exchange -> {
            committed.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            respond(exchange, 200, "{}");
        });
        server.createContext("/internal/v1/apps/" + APP + "/messages", exchange -> {
            registered.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            respond(exchange, 200, "{}");
        });
        server.createContext("/internal/v1/routing/code-gen-type", exchange -> {
            incomingHeader.set(exchange.getRequestHeaders().getFirst("X-Internal-Token"));
            respond(exchange, 200, "{\"codeGenType\":\"html\"}");
        });
        server.createContext("/internal/v1/apps/" + APP + "/history", exchange -> respond(exchange, 204, null));

        var query = new ChatHistoryQueryRequest();
        query.setAppId(APP);
        query.setSortField("createTime");
        query.setSortOrder("ascend");
        query.setLastCreateTime(LocalDateTime.parse(TIME));
        query.setPageNum(3);
        assertThat(client.adminHistory(query).records()).isEmpty();
        assertThat(mapper.readTree(admin.get()).path("lastCreateTime").asText()).isEqualTo(TIME);
        assertThat(mapper.readTree(admin.get()).path("pageNum").asInt()).isEqualTo(3);
        assertThat(mapper.readTree(admin.get()).path("appId").textValue()).isEqualTo(Long.toString(APP));
        assertThat(client.route("测试")).isEqualTo("html");
        assertThat(incomingHeader.get()).isEqualTo(TOKEN);
        client.deleteHistory(APP);

        client.registerFailedGeneration(APP, TASK, Long.toString(USER), "原始内容");
        assertThat(mapper.readTree(registered.get()).path("taskId").textValue()).isEqualTo(TASK);
        assertThat(mapper.readTree(registered.get()).path("messageType").textValue()).isEqualTo("user");

        var build = mapper.readTree("{\"ok\":true}");
        client.commitResult(APP, new PythonAgentClient.CommitResult(TASK, "success", "中文", build));
        assertThat(mapper.readTree(committed.get()).path("buildResult")).isEqualTo(build);
        client.commitResult(APP, new PythonAgentClient.CommitResult(TASK, "failed", "", null));
        assertThat(mapper.readTree(committed.get()).path("buildResult").isNull()).isTrue();
    }

    @Test
    void parsesMultilineSseAndDistinguishesAbruptEofFromCandidateResult() {
        var reply = new AtomicReference<>(": keepalive\r\nevent: delta\r\ndata: {\"text\":\r\n"
                + "data: \"  中文  \"}\r\n\r\nevent: completed\r\ndata: {\"content\":\"  中文  \"}\r\n\r\n");
        server.createContext("/internal/v1/generation/runs", exchange -> respond(exchange, 200, reply.get()));

        var request = new PythonAgentClient.GenerationRequest(Long.toString(APP), Long.toString(USER), TASK, "html", "prompt");
        var events = new ArrayList<PythonAgentClient.GenerationEvent>();
        client.generate(request, events::add);
        assertThat(events).extracting(PythonAgentClient.GenerationEvent::type).containsExactly("delta", "completed");
        assertThat(events.getFirst().data().path("text").asText()).isEqualTo("  中文  ");
        reply.set("event: delta\ndata: {\"text\":\"unfinished\"}\n\n");
        assertThatThrownBy(() -> client.generate(request, events::add))
                .isInstanceOf(PythonAgentClient.AgentException.class).hasMessageContaining("关闭");
    }

    private static void respond(HttpExchange exchange, int status, String content) throws IOException {
        try (exchange) {
            byte[] body = content == null ? new byte[0] : content.getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(status, body.length == 0 ? -1 : body.length);
            exchange.getResponseBody().write(body);
        }
    }
}
