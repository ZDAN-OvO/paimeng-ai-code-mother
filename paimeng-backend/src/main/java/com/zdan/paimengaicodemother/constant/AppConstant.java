package com.zdan.paimengaicodemother.constant;

/**
 * 应用模块系统常量类
 *
 * @author LXH
 */
public interface AppConstant {

    /**
     * 精选应用的优先级
     */
    Integer GOOD_APP_PRIORITY = 99;

    /**
     * 默认应用优先级
     */
    Integer DEFAULT_APP_PRIORITY = 0;

    // region --- 应用部署配置
    /**
     * 应用部署域名
     */
    String CODE_DEPLOY_HOST = "http://localhost";
    // endregion 应用部署配置
}