local key = KEYS[1]
local operation = ARGV[1]
local mode = redis.call('HGET', key, 'mode')

if operation == 'init' then
    if mode then return 'exists' end
    redis.call('HSET', key, 'mode', 'open', 'epoch', ARGV[2])
    return 'ok'
end
if not mode then return 'missing' end

local epoch = redis.call('HGET', key, 'epoch')

if operation == 'pause' then
    if mode == 'open' then
        redis.call('HSET', key, 'mode', 'closed', 'epoch', ARGV[2])
        return ARGV[2]
    end
    return epoch
end

if operation == 'seal' or operation == 'resume' or operation == 'abort' or operation == 'resolve' then
    if epoch ~= ARGV[2] then return 'wrong-epoch' end
    if operation == 'resume' or operation == 'abort' then
        local required = operation == 'resume' and 'sealed' or 'closed'
        if mode ~= required then return 'wrong-mode' end
        redis.call('HSET', key, 'mode', 'open')
        redis.call('HDEL', key, 'sealed_at')
        return 'ok'
    end
    if operation == 'seal' and mode == 'sealed' then
        return redis.call('HGET', key, 'sealed_at')
    end
    if mode ~= 'closed' then return 'wrong-mode' end
    if operation == 'resolve' then
        if redis.call('HDEL', key, ARGV[3]) == 0 then return 'unknown-ticket' end
        return 'ok'
    end
    if redis.call('HLEN', key) ~= 2 then return 'busy' end
    local now = redis.call('TIME')
    local sealed_at = string.format('%s.%06d', now[1], tonumber(now[2]))
    redis.call('HSET', key, 'mode', 'sealed', 'sealed_at', sealed_at)
    return sealed_at
end

local ticket = 'active:' .. ARGV[2]
if operation == 'begin' or operation == 'child' or operation == 'recover' then
    if operation == 'begin' and mode ~= 'open' then return 'closed' end
    if mode ~= 'open' and mode ~= 'closed' then return 'closed' end
    if operation == 'child' and redis.call('HEXISTS', key, 'active:' .. ARGV[4]) == 0 then
        return 'no-parent'
    end
    if redis.call('HEXISTS', key, 'failed:' .. ARGV[2]) ~= 0 then return 'duplicate' end
    local now = redis.call('TIME')
    if redis.call('HSETNX', key, ticket, now[1] .. ' ' .. ARGV[3]) == 0 then return 'duplicate' end
    return 'ok'
end

if operation == 'complete' or operation == 'fail' then
    local active = redis.call('HGET', key, ticket)
    if not active then return 'unknown-ticket' end
    if operation == 'fail' then
        redis.call('HSET', key, 'failed:' .. ARGV[2], active .. ' ' .. ARGV[3])
    end
    redis.call('HDEL', key, ticket)
    return 'ok'
end

return 'unknown-operation'
