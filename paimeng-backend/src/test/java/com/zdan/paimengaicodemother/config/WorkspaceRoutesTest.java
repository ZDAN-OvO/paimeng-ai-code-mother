package com.zdan.paimengaicodemother.config;

import com.zdan.paimengaicodemother.controller.AppController;
import com.zdan.paimengaicodemother.controller.StaticResourceController;
import com.zdan.paimengaicodemother.model.entity.App;
import com.zdan.paimengaicodemother.model.entity.User;
import com.zdan.paimengaicodemother.service.AppService;
import com.zdan.paimengaicodemother.service.UserService;
import com.zdan.paimengaicodemother.service.impl.ProjectDownloadServiceImpl;
import jakarta.servlet.http.HttpServletRequest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.zip.ZipInputStream;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

class WorkspaceRoutesTest {

    @TempDir
    Path repo;

    @Test
    void previewAndDownloadReadTheSameExistingProjectFromBothWorkingDirectories() throws Exception {
        Path backend = Files.createDirectory(repo.resolve("paimeng-backend"));
        Path project = Files.createDirectories(repo.resolve("tmp/code_output/html_42"));
        byte[] index = "<!doctype html><p>Existing project</p>".getBytes(StandardCharsets.UTF_8);
        Files.write(project.resolve("index.html"), index);

        App app = new App();
        app.setCodeGenType("html");
        app.setUserId(7L);
        User owner = new User();
        owner.setId(7L);

        AppService appService = mock(AppService.class);
        when(appService.getById(42L)).thenReturn(app);
        UserService userService = mock(UserService.class);
        when(userService.getLoginUser(any(HttpServletRequest.class))).thenReturn(owner);

        for (Path workingDirectory : List.of(repo, backend)) {
            WorkspaceProperties workspace = new WorkspaceProperties(
                    workingDirectory, null, "code_output", "code_staging", "code_deploy", "screenshots");
            MockMvc mvc = MockMvcBuilders.standaloneSetup(
                    new StaticResourceController(workspace),
                    new AppController(appService, userService, new ProjectDownloadServiceImpl(), workspace)).build();

            mvc.perform(get("/static/html_42/"))
                    .andExpect(status().isOk())
                    .andExpect(content().bytes(index));
            byte[] download = mvc.perform(get("/app/download/42"))
                    .andExpect(status().isOk())
                    .andExpect(content().contentType("application/zip"))
                    .andReturn().getResponse().getContentAsByteArray();
            try (ZipInputStream zip = new ZipInputStream(new ByteArrayInputStream(download))) {
                assertEquals("index.html", zip.getNextEntry().getName());
                assertArrayEquals(index, zip.readAllBytes());
            }
        }
    }
}
