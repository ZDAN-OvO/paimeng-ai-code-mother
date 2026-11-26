package com.zdan.paimengaicodemother.mapper;

import com.mybatisflex.core.paginate.Page;
import com.mybatisflex.spring.FlexTransactionManager;
import com.mybatisflex.spring.boot.MybatisFlexAutoConfiguration;
import com.zaxxer.hikari.HikariDataSource;
import com.zdan.paimengaicodemother.ai.codegen.route.AiCodeGenTypeRoutingService;
import com.zdan.paimengaicodemother.ai.codegen.route.AiCodeGenTypeRoutingServiceFactory;
import com.zdan.paimengaicodemother.ai.enums.CodeGenTypeEnum;
import com.zdan.paimengaicodemother.config.MyBatisFlexConfig;
import com.zdan.paimengaicodemother.config.WorkspaceProperties;
import com.zdan.paimengaicodemother.constant.AppConstant;
import com.zdan.paimengaicodemother.core.AiCodeGeneratorFacade;
import com.zdan.paimengaicodemother.core.handler.StreamHandlerExecutor;
import com.zdan.paimengaicodemother.exception.BusinessException;
import com.zdan.paimengaicodemother.model.dto.app.AppAddRequest;
import com.zdan.paimengaicodemother.model.dto.app.AppQueryRequest;
import com.zdan.paimengaicodemother.model.dto.chathistory.ChatHistoryQueryRequest;
import com.zdan.paimengaicodemother.model.dto.user.UserQueryRequest;
import com.zdan.paimengaicodemother.model.entity.App;
import com.zdan.paimengaicodemother.model.entity.ChatHistory;
import com.zdan.paimengaicodemother.model.entity.User;
import com.zdan.paimengaicodemother.service.AppService;
import com.zdan.paimengaicodemother.service.ChatHistoryService;
import com.zdan.paimengaicodemother.service.ScreenshotService;
import com.zdan.paimengaicodemother.service.UserService;
import com.zdan.paimengaicodemother.service.impl.AppServiceImpl;
import com.zdan.paimengaicodemother.service.impl.ChatHistoryServiceImpl;
import com.zdan.paimengaicodemother.service.impl.UserServiceImpl;
import org.apache.ibatis.session.SqlSessionFactory;
import org.junit.jupiter.api.Test;
import org.mybatis.spring.annotation.MapperScan;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.ImportAutoConfiguration;
import org.springframework.boot.test.context.ConfigDataApplicationContextInitializer;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.ContextConfiguration;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.context.junit.jupiter.SpringJUnitConfig;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

@SpringJUnitConfig(PostgresRepositoryTest.RepositoryConfiguration.class)
@ContextConfiguration(initializers = ConfigDataApplicationContextInitializer.class)
@ActiveProfiles("test")
@Transactional
@MockitoBean(types = {
        AiCodeGeneratorFacade.class, StreamHandlerExecutor.class,
        ScreenshotService.class, WorkspaceProperties.class
})
class PostgresRepositoryTest {

    private static final long LEGACY_USER_ID = 191_000_000_000_000_001L;
    private static final long LEGACY_APP_ID = 191_000_000_000_000_002L;
    private static final LocalDateTime LEGACY_TIME = LocalDateTime.of(2023, 1, 2, 3, 4, 5);
    private static final String TEST_PASSWORD = "test-password";

    @Autowired
    private UserService userService;

    @Autowired
    private AppService appService;

    @Autowired
    private ChatHistoryService chatHistoryService;

    @Autowired
    private UserMapper userMapper;

    @Autowired
    private AppMapper appMapper;

    @Autowired
    private ChatHistoryMapper chatHistoryMapper;

    @Autowired
    private JdbcTemplate jdbc;

    @MockitoBean
    private AiCodeGenTypeRoutingServiceFactory routingFactory;

    @Test
    void registrationAndLoginUseTheUniqueAccountIndexRule() {
        String account = "PgO'Clock  ";
        long id = userService.userRegister(account, TEST_PASSWORD, TEST_PASSWORD);

        User user = userService.getById(id);
        assertThat(id).isPositive();
        assertThat(user.getUserAccount()).isEqualTo(account);
        assertThat(user.getCreateTime()).isNotNull();
        assertThat(user.getUpdateTime()).isNotNull();
        assertThat(user.getIsDelete()).isZero();

        MockHttpServletRequest request = new MockHttpServletRequest();
        assertThat(userService.userLogin("pGO'cLOCK", TEST_PASSWORD, request).getId()).isEqualTo(id);
        assertThat(userService.getLoginUser(request).getId()).isEqualTo(id);
        assertThatThrownBy(() -> userService.userLogin(account, "different-password", request))
                .isInstanceOf(BusinessException.class).hasMessage("用户不存在或密码错误");
        assertThatThrownBy(() -> userService.userRegister("pgo'clock ", TEST_PASSWORD, TEST_PASSWORD))
                .isInstanceOf(BusinessException.class).hasMessage("账号重复");

        UserQueryRequest query = new UserQueryRequest();
        query.setUserAccount("o'cLo");
        query.setSortField("createTime");
        assertThat(userService.list(userService.getQueryWrapper(query))).extracting(User::getId).containsExactly(id);

        User duplicate = User.builder().userAccount("PGO'CLOCK").userPassword("test-digest").build();
        assertThatThrownBy(() -> userMapper.insertSelective(duplicate)).isInstanceOf(DuplicateKeyException.class);
    }

    @Test
    void migratedIdsAndOwnershipArePreservedWhenEditing() {
        User owner = insertLegacyOwner();
        insertApp(LEGACY_APP_ID, "旧应用", owner.getId(), 0, LEGACY_TIME);

        MockHttpServletRequest request = new MockHttpServletRequest();
        assertThat(userService.userLogin("lEGACY oWNER  ", TEST_PASSWORD, request).getId()).isEqualTo(LEGACY_USER_ID);
        User updatedUser = User.builder().id(LEGACY_USER_ID).userName("Legacy O'Clock").build();
        assertThat(userService.updateById(updatedUser)).isTrue();
        assertThat(userService.getById(LEGACY_USER_ID).getUpdateTime()).isAfter(LEGACY_TIME);
        UserQueryRequest userQuery = new UserQueryRequest();
        userQuery.setUserName("o'cLo");
        assertThat(userService.list(userService.getQueryWrapper(userQuery))).extracting(User::getId)
                .containsExactly(LEGACY_USER_ID);

        App app = appService.getById(LEGACY_APP_ID);
        assertThat(app.getUserId()).isEqualTo(LEGACY_USER_ID);
        assertThat(app.getUpdateTime()).isEqualTo(LEGACY_TIME);
        App update = App.builder().id(LEGACY_APP_ID).appName("编辑后的旧应用").build();
        assertThat(appService.updateById(update)).isTrue();

        App edited = appService.getById(LEGACY_APP_ID);
        assertThat(edited.getAppName()).isEqualTo(update.getAppName());
        assertThat(edited.getUserId()).isEqualTo(owner.getId());
        assertThat(edited.getCreateTime()).isEqualTo(LEGACY_TIME);
        assertThat(edited.getUpdateTime()).isAfter(LEGACY_TIME);
    }

    @Test
    void createsAppAndPaginatesCaseInsensitiveSearchAndFeaturedApps() {
        User owner = insertLegacyOwner();
        AiCodeGenTypeRoutingService router = mock(AiCodeGenTypeRoutingService.class);
        when(routingFactory.createAiCodeGenTypeRoutingService()).thenReturn(router);
        when(router.routeCodeGenType(anyString())).thenReturn(CodeGenTypeEnum.HTML);

        AppAddRequest request = new AppAddRequest();
        request.setInitPrompt("O'Clock Demo");
        long newId = appService.createApp(request, owner);
        App created = appService.getById(newId);
        assertThat(newId).isPositive();
        assertThat(created.getAppName()).isEqualTo("O'Clock Demo");
        assertThat(created.getUserId()).isEqualTo(owner.getId());
        assertThat(created.getCodeGenType()).isEqualTo("html");
        assertThat(created.getCreateTime()).isAfter(LEGACY_TIME);
        assertThat(created.getPriority()).isZero();

        int featured = AppConstant.GOOD_APP_PRIORITY;
        insertApp(LEGACY_APP_ID, "o'CLOCK start", owner.getId(), featured, LEGACY_TIME);
        insertApp(LEGACY_APP_ID + 1, "O'Clock Next", owner.getId(), featured, LEGACY_TIME.plusDays(1));
        insertApp(LEGACY_APP_ID + 2, "Unrelated", owner.getId(), featured, LEGACY_TIME.plusDays(2));

        AppQueryRequest query = new AppQueryRequest();
        query.setAppName("o'cLoCk");
        query.setUserId(owner.getId());
        query.setSortField("createTime");
        Page<App> firstPage = appService.page(Page.of(1, 2), appService.getQueryWrapper(query));
        assertThat(firstPage.getTotalRow()).isEqualTo(3);
        assertThat(firstPage.getRecords()).extracting(App::getId).containsExactly(newId, LEGACY_APP_ID + 1);
        assertThat(appService.page(Page.of(2, 2), appService.getQueryWrapper(query)).getRecords())
                .extracting(App::getId).containsExactly(LEGACY_APP_ID);

        query.setPriority(featured);
        assertThat(appService.page(Page.of(1, 10), appService.getQueryWrapper(query)).getRecords())
                .extracting(App::getId).containsExactly(LEGACY_APP_ID + 1, LEGACY_APP_ID);
        query.setSortOrder("ascend");
        assertThat(appService.page(Page.of(1, 10), appService.getQueryWrapper(query)).getRecords())
                .extracting(App::getId).containsExactly(LEGACY_APP_ID, LEGACY_APP_ID + 1);
    }

    @Test
    void deployKeyLookupMatchesUniqueIndexAndFiltersLogicallyDeletedApps() {
        User owner = insertLegacyOwner();
        insertApp(LEGACY_APP_ID, "旧部署", owner.getId(), 0, LEGACY_TIME);
        App update = App.builder().id(LEGACY_APP_ID).deployKey("PgO'Key  ").build();
        assertThat(appService.updateById(update)).isTrue();

        AppQueryRequest query = new AppQueryRequest();
        query.setDeployKey("pGO'kEY ");
        assertThat(appService.list(appService.getQueryWrapper(query))).extracting(App::getDeployKey)
                .containsExactly(update.getDeployKey());
        query.setDeployKey("pGO'kE");
        assertThat(appService.list(appService.getQueryWrapper(query))).isEmpty();

        assertThat(appMapper.deleteById(LEGACY_APP_ID)).isEqualTo(1);
        assertThat(appService.getById(LEGACY_APP_ID)).isNull();
        query.setDeployKey("pGO'kEY ");
        assertThat(appService.list(appService.getQueryWrapper(query))).isEmpty();
        assertThat(jdbc.queryForObject("SELECT \"isDelete\" FROM app WHERE id = ?", Integer.class, LEGACY_APP_ID))
                .isEqualTo(1);

        App duplicate = App.builder().userId(owner.getId()).deployKey("PGO'KEY").build();
        assertThatThrownBy(() -> appMapper.insertSelective(duplicate)).isInstanceOf(DuplicateKeyException.class);
    }

    @Test
    void oldAndNewChatMessagesRemainInPostgresWithStableOrdering() {
        User owner = insertLegacyOwner();
        insertApp(LEGACY_APP_ID, "旧对话应用", owner.getId(), 0, LEGACY_TIME);
        insertChatMessage(LEGACY_APP_ID + 10, "Legacy Question", "user");
        insertChatMessage(LEGACY_APP_ID + 11, "Legacy Answer", "ai");

        chatHistoryService.addChatMessage(LEGACY_APP_ID, "New Question", "user", owner);
        chatHistoryService.addChatMessage(LEGACY_APP_ID, "New Answer", "ai", owner);
        Page<ChatHistory> history = chatHistoryService.listAppChatHistoryByPage(LEGACY_APP_ID, 10, null, owner);

        assertThat(history.getRecords()).extracting(ChatHistory::getMessage)
                .containsExactly("New Answer", "New Question", "Legacy Answer", "Legacy Question");
        assertThat(history.getRecords()).allSatisfy(message -> {
            assertThat(message.getAppId()).isEqualTo(LEGACY_APP_ID);
            assertThat(message.getUserId()).isEqualTo(LEGACY_USER_ID);
            assertThat(message.getIsDelete()).isZero();
        });
        ChatHistory newAnswer = history.getRecords().getFirst();
        assertThat(newAnswer.getId()).isPositive();
        assertThat(newAnswer.getCreateTime()).isAfter(LEGACY_TIME);
        assertThat(newAnswer.getUpdateTime()).isNotNull();
        assertThat(history.getRecords().getLast().getId()).isEqualTo(LEGACY_APP_ID + 10);
        assertThat(chatHistoryService.listAppChatHistoryByPage(LEGACY_APP_ID, 10, LEGACY_TIME.plusDays(1), owner)
                .getRecords()).extracting(ChatHistory::getId).containsExactly(LEGACY_APP_ID + 11, LEGACY_APP_ID + 10);

        ChatHistoryQueryRequest query = new ChatHistoryQueryRequest();
        query.setAppId(LEGACY_APP_ID);
        query.setMessage("lEGACY aNSWER");
        assertThat(chatHistoryService.list(chatHistoryService.getQueryWrapper(query))).extracting(ChatHistory::getId)
                .containsExactly(LEGACY_APP_ID + 11);

        chatHistoryService.removeByAppId(LEGACY_APP_ID);
        assertThat(chatHistoryService.listAppChatHistoryByPage(LEGACY_APP_ID, 10, null, owner).getRecords()).isEmpty();
        assertThat(jdbc.queryForObject("""
                SELECT COUNT(*) FROM chat_history WHERE "appId" = ? AND "isDelete" = 1
                """, Integer.class, LEGACY_APP_ID)).isEqualTo(4);
        assertThat(jdbc.queryForObject("""
                SELECT "updateTime" FROM chat_history WHERE id = ?
                """, LocalDateTime.class, LEGACY_APP_ID + 10)).isAfter(LEGACY_TIME);
    }

    @Test
    void rejectsSortFieldsOutsideTheWhitelist() {
        AppQueryRequest appQuery = new AppQueryRequest();
        appQuery.setSortField("unknownColumn");
        assertThatThrownBy(() -> appService.getQueryWrapper(appQuery))
                .isInstanceOf(BusinessException.class).hasMessage("应用排序字段非法");
        UserQueryRequest userQuery = new UserQueryRequest();
        userQuery.setSortField("userPassword");
        assertThatThrownBy(() -> userService.getQueryWrapper(userQuery))
                .isInstanceOf(BusinessException.class).hasMessage("用户排序字段非法");
        ChatHistoryQueryRequest historyQuery = new ChatHistoryQueryRequest();
        historyQuery.setSortField("unknownColumn");
        assertThatThrownBy(() -> chatHistoryService.getQueryWrapper(historyQuery))
                .isInstanceOf(BusinessException.class).hasMessage("历史排序字段非法");
    }

    private User insertLegacyOwner() {
        User owner = User.builder()
                .id(LEGACY_USER_ID)
                .userAccount("Legacy Owner")
                .userPassword(userService.getEncryptPassword(TEST_PASSWORD))
                .createTime(LEGACY_TIME)
                .updateTime(LEGACY_TIME)
                .build();
        assertThat(userMapper.insertSelective(owner)).isEqualTo(1);
        return owner;
    }

    private void insertApp(long id, String name, long ownerId, int priority, LocalDateTime time) {
        App app = App.builder()
                .id(id)
                .appName(name)
                .userId(ownerId)
                .priority(priority)
                .createTime(time)
                .updateTime(time)
                .build();
        assertThat(appMapper.insertSelective(app)).isEqualTo(1);
    }

    private void insertChatMessage(long id, String message, String type) {
        ChatHistory history = ChatHistory.builder()
                .id(id)
                .appId(LEGACY_APP_ID)
                .userId(LEGACY_USER_ID)
                .message(message)
                .messageType(type)
                .createTime(LEGACY_TIME)
                .updateTime(LEGACY_TIME)
                .build();
        assertThat(chatHistoryMapper.insertSelective(history)).isEqualTo(1);
    }

    @TestConfiguration(proxyBeanMethods = false)
    @MapperScan(basePackageClasses = UserMapper.class)
    @Import({MyBatisFlexConfig.class, UserServiceImpl.class, AppServiceImpl.class, ChatHistoryServiceImpl.class})
    @ImportAutoConfiguration(MybatisFlexAutoConfiguration.class)
    static class RepositoryConfiguration {

        @Bean
        HikariDataSource dataSource(@Value("${paimeng.test.postgres.url}") String url,
                                    @Value("${paimeng.test.postgres.username}") String username,
                                    @Value("${paimeng.test.postgres.password}") String password,
                                    @Value("${spring.datasource.driver-class-name}") String driver) {
            HikariDataSource dataSource = new HikariDataSource();
            dataSource.setDriverClassName(driver);
            dataSource.setJdbcUrl(url);
            dataSource.setUsername(username);
            dataSource.setPassword(password);
            return dataSource;
        }

        @Bean
        PlatformTransactionManager transactionManager() {
            return new FlexTransactionManager();
        }

        @Bean
        JdbcTemplate jdbcTemplate(SqlSessionFactory sqlSessionFactory) {
            // 通过同一个 Flex 数据源读取，核对 MyBatis 当前事务中的原始行。
            return new JdbcTemplate(sqlSessionFactory.getConfiguration().getEnvironment().getDataSource());
        }
    }
}
