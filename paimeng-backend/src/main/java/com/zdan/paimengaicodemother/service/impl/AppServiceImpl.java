package com.zdan.paimengaicodemother.service.impl;

import cn.hutool.core.bean.BeanUtil;
import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.io.FileUtil;
import cn.hutool.core.util.RandomUtil;
import cn.hutool.core.util.StrUtil;
import com.mybatisflex.core.query.QueryColumn;
import com.mybatisflex.core.query.QueryWrapper;
import com.mybatisflex.spring.service.impl.ServiceImpl;
import com.zdan.paimengaicodemother.agent.PythonAgentClient;
import com.zdan.paimengaicodemother.agent.PythonAgentClient.AgentException;
import com.zdan.paimengaicodemother.config.WorkspaceProperties;
import com.zdan.paimengaicodemother.constant.AppConstant;
import com.zdan.paimengaicodemother.cutover.WriteBarrier;
import com.zdan.paimengaicodemother.cutover.WriteBarrier.Ticket;
import com.zdan.paimengaicodemother.exception.BusinessException;
import com.zdan.paimengaicodemother.exception.ErrorCode;
import com.zdan.paimengaicodemother.exception.ThrowUtils;
import com.zdan.paimengaicodemother.mapper.AppMapper;
import com.zdan.paimengaicodemother.model.dto.app.AppAddRequest;
import com.zdan.paimengaicodemother.model.dto.app.AppQueryRequest;
import com.zdan.paimengaicodemother.model.entity.App;
import com.zdan.paimengaicodemother.model.entity.User;
import com.zdan.paimengaicodemother.ai.enums.CodeGenTypeEnum;
import com.zdan.paimengaicodemother.model.vo.AppVO;
import com.zdan.paimengaicodemother.model.vo.UserVO;
import com.zdan.paimengaicodemother.service.AppService;
import com.zdan.paimengaicodemother.service.ScreenshotService;
import com.zdan.paimengaicodemother.service.UserService;
import com.zdan.paimengaicodemother.task.GenerationTaskCoordinator;
import com.zdan.paimengaicodemother.task.GenerationTaskStore;
import com.zdan.paimengaicodemother.task.WorkspaceStagingManager;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.io.File;
import java.io.IOException;
import java.nio.file.Path;
import java.io.Serializable;
import java.time.LocalDateTime;
import java.util.*;
import java.util.stream.Collectors;

import static com.zdan.paimengaicodemother.service.impl.PostgresQueryConditions.containsIgnoringCase;
import static com.zdan.paimengaicodemother.service.impl.PostgresQueryConditions.equalIgnoringCaseAndTrailingSpaces;

/**
 * 应用 服务层实现。
 *
 * @author LXH
 */
@Slf4j
@Service
public class AppServiceImpl extends ServiceImpl<AppMapper, App> implements AppService {

    private static final Set<String> SORTABLE_FIELDS = Set.of(
            "id", "appName", "cover", "initPrompt", "codeGenType", "deployKey",
            "deployedTime", "priority", "userId", "editTime", "createTime", "updateTime");

    private final UserService userService;
    private final ScreenshotService screenshotService;
    private final PythonAgentClient agent;
    private final GenerationTaskCoordinator tasks;
    private final GenerationTaskStore taskStore;
    private final WorkspaceProperties workspaceProperties;
    private final WriteBarrier writeBarrier;

    public AppServiceImpl(UserService userService,
                          ScreenshotService screenshotService,
                          PythonAgentClient agent,
                          GenerationTaskCoordinator tasks,
                          GenerationTaskStore taskStore,
                          WorkspaceProperties workspaceProperties,
                          WriteBarrier writeBarrier) {
        this.userService = userService;
        this.screenshotService = screenshotService;
        this.agent = agent;
        this.tasks = tasks;
        this.taskStore = taskStore;
        this.workspaceProperties = workspaceProperties;
        this.writeBarrier = writeBarrier;
    }

    @Override
    public Long createApp(AppAddRequest appAddRequest, User loginUser) {
        // 参数校验
        String initPrompt = appAddRequest.getInitPrompt();
        ThrowUtils.throwIf(StrUtil.isBlank(initPrompt), ErrorCode.PARAMS_ERROR, "初始化prompt不能为空");

        // 构造入库对象
        App app = new App();
        BeanUtil.copyProperties(appAddRequest, app);
        app.setUserId(loginUser.getId());

        // 应用名称暂时为 initPrompt 前 12 位
        app.setAppName(initPrompt.substring(0, Math.min(initPrompt.length(), 12)));

        String selectedCodeGenType;
        try {
            selectedCodeGenType = agent.route(initPrompt);
        } catch (AgentException error) {
            log.warn("Python 类型路由失败", error);
            throw new BusinessException(ErrorCode.OPERATION_ERROR, "暂时无法选择生成类型，请稍后重试");
        }
        ThrowUtils.throwIf(CodeGenTypeEnum.getEnumByValue(selectedCodeGenType) == null, ErrorCode.OPERATION_ERROR,
                "生成类型无效");
        app.setCodeGenType(selectedCodeGenType);

        // 插入数据库
        boolean result = this.save(app);
        ThrowUtils.throwIf(!result, ErrorCode.OPERATION_ERROR);
        log.info("应用创建成功，ID: {}，类型: {}", app.getId(), selectedCodeGenType);
        return app.getId();
    }

    @Override
    public boolean removeById(Serializable id) {
        if (id == null) {
            return false;
        }
        long appId = Long.parseLong(id.toString());
        if (appId <= 0) {
            return false;
        }
        return tasks.deleteApp(appId);
    }

    @Override
    public String deployApp(Long appId, User loginUser) {
        try (var ticket = writeBarrier.begin("app.publish:" + appId)) {
            try {
                return deployApp(appId, loginUser, ticket);
            } catch (BusinessException error) {
                throw error;
            } catch (RuntimeException | Error error) {
                ticket.fail(error);
                throw error;
            }
        }
    }

    private String deployApp(Long appId, User loginUser, Ticket ticket) {
        // 参数校验
        validateParam(appId, loginUser);
        // 身份校验
        App app = Optional.ofNullable(this.getById(appId))
                .orElseThrow(() -> new BusinessException(ErrorCode.PARAMS_ERROR, "应用不存在"));
        if (!app.getUserId().equals(loginUser.getId())) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "无权限生成代码");
        }
        // 检查是否已有 deployKey
        String deployKey = app.getDeployKey();
        // 如果没有则生成部署 6 位 deployKey
        if (StrUtil.isBlank(deployKey)) {
            // 如果 deployKey 和其他用户的冲突，deployKey 有唯一键，插入数据库直接失败，这里不用校验是否重复了（实际重复概率约等于不可能）
            deployKey = RandomUtil.randomString(6);
        }
        // 获取应用生成类型，获取代码生成路径（应用访问路径）
        String codeGenType = app.getCodeGenType();
        String sourceDirName = StrUtil.format("{}_{}", codeGenType, appId);
        Path project = workspaceProperties.getCodeOutputRootDir().resolve(sourceDirName);
        String deployDirPath = workspaceProperties.getCodeDeployRootDir().resolve(deployKey).toString();
        taskStore.readDeliveredWorkspace(appId, () -> {
            Path source;
            try {
                source = WorkspaceStagingManager.deploymentSource(project, codeGenType);
            } catch (IOException error) {
                log.warn("应用缺少可部署的产物，appId={}", appId, error);
                throw new BusinessException(ErrorCode.PARAMS_ERROR, "应用缺少可部署的产物或复制失败");
            }
            try {
                FileUtil.copyContent(source.toFile(), new File(deployDirPath), true);
            } catch (RuntimeException error) {
                ticket.fail(error);
                throw new BusinessException(ErrorCode.PARAMS_ERROR, "应用缺少可部署的产物或复制失败");
            }
            return null;
        });
        try {
            app.setDeployKey(deployKey);
            app.setDeployedTime(LocalDateTime.now());
            boolean updateRes = this.updateById(app);
            ThrowUtils.throwIf(!updateRes, ErrorCode.OPERATION_ERROR, "更新应用部署信息失败");
            String appDeployUrl = StrUtil.format("{}/{}", AppConstant.CODE_DEPLOY_HOST, deployKey);
            // 发布登记仍在，暂停准入也允许先登记已受理发布的截图回写。
            startScreenshot(appId, appDeployUrl, ticket.child("app.screenshot:" + appId));
            return appDeployUrl;
        } catch (RuntimeException | Error error) {
            ticket.fail(error);
            throw error;
        }
    }

    @Override
    public void generateAppScreenshotAsync(Long appId, String appDeployUrl) {
        startScreenshot(appId, appDeployUrl, writeBarrier.begin("app.screenshot:" + appId));
    }

    private void startScreenshot(Long appId, String appDeployUrl, Ticket ticket) {
        try {
            Thread.startVirtualThread(() -> {
                try (ticket) {
                    try {
                        String screenshotWebUrl = screenshotService.generateAndUploadScreenshot(appDeployUrl);
                        ThrowUtils.throwIf(StrUtil.isBlank(screenshotWebUrl), ErrorCode.OPERATION_ERROR, "截图地址为空");
                        App updateApp = new App();
                        updateApp.setId(appId);
                        updateApp.setCover(screenshotWebUrl);
                        boolean updated = this.updateById(updateApp);
                        ThrowUtils.throwIf(!updated, ErrorCode.OPERATION_ERROR, "更新应用封面字段失败");
                    } catch (RuntimeException | Error error) {
                        ticket.fail(error);
                    }
                }
            });
        } catch (RuntimeException | Error error) {
            ticket.fail(error);
            throw error;
        }
    }

    private void validateParam(Long appId, User loginUser) {
        ThrowUtils.throwIf(appId == null || appId <= 0, ErrorCode.PARAMS_ERROR, "应用 id 值不合法");
        ThrowUtils.throwIf(loginUser == null || loginUser.getId() == null || loginUser.getId() <= 0,
                ErrorCode.PARAMS_ERROR, "用户 id 值不合法");
    }

    @Override
    public AppVO getAppVO(App app) {
        if (app == null) {
            return null;
        }
        AppVO appVO = new AppVO();
        BeanUtil.copyProperties(app, appVO);
        // 关联查询用户信息
        Long userId = app.getUserId();
        if (userId != null) {
            User user = userService.getById(userId);
            UserVO userVO = userService.getUserVO(user);
            appVO.setUser(userVO);
        }
        return appVO;
    }

    @Override
    public List<AppVO> getAppVOList(List<App> appList) {
        if (CollUtil.isEmpty(appList)) {
            return new ArrayList<>();
        }
        // 批量获取用户信息，避免 N+1 查询问题
        Set<Long> userIds = appList.stream()
                .map(App::getUserId)
                .collect(Collectors.toSet());

        Map<Long, UserVO> userVOMap = userService.listByIds(userIds).stream()
                .collect(Collectors.toMap(User::getId, userService::getUserVO));

        return appList.stream().map(app -> {
            AppVO appVO = getAppVO(app);
            UserVO userVO = userVOMap.get(app.getUserId());
            appVO.setUser(userVO);
            return appVO;
        }).collect(Collectors.toList());
    }

    @Override
    public QueryWrapper getQueryWrapper(AppQueryRequest appQueryRequest) {
        if (appQueryRequest == null) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "请求参数为空");
        }

        Long id = appQueryRequest.getId();
        String appName = appQueryRequest.getAppName();
        String cover = appQueryRequest.getCover();
        String initPrompt = appQueryRequest.getInitPrompt();
        String codeGenType = appQueryRequest.getCodeGenType();
        String deployKey = appQueryRequest.getDeployKey();
        Integer priority = appQueryRequest.getPriority();
        Long userId = appQueryRequest.getUserId();
        String sortField = appQueryRequest.getSortField();
        String sortOrder = appQueryRequest.getSortOrder();

        QueryWrapper queryWrapper = QueryWrapper.create()
                .eq(App::getId, id)
                .and(containsIgnoringCase("appName", appName))
                .and(containsIgnoringCase("cover", cover))
                .and(containsIgnoringCase("initPrompt", initPrompt))
                .and(equalIgnoringCaseAndTrailingSpaces("codeGenType", codeGenType))
                .and(equalIgnoringCaseAndTrailingSpaces("deployKey", deployKey))
                .eq(App::getPriority, priority)
                .eq(App::getUserId, userId);
        if (StrUtil.isNotBlank(sortField)) {
            ThrowUtils.throwIf(!SORTABLE_FIELDS.contains(sortField), ErrorCode.PARAMS_ERROR, "应用排序字段非法");
            queryWrapper.orderBy(new QueryColumn(sortField), "ascend".equals(sortOrder));
        }
        return queryWrapper;
    }
}
