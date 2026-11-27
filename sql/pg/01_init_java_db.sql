BEGIN;

CREATE TABLE IF NOT EXISTS public."user" (
    id             BIGINT PRIMARY KEY,
    "userAccount"  VARCHAR(256) NOT NULL,
    "userPassword" VARCHAR(512) NOT NULL,
    "userName"     VARCHAR(256),
    "userAvatar"   VARCHAR(1024),
    "userProfile"  VARCHAR(512),
    "userRole"     VARCHAR(256) NOT NULL DEFAULT 'user',
    "editTime"     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createTime"   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updateTime"   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isDelete"     SMALLINT NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS "uk_userAccount" ON public."user" (LOWER(RTRIM("userAccount")));
CREATE INDEX IF NOT EXISTS "idx_userName" ON public."user" ("userName");

CREATE TABLE IF NOT EXISTS public.app (
    id             BIGINT PRIMARY KEY,
    "appName"      VARCHAR(256),
    cover          VARCHAR(512),
    "initPrompt"   TEXT,
    "codeGenType"  VARCHAR(64),
    "deployKey"    VARCHAR(64),
    "deployedTime" TIMESTAMP,
    priority       INTEGER NOT NULL DEFAULT 0,
    "userId"       BIGINT NOT NULL,
    "editTime"     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createTime"   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updateTime"   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isDelete"     SMALLINT NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS "uk_deployKey" ON public.app (LOWER(RTRIM("deployKey")));
CREATE INDEX IF NOT EXISTS "idx_appName" ON public.app ("appName");
CREATE INDEX IF NOT EXISTS "idx_userId" ON public.app ("userId");

CREATE TABLE IF NOT EXISTS public.chat_history (
    id            BIGINT PRIMARY KEY,
    message       TEXT NOT NULL,
    "messageType" VARCHAR(32) NOT NULL,
    "appId"       BIGINT NOT NULL,
    "userId"      BIGINT NOT NULL,
    "createTime"  TIMESTAMP(0) NOT NULL
                  DEFAULT date_trunc('second', statement_timestamp() AT TIME ZONE 'Asia/Shanghai'),
    "updateTime"  TIMESTAMP(0) NOT NULL
                  DEFAULT date_trunc('second', statement_timestamp() AT TIME ZONE 'Asia/Shanghai'),
    "isDelete"    SMALLINT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS "idx_appId" ON public.chat_history ("appId");
CREATE INDEX IF NOT EXISTS "idx_createTime" ON public.chat_history ("createTime");
CREATE INDEX IF NOT EXISTS "idx_appId_createTime"
    ON public.chat_history ("appId", "createTime", id);

CREATE OR REPLACE FUNCTION public.refresh_java_update_time()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW."updateTime" := CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS refresh_update_time ON public."user";
CREATE TRIGGER refresh_update_time
    BEFORE UPDATE ON public."user"
    FOR EACH ROW EXECUTE FUNCTION public.refresh_java_update_time();

DROP TRIGGER IF EXISTS refresh_update_time ON public.app;
CREATE TRIGGER refresh_update_time
    BEFORE UPDATE ON public.app
    FOR EACH ROW EXECUTE FUNCTION public.refresh_java_update_time();

CREATE OR REPLACE FUNCTION public.refresh_chat_history_update_time()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW."updateTime" := date_trunc('second', statement_timestamp() AT TIME ZONE 'Asia/Shanghai');
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS refresh_update_time ON public.chat_history;
CREATE TRIGGER refresh_update_time
    BEFORE UPDATE ON public.chat_history
    FOR EACH ROW EXECUTE FUNCTION public.refresh_chat_history_update_time();

COMMIT;
