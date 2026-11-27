package com.zdan.paimengaicodemother.controller;

import com.mybatisflex.core.paginate.Page;
import com.zdan.paimengaicodemother.annotation.AuthCheck;
import com.zdan.paimengaicodemother.common.BaseResponse;
import com.zdan.paimengaicodemother.common.ResultUtils;
import com.zdan.paimengaicodemother.constant.UserConstant;
import com.zdan.paimengaicodemother.model.dto.chathistory.ChatHistoryQueryRequest;
import com.zdan.paimengaicodemother.model.entity.ChatHistory;
import com.zdan.paimengaicodemother.model.entity.User;
import com.zdan.paimengaicodemother.service.ChatHistoryService;
import com.zdan.paimengaicodemother.service.UserService;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.web.bind.annotation.*;

import java.math.BigInteger;
import java.time.LocalDateTime;
import java.util.List;

/**
 * 对话历史 控制层。
 *
 * @author LXH
 */
@RestController
@RequestMapping("/chatHistory")
public class ChatHistoryController {

    private final ChatHistoryService chatHistoryService;
    private final UserService userService;

    public ChatHistoryController(ChatHistoryService chatHistoryService,
                                 UserService userService) {
        this.chatHistoryService = chatHistoryService;
        this.userService = userService;
    }

    /**
     * 分页查询某个应用的对话历史（游标查询）
     *
     * @param appId          应用ID
     * @param pageSize       页面大小
     * @param lastCreateTime 最后一条记录的创建时间
     * @param lastId         同秒内最后一条消息的 ID
     * @param request        请求
     * @return 对话历史分页
     */
    @GetMapping("/app/{appId}")
    public BaseResponse<HistoryPage> listAppChatHistory(@PathVariable Long appId,
                                                              @RequestParam(defaultValue = "10") int pageSize,
                                                              @RequestParam(required = false)
                                                              @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME)
                                                              LocalDateTime lastCreateTime,
                                                              @RequestParam(required = false) Long lastId,
                                                              HttpServletRequest request) {
        User loginUser = userService.getLoginUser(request);
        Page<ChatHistory> result = chatHistoryService.listAppChatHistoryByPage(appId, pageSize, lastCreateTime, lastId, loginUser);
        return ResultUtils.success(new HistoryPage(result));
    }

    /**
     * 管理员分页查询所有对话历史
     *
     * @param chatHistoryQueryRequest 查询请求
     * @return 对话历史分页
     */
    @PostMapping("/admin/list/page/vo")
    @AuthCheck(mustRole = UserConstant.ADMIN_ROLE)
    public BaseResponse<HistoryPage> listAllChatHistoryByPageForAdmin(
            @RequestBody ChatHistoryQueryRequest chatHistoryQueryRequest) {
        return ResultUtils.success(new HistoryPage(chatHistoryService.listAdminChatHistoryByPage(chatHistoryQueryRequest)));
    }

    public record HistoryPage(List<ChatHistory> records, BigInteger pageNumber, BigInteger pageSize,
                              BigInteger totalPage, BigInteger totalRow) {
        HistoryPage(Page<ChatHistory> page) {
            this(page.getRecords(), BigInteger.valueOf(page.getPageNumber()), BigInteger.valueOf(page.getPageSize()),
                    BigInteger.valueOf(page.getTotalPage()), BigInteger.valueOf(page.getTotalRow()));
        }
    }
}
