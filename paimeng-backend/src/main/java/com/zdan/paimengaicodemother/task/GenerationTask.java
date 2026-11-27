package com.zdan.paimengaicodemother.task;

import java.util.Locale;
import java.util.UUID;

record GenerationTask(UUID id, long appId, long userId, String clientRequestId, String codeGenType,
                      String message, Status status, Phase phase, String commitPayload, String failureCode,
                      String failureMessage, WorkspaceStagingManager.Paths paths, Boolean hadCurrent,
                      boolean started, boolean resultCommitted) {
    enum Status {
        RUNNING, COMMITTING, SUCCEEDED, FAILED;

        String apiValue() {
            return name().toLowerCase(Locale.ROOT);
        }

        boolean terminal() {
            return this == SUCCEEDED || this == FAILED;
        }
    }

    enum Phase {
        STAGED, CURRENT_TO_BACKUP, STAGING_TO_CURRENT, DELIVERED, RESTORING
    }
}
