package com.zdan.paimengaicodemother.task;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Duration;
import java.util.List;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.domain.Range;
import org.springframework.data.redis.connection.Limit;
import org.springframework.data.redis.connection.stream.MapRecord;
import org.springframework.data.redis.connection.stream.ReadOffset;
import org.springframework.data.redis.connection.stream.StreamOffset;
import org.springframework.data.redis.connection.stream.StreamReadOptions;
import org.springframework.data.redis.core.StreamOperations;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.DefaultRedisScript;
import org.springframework.stereotype.Service;

@Service
public class TaskEventStreamService {
    static final Duration RETENTION = Duration.ofMinutes(30);

    private static final DefaultRedisScript<Long> ACQUIRE = script("""
            if redis.call('EXISTS', KEYS[1]) ~= 0 then return 0 end
            redis.call('PSETEX', KEYS[1], ARGV[3], ARGV[1])
            redis.call('PSETEX', KEYS[2], ARGV[3], ARGV[2])
            return 1
            """);
    private static final String CHECK_FENCE = """
            if redis.call('GET', KEYS[1]) ~= ARGV[1] or redis.call('GET', KEYS[2]) ~= ARGV[2] then
                return 0
            end
            """;
    private static final DefaultRedisScript<Long> RENEW = script(CHECK_FENCE + """
            redis.call('PEXPIRE', KEYS[1], ARGV[3])
            redis.call('PEXPIRE', KEYS[2], ARGV[3])
            return 1
            """);
    private static final DefaultRedisScript<Long> APPEND = script(CHECK_FENCE + """
            if redis.call('EXISTS', KEYS[4]) ~= 0 then
                if ARGV[5] ~= '' then return 1 end
                return 0
            end
            local id = redis.call('XADD', KEYS[3], '*', 'event', ARGV[3], 'data', ARGV[4])
            if ARGV[5] ~= '' then
                redis.call('PSETEX', KEYS[4], ARGV[5], id)
                redis.call('PEXPIRE', KEYS[3], ARGV[5])
            end
            return 1
            """);
    private static final DefaultRedisScript<Long> RELEASE = script("""
            if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
            return redis.call('DEL', KEYS[1], KEYS[2])
            """);

    private final StringRedisTemplate redis;
    private final StreamOperations<String, String, String> streams;
    private final ObjectMapper mapper;
    private final String prefix;
    private final Duration ttl;

    public TaskEventStreamService(@Qualifier("taskRedisTemplate") StringRedisTemplate redis, ObjectMapper mapper,
                                  @Value("${paimeng.task.redis-prefix:paimeng:generation:}") String prefix,
                                  @Value("${paimeng.task.lease-ttl:30s}") Duration ttl) {
        if (ttl.toMillis() < 300) {
            throw new IllegalArgumentException("任务租约至少为 300ms");
        }
        this.redis = redis;
        this.streams = redis.opsForStream();
        this.mapper = mapper;
        this.prefix = prefix;
        this.ttl = ttl;
    }

    Lease acquire(long appId, UUID taskId) {
        var lease = new Lease(appId, taskId, UUID.randomUUID().toString());
        return redis.execute(ACQUIRE, leaseKeys(appId), taskId.toString(), lease.token(),
                Long.toString(ttl.toMillis())) == 1 ? lease : null;
    }

    boolean renew(Lease lease) {
        return redis.execute(RENEW, leaseKeys(lease.appId()), lease.taskId().toString(),
                lease.token(), Long.toString(ttl.toMillis())) == 1;
    }

    Duration renewalInterval() {
        return ttl.dividedBy(3);
    }

    void release(long appId, UUID taskId) {
        redis.execute(RELEASE, leaseKeys(appId), taskId.toString());
    }

    boolean append(Lease lease, String type, Object payload, boolean terminal) {
        try {
            var keys = leaseKeys(lease.appId());
            return redis.execute(APPEND, List.of(keys.get(0), keys.get(1), streamKey(lease.taskId()),
                            streamKey(lease.taskId()) + ":terminal"), lease.taskId().toString(), lease.token(),
                    type, mapper.writeValueAsString(payload), terminal ? Long.toString(RETENTION.toMillis()) : "") == 1;
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("任务事件序列化失败", e);
        }
    }

    boolean available(UUID taskId) {
        return Boolean.TRUE.equals(redis.hasKey(streamKey(taskId)));
    }

    String terminalId(UUID taskId) {
        return redis.opsForValue().get(streamKey(taskId) + ":terminal");
    }

    boolean contains(UUID taskId, String id) {
        return !streams.range(streamKey(taskId), Range.closed(id, id), Limit.limit().count(1)).isEmpty();
    }

    @SuppressWarnings("unchecked")
    List<MapRecord<String, String, String>> read(UUID taskId, String after) {
        return streams.read(StreamReadOptions.empty().count(100).block(Duration.ofSeconds(1)),
                StreamOffset.create(streamKey(taskId), ReadOffset.from(after)));
    }

    private List<String> leaseKeys(long appId) {
        var base = prefix + "lease:" + appId;
        return List.of(base, base + ":fence");
    }

    private String streamKey(UUID taskId) {
        return prefix + "stream:" + taskId;
    }

    private static DefaultRedisScript<Long> script(String lua) {
        return new DefaultRedisScript<>(lua, Long.class);
    }

    record Lease(long appId, UUID taskId, String token) {
    }
}
