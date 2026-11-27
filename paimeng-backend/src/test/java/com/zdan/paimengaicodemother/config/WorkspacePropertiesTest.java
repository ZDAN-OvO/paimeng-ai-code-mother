package com.zdan.paimengaicodemother.config;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.core.env.MapPropertySource;
import org.springframework.core.env.StandardEnvironment;
import org.springframework.core.env.SystemEnvironmentPropertySource;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class WorkspacePropertiesTest {

    @TempDir
    Path tempDir;

    @Test
    void repoRootAndBackendUseTheSameWorkspace() throws IOException {
        Path repo = Files.createDirectory(tempDir.resolve("repo"));
        Path backend = Files.createDirectory(repo.resolve("paimeng-backend"));
        Path expectedRoot = repo.resolve("tmp");

        for (Path workingDirectory : new Path[]{repo, backend}) {
            WorkspaceProperties workspace = defaults(workingDirectory, null);
            assertEquals(expectedRoot, workspace.getRoot());
            assertEquals(expectedRoot.resolve("code_output"), workspace.getCodeOutputRootDir());
            assertEquals(expectedRoot.resolve("code_staging"), workspace.getCodeStagingRootDir());
            assertEquals(expectedRoot.resolve("code_deploy"), workspace.getCodeDeployRootDir());
            assertEquals(expectedRoot.resolve("screenshots"), workspace.getScreenshotRootDir());
        }
    }

    @Test
    void envRootOverridesLocalConfigurationAndPathsAreNormalized() {
        Path root = tempDir.resolve("shared");
        Path screenshotRoot = tempDir.resolve("images");
        StandardEnvironment environment = new StandardEnvironment();
        String systemEnvironmentName = StandardEnvironment.SYSTEM_ENVIRONMENT_PROPERTY_SOURCE_NAME;
        environment.getPropertySources().remove(StandardEnvironment.SYSTEM_PROPERTIES_PROPERTY_SOURCE_NAME);
        environment.getPropertySources().replace(systemEnvironmentName, new SystemEnvironmentPropertySource(
                systemEnvironmentName, Map.of("PAIMENG_WORKSPACE_ROOT", root.resolve("unused/..").toString())));
        environment.getPropertySources().addLast(new MapPropertySource("application-local.yml", Map.of(
                "paimeng.workspace.root", tempDir.resolve("local").toString(),
                "paimeng.workspace.code-output-root-dir", "unused/../output",
                "paimeng.workspace.screenshot-root-dir", screenshotRoot.toString()
        )));

        WorkspaceProperties workspace = Binder.get(environment).bind("paimeng.workspace", WorkspaceProperties.class).get();

        assertEquals(root, workspace.getRoot());
        assertEquals(root.resolve("output"), workspace.getCodeOutputRootDir());
        assertEquals(root.resolve("code_staging"), workspace.getCodeStagingRootDir());
        assertEquals(root.resolve("code_deploy"), workspace.getCodeDeployRootDir());
        assertEquals(screenshotRoot, workspace.getScreenshotRootDir());
    }

    @Test
    void explicitRootAlsoWorksFromAnUnrelatedWorkingDirectory() {
        Path root = tempDir.resolve("shared");
        WorkspaceProperties workspace = defaults(tempDir.resolve("docs"), root.toString());

        assertEquals(root, workspace.getRoot());
    }

    @Test
    void unrelatedWorkingDirectoryRequiresAnExplicitRoot() throws IOException {
        Path repo = Files.createDirectory(tempDir.resolve("repo"));
        Files.createDirectory(repo.resolve("paimeng-backend"));
        Path docs = Files.createDirectory(repo.resolve("docs"));

        IllegalStateException exception = assertThrows(IllegalStateException.class, () -> defaults(docs, null));

        assertTrue(exception.getMessage().contains("PAIMENG_WORKSPACE_ROOT"));
    }

    @Test
    void rejectsRelativeExplicitRoot() {
        IllegalArgumentException exception = assertThrows(IllegalArgumentException.class,
                () -> defaults(tempDir, "relative/path"));

        assertTrue(exception.getMessage().contains("PAIMENG_WORKSPACE_ROOT"));
    }

    @Test
    void rejectsBlankScreenshotDirectory() {
        IllegalArgumentException exception = assertThrows(IllegalArgumentException.class,
                () -> new WorkspaceProperties(tempDir, tempDir.toString(), "code_output",
                        "code_staging", "code_deploy", ""));

        assertTrue(exception.getMessage().contains("screenshot-root-dir"));
    }

    private WorkspaceProperties defaults(Path workingDirectory, String root) {
        return new WorkspaceProperties(workingDirectory, root, "code_output", "code_staging", "code_deploy", "screenshots");
    }
}
