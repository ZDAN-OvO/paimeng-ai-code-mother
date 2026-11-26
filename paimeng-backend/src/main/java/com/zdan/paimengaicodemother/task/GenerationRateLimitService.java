package com.zdan.paimengaicodemother.task;

import com.zdan.paimengaicodemother.ratelimiter.annotaion.RateLimit;
import com.zdan.paimengaicodemother.ratelimiter.enums.RateLimitType;
import org.springframework.stereotype.Service;

@Service
public class GenerationRateLimitService {
    @RateLimit(limitType = RateLimitType.USER, rate = 1, rateInterval = 60,
            message = "AI 对话请求过于频繁，请稍后再试")
    public void acquire() {
        // 由原有限流切面在当前请求线程扣减配额。
    }
}
