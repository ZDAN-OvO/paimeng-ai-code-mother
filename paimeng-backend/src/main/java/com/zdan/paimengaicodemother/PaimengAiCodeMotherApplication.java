package com.zdan.paimengaicodemother;

import com.zdan.paimengaicodemother.config.WorkspaceProperties;
import org.mybatis.spring.annotation.MapperScan;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.cache.annotation.EnableCaching;

/**
 * 派蒙零代码应用生成后端入口
 *
 * @author LXH
 */
@EnableCaching
@EnableConfigurationProperties(WorkspaceProperties.class)
@SpringBootApplication
@MapperScan("com.zdan.paimengaicodemother.mapper")
public class PaimengAiCodeMotherApplication {

    public static void main(String[] args) {
        SpringApplication.run(PaimengAiCodeMotherApplication.class, args);
    }
}
