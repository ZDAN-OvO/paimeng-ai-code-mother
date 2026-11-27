package com.zdan.paimengaicodemother.controller;

import com.zdan.paimengaicodemother.config.WorkspaceProperties;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.core.io.ClassPathResource;
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
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.InvalidPathException;
import java.nio.file.Path;
import java.util.regex.Pattern;

/**
 * 静态资源访问
 *
 * @author LXH
 */
@RestController
@RequestMapping("/static")
public class StaticResourceController {

    private static final String EDITOR_SCRIPT = "_visual-editor.js";
    private static final String HTML_GAP = "\\s*(?:<!--.*?-->\\s*)*";
    private static final String HTML_TAG_END = """
            (?:[^"'<>]++|"[^"]*"|'[^']*')*>""";
    private static final Pattern HTML_START = Pattern.compile(
            "\uFEFF?" + HTML_GAP
                    + "(?:<!doctype\\s+[^>]*>" + HTML_GAP + ")?"
                    + "(?:<html(?=[\\s>])" + HTML_TAG_END + HTML_GAP + ")?"
                    + "(?:<head(?=[\\s>])" + HTML_TAG_END + ")?",
            Pattern.CASE_INSENSITIVE | Pattern.DOTALL);

    private final WorkspaceProperties workspaceProperties;

    public StaticResourceController(WorkspaceProperties workspaceProperties) {
        this.workspaceProperties = workspaceProperties;
    }

    @GetMapping("/" + EDITOR_SCRIPT)
    public ResponseEntity<Resource> serveVisualEditor() {
        return ResponseEntity.ok()
                .header(HttpHeaders.CONTENT_TYPE, "application/javascript; charset=UTF-8")
                .body(new ClassPathResource("preview/visual-editor.js"));
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

            Resource resource = file.toString().endsWith(".html")
                    ? previewHtml(file, resourcePath)
                    : new FileSystemResource(file);
            return ResponseEntity.ok()
                    .header(HttpHeaders.CONTENT_TYPE, getContentTypeWithCharset(file.toString()))
                    .body(resource);
        } catch (IOException | InvalidPathException error) {
            return ResponseEntity.notFound().build();
        }
    }

    private Resource previewHtml(Path file, String resourcePath) throws IOException {
        String html = new String(Files.readAllBytes(file), StandardCharsets.UTF_8);
        int depth = (int) resourcePath.chars().filter(character -> character == '/').count();
        String script = "<script defer src=\"" + "../".repeat(depth) + EDITOR_SCRIPT + "\"></script>";

        // 在 base 标签之前解析脚本地址，使相对路径沿用浏览器看到的 API 前缀。
        var start = HTML_START.matcher(html);
        int offset = start.lookingAt() ? start.end() : 0;
        String preview = html.substring(0, offset) + script + html.substring(offset);
        return new ByteArrayResource(preview.getBytes(StandardCharsets.UTF_8));
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
