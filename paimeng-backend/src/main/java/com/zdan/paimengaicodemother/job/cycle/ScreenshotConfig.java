package com.zdan.paimengaicodemother.job.cycle;

import com.zdan.paimengaicodemother.config.WorkspaceProperties;
import com.zdan.paimengaicodemother.cutover.WriteBarrier;
import com.zdan.paimengaicodemother.utils.WebScreenshotUtils;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;
import org.springframework.scheduling.annotation.Scheduled;
import lombok.extern.slf4j.Slf4j;

/**
 * 定时清理本地截图缓存
 *
 * @author LXH
 */
@Configuration
@EnableScheduling
@Slf4j
public class ScreenshotConfig {

    private final WorkspaceProperties workspaceProperties;
    private final WriteBarrier writeBarrier;

    public ScreenshotConfig(WorkspaceProperties workspaceProperties, WriteBarrier writeBarrier) {
        this.workspaceProperties = workspaceProperties;
        this.writeBarrier = writeBarrier;
    }

    /**
     * 每天凌晨2点清理过期的临时截图文件
     */
    @Scheduled(cron = "0 0 2 * * ?")
    public void cleanupTempScreenshots() {
        try {
            writeBarrier.write("screenshots.cleanup", () -> {
                log.info("开始定时清理过期的临时截图文件");
                WebScreenshotUtils.cleanupTempFiles(workspaceProperties.getScreenshotRootDir());
                return null;
            });
        } catch (WriteBarrier.Paused ignored) {
            // 停写时跳过新的定时清理，已启动的清理可以结束。
        }
    }
}