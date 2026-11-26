package com.zdan.paimengaicodemother.ai.tools;

import com.zdan.paimengaicodemother.config.WorkspaceProperties;

import java.nio.file.Path;

/**
 * 工程文件工具基类，
 * 权限修饰符为 protected 不暴露给包外，具体的实现类应被隔离在当前包下
 *
 * @author LXH
 */
public abstract class BaseProjectFileTool extends BaseTool {

    private final String projectType;

    private final WorkspaceProperties workspaceProperties;

    protected BaseProjectFileTool(String projectType, WorkspaceProperties workspaceProperties) {
        this.projectType = projectType;
        this.workspaceProperties = workspaceProperties;
    }

    protected Path getProjectRoot(Long appId) {
        return workspaceProperties.getCodeOutputRootDir().resolve(getProjectDirName(appId));
    }

    public String projectType() {
        return projectType;
    }

    public String getProjectDirName(Long appId) {
        return projectType + "_" + appId;
    }
}
