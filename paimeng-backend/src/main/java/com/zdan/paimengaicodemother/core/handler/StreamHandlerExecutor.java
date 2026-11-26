package com.zdan.paimengaicodemother.core.handler;

import com.zdan.paimengaicodemother.config.WorkspaceProperties;
import com.zdan.paimengaicodemother.core.builder.BuilderExecutor;
import com.zdan.paimengaicodemother.exception.ThrowUtils;
import com.zdan.paimengaicodemother.model.entity.User;
import com.zdan.paimengaicodemother.ai.enums.CodeGenTypeEnum;
import com.zdan.paimengaicodemother.service.ChatHistoryService;
import jakarta.annotation.Resource;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Flux;

import java.util.Objects;

/**
 * 流处理器执行器
 * 根据代码生成类型创建合适的流处理器：
 * 1. 传统的 Flux<String> 流（HTML、MULTI_FILE） -> SimpleTextStreamHandler
 * 2. TokenStream 格式的复杂流（VUE_PROJECT） -> JsonMessageStreamHandler
 *
 * @author LXH
 */
@Slf4j
@Component
public class StreamHandlerExecutor {
    @Resource
    private final JsonMessageStreamHandler jsonMessageStreamHandler;
    private final SimpleTextStreamHandler simpleTextStreamHandler;
    private final WorkspaceProperties workspaceProperties;

    public StreamHandlerExecutor(JsonMessageStreamHandler jsonMessageStreamHandler,
                                 SimpleTextStreamHandler simpleTextStreamHandler,
                                 WorkspaceProperties workspaceProperties) {
        this.jsonMessageStreamHandler = jsonMessageStreamHandler;
        this.simpleTextStreamHandler = simpleTextStreamHandler;
        this.workspaceProperties = workspaceProperties;
    }

    /**
     * 创建流处理器并处理聊天历史记录
     *
     * @param originFlux         原始流
     * @param chatHistoryService 聊天历史服务
     * @param appId              应用ID
     * @param loginUser          登录用户
     * @param codeGenType        代码生成类型
     * @return 处理后的流
     */
    public Flux<String> doHandle(Flux<String> originFlux,
                                 ChatHistoryService chatHistoryService,
                                 long appId, User loginUser, CodeGenTypeEnum codeGenType) {
        Flux<String> afterParse = parseStringFlux(originFlux, chatHistoryService, appId, loginUser, codeGenType);
        return Objects.requireNonNull(afterParse).doOnComplete(
                // 改为通过执行构造，以满足前端能够实时展示构建好的工程
                () -> BuilderExecutor.doBuild(
                        codeGenType,
                        workspaceProperties.getCodeOutputRootDir().resolve(codeGenType.getValue() + "_" + appId).toString()
                )
        );
    }

    private Flux<String> parseStringFlux(Flux<String> originFlux, ChatHistoryService chatHistoryService, long appId,
                                         User loginUser,
                                         CodeGenTypeEnum codeGenType) {
        return switch (codeGenType.getBuildType()) {
            // 使用注入的组件实例
            case NPM -> jsonMessageStreamHandler.handle(originFlux, chatHistoryService, appId, loginUser);
            case NONE -> simpleTextStreamHandler.handle(originFlux, chatHistoryService, appId, loginUser);
            default -> {
                log.error("failed to handle originFlux, cause by unsupported codeGenType: {}", codeGenType);
                ThrowUtils.throwForParam("生成失败，无法构建指定类型的项目");
                yield null;
            }
        };
    }
}
