package com.zdan.paimengaicodemother.core.saver;

import cn.hutool.core.io.FileUtil;
import cn.hutool.core.util.StrUtil;
import com.zdan.paimengaicodemother.config.WorkspaceProperties;
import com.zdan.paimengaicodemother.exception.BusinessException;
import com.zdan.paimengaicodemother.exception.ErrorCode;
import com.zdan.paimengaicodemother.ai.enums.CodeGenTypeEnum;

import java.io.File;
import java.nio.charset.StandardCharsets;


/**
 * 抽象代码文件保存器 - 模板方法模式
 *
 * @author LXH
 */
public abstract class BaseCodeFileSaver {

    private final WorkspaceProperties workspaceProperties;

    protected BaseCodeFileSaver(WorkspaceProperties workspaceProperties) {
        this.workspaceProperties = workspaceProperties;
    }

    /**
     * 模板方法：保存代码的标准流程
     *
     * @param result 代码结果对象
     * @param appId  应用 id
     * @return 保存的目录
     */
    public final File saveCode(Object result, Long appId) {
        // 1. 验证输入
        validateInput(result, appId);
        // 2. 构建唯一目录
        String uniqueDir = buildUniqueDir(appId);
        // 3. 保存文件（具体实现交给子类）
        saveFiles(result, uniqueDir);
        // 4. 返回文件目录对象
        return new File(uniqueDir);
    }

    /**
     * 写入单个文件的工具方法
     *
     * @param dirPath  目录路径
     * @param filename 文件名
     * @param content  文件内容
     */
    public final void writeToFile(String dirPath, String filename, String content) {
        if (StrUtil.isNotBlank(content)) {
            String filePath = dirPath + File.separator + filename;
            FileUtil.writeString(content, filePath, StandardCharsets.UTF_8);
        }
    }

    /**
     * 验证输入参数（可由子类覆盖）
     *
     * @param result 代码结果对象
     * @param appId  应用 id
     */
    protected void validateInput(Object result, Long appId) {
        if (result == null) {
            throw new BusinessException(ErrorCode.SYSTEM_ERROR, "代码结果对象不能为空");
        }
        if (appId == null) {
            throw new BusinessException(ErrorCode.SYSTEM_ERROR, "应用id不能为空");
        }
    }

    /**
     * 构建生成目录下应用的唯一路径：bizType_雪花 ID
     *
     * @return 目录路径
     */
    protected String buildUniqueDir(Long appId) {
        String codeType = getCodeType().getValue();
        String uniqueDirName = StrUtil.format("{}_{}", codeType, appId);
        String dirPath = workspaceProperties.getCodeOutputRootDir().resolve(uniqueDirName).toString();
        FileUtil.mkdir(dirPath);
        return dirPath;
    }

    // region --- 抽象方法，模板子类实现

    /**
     * 保存文件（具体实现交给子类）
     *
     * @param result      代码结果对象
     * @param baseDirPath 基础目录路径
     */
    protected abstract void saveFiles(Object result, String baseDirPath);

    /**
     * 获取代码生成类型
     *
     * @return 代码生成类型枚举
     */
    protected abstract CodeGenTypeEnum getCodeType();
    // endregion 抽象方法，模板子类实现
}
