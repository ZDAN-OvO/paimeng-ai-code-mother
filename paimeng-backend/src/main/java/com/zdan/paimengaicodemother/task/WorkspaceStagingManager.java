package com.zdan.paimengaicodemother.task;

import com.zdan.paimengaicodemother.ai.enums.CodeGenTypeEnum;
import com.zdan.paimengaicodemother.config.WorkspaceProperties;
import java.io.IOException;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.UUID;
import org.springframework.stereotype.Component;

@Component
public class WorkspaceStagingManager {
    private final WorkspaceProperties workspace;

    public WorkspaceStagingManager(WorkspaceProperties workspace) {
        this.workspace = workspace;
    }

    Paths paths(long appId, String type, UUID taskId) {
        String project = type + "_" + appId;
        Path parent = workspace.getCodeStagingRootDir().resolve(project);
        return new Paths(parent.resolve(taskId.toString()), workspace.getCodeOutputRootDir().resolve(project),
                parent.resolve(taskId + ".bak"));
    }

    void prepare(GenerationTask task) throws IOException {
        Paths paths = checkLayout(task);
        if (directory(paths.staging()) || directory(paths.backup())) {
            throw new IOException("生成临时目录已存在");
        }
        Files.createDirectory(paths.staging());
        if (directory(paths.current())) {
            copyProject(paths.current(), paths.staging());
        }
    }

    boolean verifyCandidate(GenerationTask task) throws IOException {
        Paths paths = checkLayout(task);
        verifyProject(paths.staging(), task.codeGenType());
        if (directory(paths.backup())) {
            throw new IOException("交付备份目录已存在");
        }
        return directory(paths.current());
    }

    /**
     * 阶段写入 PostgreSQL 后才开始改目录。恢复时根据源和目标判断重命名是否已经完成。
     */
    boolean exchange(GenerationTask task, GenerationTaskStore.Session session) throws IOException {
        Paths paths = checkLayout(task);
        var phase = task.phase();
        if (phase == GenerationTask.Phase.STAGED) {
            phase = task.hadCurrent() ? GenerationTask.Phase.CURRENT_TO_BACKUP : GenerationTask.Phase.STAGING_TO_CURRENT;
            session.phase(task.id(), phase);
        }
        if (phase == GenerationTask.Phase.CURRENT_TO_BACKUP) {
            require(directory(paths.staging()), "缺少交付临时目录");
            if (!moveChecked(paths.current(), paths.backup())) {
                return false;
            }
            phase = GenerationTask.Phase.STAGING_TO_CURRENT;
            session.phase(task.id(), phase);
        }
        if (phase == GenerationTask.Phase.STAGING_TO_CURRENT) {
            require(directory(paths.backup()) == task.hadCurrent(), "交付备份与任务记录不匹配");
            if (!moveChecked(paths.staging(), paths.current())) {
                return false;
            }
            session.phase(task.id(), GenerationTask.Phase.DELIVERED);
        }
        require(!directory(paths.staging()) && directory(paths.current())
                && directory(paths.backup()) == task.hadCurrent(), "已交付目录与任务记录不匹配");
        verifyPreview(paths.current(), task.codeGenType());
        return true;
    }

    void restore(GenerationTask task) throws IOException {
        Paths paths = checkLayout(task);
        require(directory(paths.staging()), "恢复时缺少本轮临时目录");
        if (task.hadCurrent()) {
            require(moveChecked(paths.backup(), paths.current()), "旧预览目录未能恢复");
            verifyPreview(paths.current(), task.codeGenType());
        } else {
            require(!directory(paths.current()) && !directory(paths.backup()), "新应用出现预期以外的正式目录");
        }
    }

    void clean(GenerationTask task) throws IOException {
        Paths paths = checkLayout(task);
        deleteTree(paths.staging());
        deleteTree(paths.backup());
    }

    public static Path deploymentSource(Path project, String type) throws IOException {
        Path preview = verifyProject(project, type);
        return preview.getParent();
    }

    static Path verifyProject(Path project, String type) throws IOException {
        Path entry = verifyPreview(project, type);
        Path root = project.toRealPath();
        Files.walkFileTree(project, new SimpleFileVisitor<>() {
            @Override
            public FileVisitResult preVisitDirectory(Path directory, BasicFileAttributes attributes) throws IOException {
                Path expected = root.resolve(project.relativize(directory));
                // Windows junction 会作为普通目录到达这里。
                require(directory.toRealPath().equals(expected), "项目中存在重定向目录");
                return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult visitFile(Path file, BasicFileAttributes attributes) throws IOException {
                Path real = file.toRealPath();
                require(real.startsWith(root), "项目链接超出本轮工作区");
                if (attributes.isSymbolicLink()) {
                    require(!Files.isDirectory(real), "项目包含指向目录的符号链接");
                    Path target = Files.readSymbolicLink(file);
                    require(!target.isAbsolute() && file.getParent().resolve(target).normalize().startsWith(project),
                            "项目链接在交付后会离开应用目录");
                } else {
                    require(attributes.isRegularFile(), "项目包含非普通文件");
                }
                return FileVisitResult.CONTINUE;
            }
        });
        return entry;
    }

    private static Path verifyPreview(Path project, String type) throws IOException {
        require(directory(project), "缺少应用目录");
        Path preview = CodeGenTypeEnum.VUE_PROJECT.getValue().equals(type) ? project.resolve("dist") : project;
        Path entry = preview.resolve("index.html");
        require(Files.isRegularFile(entry) && Files.size(entry) > 0 && entry.toRealPath().startsWith(project.toRealPath()),
                "应用未生成可用的 index.html");
        return entry;
    }

    private Paths checkLayout(GenerationTask task) throws IOException {
        Paths result = task.paths();
        require(result.equals(paths(task.appId(), task.codeGenType(), task.id())), "任务路径与当前工作区配置不一致");
        Path stagingRoot = workspace.getCodeStagingRootDir();
        require(stagingRoot.equals(workspace.getRoot().resolve("code_staging")), "Java 与 Python 临时根目录不一致");
        Files.createDirectories(workspace.getRoot());
        createDirectDirectory(stagingRoot);
        createDirectDirectory(result.staging().getParent());
        createDirectDirectory(workspace.getCodeOutputRootDir());
        return result;
    }

    private static void createDirectDirectory(Path path) throws IOException {
        Files.createDirectories(path);
        directory(path);
    }

    private static boolean directory(Path path) throws IOException {
        try {
            BasicFileAttributes attributes = Files.readAttributes(path, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
            require(attributes.isDirectory() && path.toRealPath().equals(path.getParent().toRealPath().resolve(path.getFileName())),
                    "任务目录不是直接子目录：" + path.getFileName());
            return true;
        } catch (NoSuchFileException e) {
            if (Files.exists(path, LinkOption.NOFOLLOW_LINKS)) {
                throw e;
            }
            return false;
        }
    }

    private boolean moveChecked(Path source, Path target) throws IOException {
        for (int attempt = 0; attempt < 3; attempt++) {
            if (moveAlreadyCompleted(source, target)) {
                return true;
            }
            try {
                atomicMove(source, target);
                return true;
            } catch (IOException e) {
                if (moveAlreadyCompleted(source, target)) {
                    return true;
                }
            }
        }
        return false;
    }

    private static boolean moveAlreadyCompleted(Path source, Path target) throws IOException {
        boolean hasSource = directory(source);
        boolean hasTarget = directory(target);
        require(hasSource != hasTarget, "无法判断目录是否已交换：" + source.getFileName() + " → " + target.getFileName());
        return hasTarget;
    }

    void atomicMove(Path source, Path target) throws IOException {
        Files.move(source, target, StandardCopyOption.ATOMIC_MOVE);
    }

    private static void copyProject(Path source, Path target) throws IOException {
        Path root = source.toRealPath();
        Files.walkFileTree(source, new SimpleFileVisitor<>() {
            @Override
            public FileVisitResult preVisitDirectory(Path directory, BasicFileAttributes attributes) throws IOException {
                if (directory.getFileName().toString().equalsIgnoreCase("node_modules")) {
                    return FileVisitResult.SKIP_SUBTREE;
                }
                Path relative = source.relativize(directory);
                require(directory.toRealPath().equals(root.resolve(relative)), "旧项目包含重定向目录");
                if (!source.equals(directory)) {
                    Files.createDirectory(target.resolve(relative));
                }
                return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult visitFile(Path file, BasicFileAttributes attributes) throws IOException {
                if (file.getFileName().toString().equalsIgnoreCase("node_modules")) {
                    return FileVisitResult.CONTINUE;
                }
                require(file.toRealPath().startsWith(root), "旧项目链接超出应用目录");
                if (attributes.isSymbolicLink()) {
                    Path destination = Files.readSymbolicLink(file);
                    require(!destination.isAbsolute() && file.getParent().resolve(destination).normalize().startsWith(source),
                            "旧项目链接在复制后会离开工作区");
                } else {
                    require(attributes.isRegularFile(), "旧项目包含非普通文件");
                }
                Files.copy(file, target.resolve(source.relativize(file)), LinkOption.NOFOLLOW_LINKS);
                return FileVisitResult.CONTINUE;
            }
        });
    }

    private static void deleteTree(Path path) throws IOException {
        if (!Files.exists(path, LinkOption.NOFOLLOW_LINKS)) {
            return;
        }
        Files.walkFileTree(path, new SimpleFileVisitor<>() {
            @Override
            public FileVisitResult preVisitDirectory(Path directory, BasicFileAttributes attributes) throws IOException {
                if (!directory.toRealPath().equals(directory.getParent().toRealPath().resolve(directory.getFileName()))) {
                    Files.delete(directory);
                    return FileVisitResult.SKIP_SUBTREE;
                }
                return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult visitFile(Path file, BasicFileAttributes attributes) throws IOException {
                Files.delete(file);
                return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult postVisitDirectory(Path directory, IOException error) throws IOException {
                if (error != null) {
                    throw error;
                }
                Files.delete(directory);
                return FileVisitResult.CONTINUE;
            }
        });
    }

    private static void require(boolean condition, String message) throws IOException {
        if (!condition) {
            throw new IOException(message);
        }
    }

    record Paths(Path staging, Path current, Path backup) {
    }
}
