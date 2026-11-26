package com.zdan.paimengaicodemother.controller;

import com.zdan.paimengaicodemother.config.WorkspaceProperties;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.Resource;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.HandlerMapping;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.InvalidPathException;
import java.nio.file.Path;

/**
 * 静态资源访问
 *
 * @author LXH
 */
@RestController
@RequestMapping("/static")
public class StaticResourceController {

    private final WorkspaceProperties workspaceProperties;

    public StaticResourceController(WorkspaceProperties workspaceProperties) {
        this.workspaceProperties = workspaceProperties;
    }

    /**
     * 提供静态资源访问，支持目录重定向
     * 访问格式：http://localhost:8123/api/static/{deployKey}/{fileName}
     */
    @GetMapping("/{deployKey}/**")
    public ResponseEntity<Resource> serveStaticResource(
            @PathVariable String deployKey,
            HttpServletRequest request) {
        if (!deployKey.matches("[A-Za-z0-9_-]+")) {
            return ResponseEntity.notFound().build();
        }
        try {
            String resourcePath = (String) request.getAttribute(HandlerMapping.PATH_WITHIN_HANDLER_MAPPING_ATTRIBUTE);
            resourcePath = resourcePath.substring(("/static/" + deployKey).length());
            if (resourcePath.isEmpty()) {
                HttpHeaders headers = new HttpHeaders();
                headers.add("Location", request.getRequestURI() + "/");
                return new ResponseEntity<>(headers, HttpStatus.MOVED_PERMANENTLY);
            }
            if (!resourcePath.startsWith("/") || resourcePath.indexOf('\\') >= 0 || resourcePath.indexOf(':') >= 0) {
                return ResponseEntity.notFound().build();
            }

            Path relative = Path.of(resourcePath.equals("/") ? "index.html" : resourcePath.substring(1));
            for (Path part : relative) {
                if (part.toString().equals("..")) {
                    return ResponseEntity.notFound().build();
                }
            }
            Path root = workspaceProperties.getCodeOutputRootDir().toRealPath();
            Path app = root.resolve(deployKey);
            if (relative.getRoot() != null || !app.toRealPath().equals(app)) {
                return ResponseEntity.notFound().build();
            }
            Path file = app.resolve(relative).normalize().toRealPath();
            if (!file.startsWith(app) || !Files.isRegularFile(file)) {
                return ResponseEntity.notFound().build();
            }

            return ResponseEntity.ok()
                    .header("Content-Type", getContentTypeWithCharset(file.toString()))
                    .body(new FileSystemResource(file));
        } catch (IOException | InvalidPathException error) {
            return ResponseEntity.notFound().build();
        }
    }

    /**
     * 根据文件扩展名返回带字符编码的 Content-Type
     */
    private String getContentTypeWithCharset(String filePath) {
        if (filePath.endsWith(".html")) return "text/html; charset=UTF-8";
        if (filePath.endsWith(".css")) return "text/css; charset=UTF-8";
        if (filePath.endsWith(".js")) return "application/javascript; charset=UTF-8";
        if (filePath.endsWith(".png")) return "image/png";
        if (filePath.endsWith(".jpg")) return "image/jpeg";
        return "application/octet-stream";
    }
}
