package com.zdan.paimengaicodemother.controller;

import com.zdan.paimengaicodemother.exception.BusinessException;
import com.zdan.paimengaicodemother.exception.ErrorCode;
import com.zdan.paimengaicodemother.exception.GlobalExceptionHandler;
import com.zdan.paimengaicodemother.model.entity.User;
import com.zdan.paimengaicodemother.service.UserService;
import com.zdan.paimengaicodemother.task.TaskEventSubscriptions;
import jakarta.servlet.http.HttpServletRequest;
import java.util.UUID;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

class TaskEventsAuthorizationTest {

    @ParameterizedTest
    @EnumSource(value = ErrorCode.class, names = {"NOT_LOGIN_ERROR", "NO_AUTH_ERROR", "NOT_FOUND_ERROR"})
    void rejectsUnavailableTaskBeforeOpeningEventStream(ErrorCode error) throws Exception {
        var users = mock(UserService.class);
        var subscriptions = mock(TaskEventSubscriptions.class);
        var taskId = UUID.randomUUID();
        var cursor = "1781000300000-0";
        var user = new User();
        user.setId(42L);

        if (error == ErrorCode.NOT_LOGIN_ERROR) {
            when(users.getLoginUser(any(HttpServletRequest.class))).thenThrow(new BusinessException(error));
        } else {
            when(users.getLoginUser(any(HttpServletRequest.class))).thenReturn(user);
            when(subscriptions.subscribe(taskId, user.getId(), cursor, false)).thenThrow(new BusinessException(error));
        }

        int expectedStatus = switch (error) {
            case NOT_LOGIN_ERROR -> 401;
            case NO_AUTH_ERROR -> 403;
            case NOT_FOUND_ERROR -> 404;
            default -> throw new IllegalArgumentException(error.name());
        };

        var mvc = MockMvcBuilders.standaloneSetup(new AppController(null, users, null, null, null, subscriptions))
                .setControllerAdvice(new GlobalExceptionHandler())
                .build();
        mvc.perform(get("/app/chat/tasks/{taskId}/events", taskId)
                        .accept(MediaType.TEXT_EVENT_STREAM)
                        .header("Last-Event-ID", cursor))
                .andExpect(status().is(expectedStatus))
                .andExpect(content().string(""));
    }
}
