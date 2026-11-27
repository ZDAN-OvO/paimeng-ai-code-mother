package com.zdan.paimengaicodemother.config;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.ConstructorBinding;
import org.springframework.boot.context.properties.bind.DefaultValue;

import java.nio.file.Files;
import java.nio.file.Path;

@ConfigurationProperties("paimeng.workspace")
public class WorkspaceProperties {

    private static final String BACKEND_DIRECTORY = "paimeng-backend";

    private final Path root;
    private final Path codeOutputRootDir;
    private final Path codeStagingRootDir;
    private final Path codeDeployRootDir;
    private final Path screenshotRootDir;

    @ConstructorBinding
    public WorkspaceProperties(
            String root,
            @DefaultValue("code_output") String codeOutputRootDir,
            @DefaultValue("code_staging") String codeStagingRootDir,
            @DefaultValue("code_deploy") String codeDeployRootDir,
            @DefaultValue("screenshots") String screenshotRootDir) {
        this(Path.of(System.getProperty("user.dir")), root, codeOutputRootDir, codeStagingRootDir,
                codeDeployRootDir, screenshotRootDir);
    }

    WorkspaceProperties(Path workingDirectory, String root, String codeOutputRootDir,
                        String codeStagingRootDir, String codeDeployRootDir, String screenshotRootDir) {
        this.root = resolveRoot(workingDirectory, root);
        this.codeOutputRootDir = resolveDirectory(codeOutputRootDir, "code-output-root-dir");
        this.codeStagingRootDir = resolveDirectory(codeStagingRootDir, "code-staging-root-dir");
        this.codeDeployRootDir = resolveDirectory(codeDeployRootDir, "code-deploy-root-dir");
        this.screenshotRootDir = resolveDirectory(screenshotRootDir, "screenshot-root-dir");
    }

    public Path getRoot() {
        return root;
    }

    public Path getCodeOutputRootDir() {
        return codeOutputRootDir;
    }

    public Path getCodeStagingRootDir() {
        return codeStagingRootDir;
    }

    public Path getCodeDeployRootDir() {
        return codeDeployRootDir;
    }

    public Path getScreenshotRootDir() {
        return screenshotRootDir;
    }

    private Path resolveDirectory(String configuredDirectory, String property) {
        Path directory = Path.of(configuredDirectory);
        if (configuredDirectory.isBlank() || (!directory.isAbsolute() && directory.getRoot() != null)) {
            throw new IllegalArgumentException("paimeng.workspace." + property + " 必须是绝对路径或相对于工作区的路径");
        }
        return root.resolve(directory).normalize();
    }

    private static Path resolveRoot(Path workingDirectory, String configuredRoot) {
        if (configuredRoot != null && !configuredRoot.isBlank()) {
            Path root = Path.of(configuredRoot);
            if (!root.isAbsolute()) {
                throw new IllegalArgumentException("PAIMENG_WORKSPACE_ROOT (paimeng.workspace.root) 必须是绝对路径");
            }
            return root.normalize();
        }

        Path directory = workingDirectory.toAbsolutePath().normalize();
        if (Files.isDirectory(directory.resolve(BACKEND_DIRECTORY))) {
            return directory.resolve("tmp");
        }
        if (directory.getFileName() != null && BACKEND_DIRECTORY.equals(directory.getFileName().toString())) {
            return directory.getParent().resolve("tmp");
        }
        throw new IllegalStateException("无法从启动目录 " + directory
                + " 推导工作区，请设置 PAIMENG_WORKSPACE_ROOT 为绝对路径");
    }
}
