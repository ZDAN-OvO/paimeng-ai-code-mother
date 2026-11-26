package com.zdan.paimengaicodemother.utils;

import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;

/**
 * @author LXH
 */
class WebScreenshotUtilsTest {

    @Test
    void saveWebPageScreenshot(@TempDir Path screenshotRootDir) {
        String webPageScreenshot = WebScreenshotUtils.saveWebPageScreenshot("https://www.baidu.com", screenshotRootDir);
        Assertions.assertNotNull(webPageScreenshot);
    }
}