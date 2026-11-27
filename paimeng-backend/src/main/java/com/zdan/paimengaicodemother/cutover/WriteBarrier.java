package com.zdan.paimengaicodemother.cutover;

import com.zdan.paimengaicodemother.exception.BusinessException;
import com.zdan.paimengaicodemother.exception.ErrorCode;
import java.util.List;
import java.util.UUID;
import java.util.function.Supplier;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.ClassPathResource;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.RedisScript;
import org.springframework.stereotype.Component;

@Slf4j
@Component
public class WriteBarrier {
    private static final RedisScript<String> SCRIPT =
            RedisScript.of(new ClassPathResource("cutover/write-barrier.lua"), String.class);

    private final StringRedisTemplate redis;
    private final List<String> keys;

    public WriteBarrier(@Qualifier("taskRedisTemplate") StringRedisTemplate redis,
                        @Value("${WRITE_BARRIER_NAMESPACE:paimeng:cutover}") String namespace) {
        if (namespace.isBlank()) {
            throw new IllegalArgumentException("WRITE_BARRIER_NAMESPACE 不能为空");
        }
        this.redis = redis;
        this.keys = List.of(namespace + ":writes");
    }

    public <T> T write(String operation, Supplier<T> work) {
        try (Ticket ticket = begin(operation)) {
            try {
                return work.get();
            } catch (BusinessException error) {
                throw error;
            } catch (RuntimeException | Error error) {
                ticket.fail(error);
                throw error;
            }
        }
    }

    public Ticket begin(String operation) {
        return start("begin", operation, "");
    }

    public Ticket recover(String operation) {
        return start("recover", operation, "");
    }

    private Ticket start(String action, String operation, String parent) {
        String id = UUID.randomUUID().toString();
        String result = redis.execute(SCRIPT, keys, action, id, operation, parent);
        if ("ok".equals(result)) {
            return new Ticket(id, operation);
        }
        if ("closed".equals(result) || "missing".equals(result)) {
            if ("recover".equals(action)) {
                return null;
            }
            if ("begin".equals(action)) {
                throw new Paused();
            }
        }
        throw new IllegalStateException("无法登记写入 " + operation + "，Redis 返回 " + result);
    }

    public final class Ticket implements AutoCloseable {
        private final String id;
        private final String operation;
        private boolean finished;

        private Ticket(String id, String operation) {
            this.id = id;
            this.operation = operation;
        }

        public Ticket child(String operation) {
            return start("child", operation, id);
        }

        public synchronized void fail(Throwable error) {
            if (finished) {
                return;
            }
            log.error("写入失败，操作={} 登记号={}", operation, id, error);
            finish("fail", error.getClass().getSimpleName());
        }

        @Override
        public synchronized void close() {
            finish("complete", "");
        }

        private void finish(String action, String detail) {
            if (finished) {
                return;
            }
            // Redis 写回失败时保留登记，由操作者核对后处理。
            finished = true;
            boolean interrupted = Thread.interrupted();
            try {
                String result = redis.execute(SCRIPT, keys, action, id, detail);
                if (!"ok".equals(result)) {
                    log.error("写入登记无法结算，操作={} 登记号={} Redis返回={}", operation, id, result);
                }
            } catch (RuntimeException error) {
                log.error("写入登记无法结算，操作={} 登记号={}", operation, id, error);
            } finally {
                if (interrupted) {
                    Thread.currentThread().interrupt();
                }
            }
        }
    }

    public static final class Paused extends BusinessException {
        private Paused() {
            super(ErrorCode.OPERATION_ERROR, "正在停写维护，请稍后重试");
        }
    }
}
