package com.zdan.paimengaicodemother.config;

import com.mybatisflex.core.dialect.DbType;
import com.mybatisflex.spring.boot.MyBatisFlexCustomizer;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration(proxyBeanMethods = false)
public class MyBatisFlexConfig {

    @Bean
    MyBatisFlexCustomizer postgresDialect() {
        // PostgreSQL 方言给保留表名和驼峰列名加双引号。
        return config -> config.setDbType(DbType.POSTGRE_SQL);
    }
}
