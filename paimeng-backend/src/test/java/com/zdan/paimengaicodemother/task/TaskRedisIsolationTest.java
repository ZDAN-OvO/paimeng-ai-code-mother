package com.zdan.paimengaicodemother.task;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.zdan.paimengaicodemother.config.RedisCacheManagerConfig;
import com.zdan.paimengaicodemother.model.entity.User;
import com.zdan.paimengaicodemother.ratelimiter.aspect.RateLimitAspect;
import com.zdan.paimengaicodemother.ratelimiter.config.RedissonConfig;
import com.zdan.paimengaicodemother.service.UserService;
import io.lettuce.core.RedisURI;
import java.time.Duration;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ThreadLocalRandom;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.redisson.api.RedissonClient;
import org.springframework.aop.aspectj.annotation.AspectJProxyFactory;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.autoconfigure.data.redis.RedisAutoConfiguration;
import org.springframework.boot.test.context.runner.WebApplicationContextRunner;
import org.springframework.cache.CacheManager;
import org.springframework.context.annotation.Bean;
import org.springframework.session.data.redis.config.ConfigureRedisAction;
import org.springframework.data.redis.connection.RedisConnectionFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.session.Session;
import org.springframework.session.SessionRepository;
import org.springframework.session.data.redis.config.annotation.web.http.EnableRedisHttpSession;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

@EnabledIfEnvironmentVariable(named = "TASK_REDIS_URL", matches = "rediss?://.+/2")
class TaskRedisIsolationTest {
    @Test
    @SuppressWarnings("unchecked")
    void keepsDefaultFactorySessionCacheAndRateLimiterOnDbZeroAndUsesDbTwoForTasks() {
        String url = System.getenv("TASK_REDIS_URL");
        RedisURI uri = RedisURI.create(url);
        String namespace = "task-isolation-test:" + UUID.randomUUID();
        long userId = ThreadLocalRandom.current().nextLong(1000, Long.MAX_VALUE);
        String rateKey = "rate_limit:user:" + userId;
        try {
            new WebApplicationContextRunner()
                    .withConfiguration(AutoConfigurations.of(RedisAutoConfiguration.class))
                    .withUserConfiguration(TaskRedisConfig.class, Sessions.class, RedisCacheManagerConfig.class,
                            RedissonConfig.class)
                    .withPropertyValues("spring.data.redis.host=" + uri.getHost(),
                            "spring.data.redis.port=" + uri.getPort(), "spring.data.redis.database=0",
                            "spring.data.redis.password=" + (uri.getPassword() == null ? "" : new String(uri.getPassword())),
                            "TASK_REDIS_URL=" + url, "isolation.session.namespace=" + namespace)
                    .run(context -> {
                        assertThat(context).hasNotFailed();
                        assertThat(context.getBeansOfType(RedisConnectionFactory.class)).containsOnlyKeys(
                                "redisConnectionFactory", "taskRedisConnectionFactory");
                        assertThat(context.getBeansOfType(StringRedisTemplate.class)).containsOnlyKeys(
                                "stringRedisTemplate", "taskRedisTemplate");

                        var main = context.getBean(StringRedisTemplate.class);
                        var task = context.getBean("taskRedisTemplate", StringRedisTemplate.class);
                        var sessions = (SessionRepository<Session>) context.getBean(SessionRepository.class);
                        Session login = sessions.createSession();
                        login.setAttribute("login_state", Long.toString(userId));
                        sessions.save(login);
                        String sessionKey = namespace + ":sessions:" + login.getId();
                        String cacheKey = "good_app_page::" + namespace;
                        var cache = context.getBean(CacheManager.class).getCache("good_app_page");
                        cache.put(namespace, "page");

                        var request = new MockHttpServletRequest();
                        var users = mock(UserService.class);
                        when(users.getLoginUser(request)).thenReturn(User.builder().id(userId).build());
                        RequestContextHolder.setRequestAttributes(new ServletRequestAttributes(request));
                        var proxy = new AspectJProxyFactory(new GenerationRateLimitService());
                        proxy.addAspect(new RateLimitAspect(context.getBean(RedissonClient.class), users));
                        ((GenerationRateLimitService) proxy.getProxy()).acquire();

                        var events = new TaskEventStreamService(task, new ObjectMapper(), namespace + ":", Duration.ofSeconds(5));
                        UUID taskId = UUID.randomUUID();
                        var lease = events.acquire(userId, taskId);
                        assertThat(events.append(lease, "message", Map.of("d", "中文"), false)).isTrue();
                        String stream = namespace + ":stream:" + taskId;
                        String leaseKey = namespace + ":lease:" + userId;

                        assertThat(main.hasKey(sessionKey)).isTrue();
                        assertThat(main.hasKey(cacheKey)).isTrue();
                        assertThat(main.hasKey(rateKey)).isTrue();
                        assertThat(main.hasKey(stream)).isFalse();
                        assertThat(main.hasKey(leaseKey)).isFalse();
                        assertThat(task.hasKey(sessionKey)).isFalse();
                        assertThat(task.hasKey(cacheKey)).isFalse();
                        assertThat(task.hasKey(rateKey)).isFalse();
                        assertThat(task.hasKey(stream)).isTrue();
                        assertThat(task.opsForValue().get(leaseKey)).isEqualTo(taskId.toString());

                        sessions.deleteById(login.getId());
                        cache.evict(namespace);
                        context.getBean(RedissonClient.class).getRateLimiter(rateKey).delete();
                        task.delete(stream);
                        events.release(userId, taskId);
                    });
        } finally {
            RequestContextHolder.resetRequestAttributes();
        }
    }

    @Test
    void rejectsThePreviousOwnerEvenWhenTheSameTaskIdReacquiresTheExpiredLease() {
        var config = new TaskRedisConfig();
        try (var factory = new RedisFactory(config.taskRedisConnectionFactory(System.getenv("TASK_REDIS_URL")))) {
            var task = config.taskRedisTemplate(factory.connection);
            task.afterPropertiesSet();
            String prefix = "task-fence-test:" + UUID.randomUUID() + ":";
            var events = new TaskEventStreamService(task, new ObjectMapper(), prefix, Duration.ofMillis(400));
            UUID id = UUID.randomUUID();
            var oldOwner = events.acquire(17, id);
            assertThat(events.append(oldOwner, "message", Map.of("d", "first"), false)).isTrue();
            await().atMost(Duration.ofSeconds(3)).until(() -> !Boolean.TRUE.equals(task.hasKey(prefix + "lease:17")));
            var newOwner = events.acquire(17, id);

            assertThat(newOwner).isNotNull();
            assertThat(newOwner.token()).isNotEqualTo(oldOwner.token());
            assertThat(events.renew(oldOwner)).isFalse();
            assertThat(events.append(oldOwner, "message", Map.of("d", "stale"), false)).isFalse();
            assertThat(events.append(newOwner, "done", Map.of("status", "success"), true)).isTrue();
            assertThat(events.append(newOwner, "done", Map.of("status", "success"), true)).isTrue();
            assertThat(events.read(id, "0-0")).extracting(frame -> frame.getValue().get("event"))
                    .containsExactly("message", "done");
            assertThat(task.getExpire(prefix + "stream:" + id)).isBetween(1700L, 1800L);
            events.release(17, id);
            task.delete(java.util.List.of(prefix + "stream:" + id, prefix + "stream:" + id + ":terminal"));
        }
    }

    @EnableRedisHttpSession(redisNamespace = "${isolation.session.namespace}")
    static class Sessions {
        @Bean
        ConfigureRedisAction configureRedisAction() {
            return ConfigureRedisAction.NO_OP;
        }
    }

    private static final class RedisFactory implements AutoCloseable {
        private final org.springframework.data.redis.connection.lettuce.LettuceConnectionFactory connection;

        RedisFactory(org.springframework.data.redis.connection.lettuce.LettuceConnectionFactory connection) {
            this.connection = connection;
            connection.afterPropertiesSet();
        }

        @Override
        public void close() {
            connection.destroy();
        }
    }
}
