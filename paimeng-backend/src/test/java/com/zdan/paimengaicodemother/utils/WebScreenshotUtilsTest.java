package com.zdan.paimengaicodemother.utils;

import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import javax.imageio.ImageIO;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class WebScreenshotUtilsTest {

    @Test
    void savesAReadableScreenshotOfTheLocalPage(@TempDir Path screenshotRootDir) throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            byte[] html = "<!doctype html><title>截图测试</title><h1>Paimeng</h1>"
                    .getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "text/html; charset=utf-8");
            exchange.sendResponseHeaders(200, html.length);
            try (var body = exchange.getResponseBody()) {
                body.write(html);
            }
        });
        server.start();
        try {
            String url = "http://127.0.0.1:" + server.getAddress().getPort() + "/";
            String path = WebScreenshotUtils.saveWebPageScreenshot(url, screenshotRootDir);
            assertNotNull(path);
            Path screenshot = Path.of(path);
            assertTrue(screenshot.startsWith(screenshotRootDir));
            var image = ImageIO.read(screenshot.toFile());
            assertNotNull(image);
            assertTrue(image.getWidth() > 0 && image.getHeight() > 0);
        } finally {
            server.stop(0);
        }
    }
}
