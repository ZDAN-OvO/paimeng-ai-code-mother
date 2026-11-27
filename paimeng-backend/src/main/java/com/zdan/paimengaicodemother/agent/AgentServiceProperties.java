package com.zdan.paimengaicodemother.agent;

import java.net.URI;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

@ConfigurationProperties("paimeng.agent")
public record AgentServiceProperties(@DefaultValue("http://127.0.0.1:8000") URI baseUrl,
                                     @DefaultValue("") String internalToken) {
}
