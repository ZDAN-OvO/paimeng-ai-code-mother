package com.zdan.paimengaicodemother.task;

import io.lettuce.core.RedisURI;
import java.time.Duration;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.data.redis.connection.RedisPassword;
import org.springframework.data.redis.connection.RedisStandaloneConfiguration;
import org.springframework.data.redis.connection.lettuce.LettuceClientConfiguration;
import org.springframework.data.redis.connection.lettuce.LettuceConnectionFactory;
import org.springframework.data.redis.core.StringRedisTemplate;

@Configuration(proxyBeanMethods = false)
public class TaskRedisConfig {
    @Bean(defaultCandidate = false)
    LettuceConnectionFactory taskRedisConnectionFactory(
            @Value("${TASK_REDIS_URL:redis://127.0.0.1:6379/2}") String url) {
        var uri = RedisURI.create(url);
        if (uri.getDatabase() != 2 || uri.getHost() == null) {
            throw new IllegalArgumentException("TASK_REDIS_URL 必须指向独立 Redis db 2");
        }
        var server = new RedisStandaloneConfiguration(uri.getHost(), uri.getPort());
        server.setDatabase(uri.getDatabase());
        server.setUsername(uri.getUsername());
        server.setPassword(RedisPassword.of(uri.getPassword()));
        var client = LettuceClientConfiguration.builder().commandTimeout(Duration.ofSeconds(5));
        if (uri.isSsl()) {
            client.useSsl();
        }
        return new LettuceConnectionFactory(server, client.build());
    }

    @Bean(defaultCandidate = false)
    StringRedisTemplate taskRedisTemplate(
            @Qualifier("taskRedisConnectionFactory") LettuceConnectionFactory factory) {
        return new StringRedisTemplate(factory);
    }
}
