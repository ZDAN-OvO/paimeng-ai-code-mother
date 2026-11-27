package com.zdan.paimengaicodemother.service.impl;

import cn.hutool.core.util.StrUtil;
import com.mybatisflex.core.paginate.Page;
import com.mybatisflex.core.query.QueryColumn;
import com.mybatisflex.core.query.QueryWrapper;
import com.mybatisflex.spring.service.impl.ServiceImpl;
import com.zdan.paimengaicodemother.agent.PythonAgentClient;
import com.zdan.paimengaicodemother.agent.PythonAgentClient.AgentException;
import com.zdan.paimengaicodemother.constant.UserConstant;
import com.zdan.paimengaicodemother.exception.BusinessException;
import com.zdan.paimengaicodemother.exception.ErrorCode;
import com.zdan.paimengaicodemother.exception.ThrowUtils;
import com.zdan.paimengaicodemother.mapper.ChatHistoryMapper;
import com.zdan.paimengaicodemother.model.dto.chathistory.ChatHistoryQueryRequest;
import com.zdan.paimengaicodemother.model.entity.App;
import com.zdan.paimengaicodemother.model.entity.ChatHistory;
import com.zdan.paimengaicodemother.model.entity.User;
import com.zdan.paimengaicodemother.model.enums.ChatHistoryMessageTypeEnum;
import com.zdan.paimengaicodemother.service.AppService;
import com.zdan.paimengaicodemother.service.ChatHistoryService;
import lombok.extern.slf4j.Slf4j;
import org.springframework.context.annotation.Lazy;
import org.springframework.stereotype.Service;

import java.time.LocalDateTime;
import java.util.Set;

import static com.zdan.paimengaicodemother.service.impl.PostgresQueryConditions.containsIgnoringCase;
import static com.zdan.paimengaicodemother.service.impl.PostgresQueryConditions.equalIgnoringCaseAndTrailingSpaces;

/**
 * 对话历史 服务层实现。
 *
 * @author LXH
 */
@Slf4j
@Service
public class ChatHistoryServiceImpl extends ServiceImpl<ChatHistoryMapper, ChatHistory> implements ChatHistoryService {

    private static final Set<String> SORTABLE_FIELDS = Set.of(
            "id", "message", "messageType", "appId", "userId", "createTime", "updateTime");

    private final AppService appService;
    private final PythonAgentClient agent;

    public ChatHistoryServiceImpl(@Lazy AppService appService, PythonAgentClient agent) {
        this.appService = appService;
        this.agent = agent;
    }

    @Override
    public Page<ChatHistory> listAppChatHistoryByPage(Long appId, int pageSize, LocalDateTime lastCreateTime,
                                                      Long lastId, User loginUser) {
        ThrowUtils.throwIf(appId == null || appId <= 0, ErrorCode.PARAMS_ERROR, "应用ID不能为空");
        ThrowUtils.throwIf(pageSize <= 0 || pageSize > 50, ErrorCode.PARAMS_ERROR, "页面大小必须在1-50之间");
        ThrowUtils.throwIf(lastId != null && (lastId <= 0 || lastCreateTime == null),
                ErrorCode.PARAMS_ERROR, "消息游标需要有效的 ID 和创建时间");
        ThrowUtils.throwIf(loginUser == null, ErrorCode.NOT_LOGIN_ERROR);

        App app = appService.getById(appId);
        ThrowUtils.throwIf(app == null, ErrorCode.NOT_FOUND_ERROR, "应用不存在");
        boolean isAdmin = UserConstant.ADMIN_ROLE.equals(loginUser.getUserRole());
        boolean isCreator = app.getUserId().equals(loginUser.getId());
        ThrowUtils.throwIf(!isAdmin && !isCreator, ErrorCode.NO_AUTH_ERROR, "无权查看该应用的对话历史");

        try {
            return page(1, pageSize, agent.appHistory(appId, pageSize, lastCreateTime, lastId));
        } catch (AgentException error) {
            throw translateAgentError(error);
        }
    }

    @Override
    public Page<ChatHistory> listAdminChatHistoryByPage(ChatHistoryQueryRequest query) {
        ThrowUtils.throwIf(query == null || query.getPageNum() <= 0 || query.getPageSize() <= 0,
                ErrorCode.PARAMS_ERROR);
        String sortField = query.getSortField();
        ThrowUtils.throwIf(StrUtil.isNotBlank(sortField) && !SORTABLE_FIELDS.contains(sortField),
                ErrorCode.PARAMS_ERROR, "历史排序字段非法");
        try {
            return page(query.getPageNum(), query.getPageSize(), agent.adminHistory(query));
        } catch (AgentException error) {
            throw translateAgentError(error);
        }
    }

    private static Page<ChatHistory> page(int number, int size, PythonAgentClient.HistoryPage source) {
        Page<ChatHistory> page = Page.of(number, size, source.totalRow());
        page.setRecords(source.records());
        return page;
    }

    private static BusinessException translateAgentError(AgentException error) {
        if (error.status() == 422) {
            return new BusinessException(ErrorCode.PARAMS_ERROR, "历史查询参数无效");
        }
        log.warn("Python 对话历史接口失败", error);
        return new BusinessException(ErrorCode.OPERATION_ERROR, "暂时无法访问对话历史，请稍后重试");
    }

    @Override
    public QueryWrapper getQueryWrapper(ChatHistoryQueryRequest chatHistoryQueryRequest) {
        QueryWrapper queryWrapper = QueryWrapper.create();
        if (chatHistoryQueryRequest == null) {
            return queryWrapper;
        }

        Long id = chatHistoryQueryRequest.getId();
        String message = chatHistoryQueryRequest.getMessage();
        String messageType = chatHistoryQueryRequest.getMessageType();
        Long appId = chatHistoryQueryRequest.getAppId();
        Long userId = chatHistoryQueryRequest.getUserId();
        LocalDateTime lastCreateTime = chatHistoryQueryRequest.getLastCreateTime();
        String sortField = chatHistoryQueryRequest.getSortField();
        String sortOrder = chatHistoryQueryRequest.getSortOrder();

        // 拼接查询条件
        queryWrapper.eq(ChatHistory::getId, id)
                .and(containsIgnoringCase("message", message))
                .and(equalIgnoringCaseAndTrailingSpaces("messageType", messageType))
                .eq(ChatHistory::getAppId, appId)
                .eq(ChatHistory::getUserId, userId);

        // 游标查询逻辑 - 只使用 createTime 作为游标
        if (lastCreateTime != null) {
            queryWrapper.lt(ChatHistory::getCreateTime, lastCreateTime);
        }

        // 排序
        if (StrUtil.isNotBlank(sortField)) {
            ThrowUtils.throwIf(!SORTABLE_FIELDS.contains(sortField), ErrorCode.PARAMS_ERROR, "历史排序字段非法");
            queryWrapper.orderBy(new QueryColumn(sortField), "ascend".equals(sortOrder));
        } else {
            // 旧消息可能在同一秒写入，以 ID 确定它们的顺序。
            queryWrapper.orderBy(ChatHistory::getCreateTime, false)
                    .orderBy(ChatHistory::getId, false);
        }

        return queryWrapper;
    }

    @Override
    public void addChatMessage(Long appId, String message, String messageType, User user) {
        validateParam(appId, message, messageType, user);
        // 创建会话消息实体
        ChatHistory chatHistory = new ChatHistory();
        chatHistory.setMessage(message);
        chatHistory.setMessageType(messageType);
        chatHistory.setAppId(appId);
        chatHistory.setUserId(user.getId());
        // 操作数据库
        boolean save = this.save(chatHistory);
        ThrowUtils.throwIf(!save, ErrorCode.OPERATION_ERROR, "添加会话消息失败");
    }

    @Override
    public void removeByAppId(Long appId) {
        try {
            agent.deleteHistory(appId);
        } catch (AgentException error) {
            throw translateAgentError(error);
        }
    }

    /**
     * 参数校验
     */
    private void validateParam(Long appId, String message, String messageType, User user) {
        // appId
        if (appId == null || appId <= 0) {
            ThrowUtils.throwForParam("应用 id 不能为空");
        }
        // message
        if (StrUtil.isBlank(message)) {
            ThrowUtils.throwForParam("消息不能为空");
        }
        // messageType
        if (StrUtil.isBlank(messageType)) {
            ThrowUtils.throwForParam("消息类型不能为空");
        } else if (ChatHistoryMessageTypeEnum.getEnumByValue(messageType) == null) {
            ThrowUtils.throwForParam("消息类型非法");
        }
        // user
        if (user == null) {
            ThrowUtils.throwForNotLogin("请先完成登录");
        } else if (user.getId() == null || user.getId() <= 0) {
            log.error("the given user is invalid: {}", user);
            ThrowUtils.throwForOperation("登录状态异常");
        }
    }
}
