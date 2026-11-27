package com.zdan.paimengaicodemother.task;

import com.zdan.paimengaicodemother.config.WorkspaceProperties;
import com.zdan.paimengaicodemother.controller.StaticResourceController;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.http.HttpStatus;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.web.servlet.HandlerMapping;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class WorkspaceStagingTest {
    @TempDir
    Path root;

    @Test
    void copiesTheCurrentProjectWithoutNodeModulesAndUsesExistingVueDistForDeployment() throws Exception {
        var workspace = workspace();
        var manager = new WorkspaceStagingManager(workspace);
        UUID id = UUID.randomUUID();
        var paths = manager.paths(42, "vue_project", id);
        Files.createDirectories(paths.current().resolve("node_modules/example"));
        Files.createDirectories(paths.current().resolve("dist"));
        Files.writeString(paths.current().resolve("package.json"), "{\"scripts\":{\"build\":\"exit 1\"}}");
        Files.writeString(paths.current().resolve("dist/index.html"), "现有构建");
        var task = new GenerationTask(id, 42, 7, "request", "vue_project", "msg", GenerationTask.Status.RUNNING,
                null, null, null, null, paths, null, false, false);

        manager.prepare(task);

        assertThat(paths.staging()).startsWith(workspace.getRoot().resolve("code_staging/vue_project_42"));
        assertThat(paths.staging().resolve("node_modules")).doesNotExist();
        assertThat(paths.staging().resolve("dist/index.html")).hasContent("现有构建");
        assertThat(WorkspaceStagingManager.deploymentSource(paths.current(), "vue_project"))
                .isEqualTo(paths.current().resolve("dist"));
    }

    @Test
    void rejectsOutsideJunctionInOutputAndPreviewAndBlocksParentTraversal() throws Exception {
        WorkspaceProperties workspace = workspace();
        Path outside = Files.createDirectory(root.resolve("outside"));
        Files.writeString(outside.resolve("secret.txt"), "outside");
        Path entry = Files.createDirectories(workspace.getCodeOutputRootDir().resolve("html_42"));
        Files.writeString(entry.resolve("index.html"), "inside");
        Path junction = entry.resolve("redirect");
        createDirectoryLink(junction, outside);
        try {
            var controller = new StaticResourceController(workspace);
            assertThat(controller.serveStaticResource("html_42", request("/static/html_42/index.html")).getStatusCode())
                    .isEqualTo(HttpStatus.OK);
            assertThat(controller.serveStaticResource("html_42",
                    request("/static/html_42/redirect/secret.txt")).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
            assertThat(controller.serveStaticResource("html_42",
                    request("/static/html_42/../../outside/secret.txt")).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
            assertThatThrownBy(() -> WorkspaceStagingManager.verifyProject(entry, "html"))
                    .isInstanceOf(IOException.class);
        } finally {
            Files.delete(junction);
        }
        assertThat(outside.resolve("secret.txt")).hasContent("outside");
    }

    private WorkspaceProperties workspace() {
        return new WorkspaceProperties(root.toString(), "code_output", "code_staging", "code_deploy", "screenshots");
    }

    private static MockHttpServletRequest request(String path) {
        var request = new MockHttpServletRequest("GET", path);
        request.setAttribute(HandlerMapping.PATH_WITHIN_HANDLER_MAPPING_ATTRIBUTE, path);
        return request;
    }

    private static void createDirectoryLink(Path link, Path target) throws Exception {
        if (System.getProperty("os.name").startsWith("Windows")) {
            var process = new ProcessBuilder("cmd.exe", "/d", "/c", "mklink", "/J", link.toString(), target.toString())
                    .redirectErrorStream(true).start();
            var output = process.getInputStream().readAllBytes();
            assertThat(process.waitFor()).withFailMessage("mklink /J 失败: %s", new String(output)).isZero();
        } else {
            Files.createSymbolicLink(link, target);
        }
    }
}
