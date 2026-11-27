package com.zdan.paimengaicodemother.service.impl;

import com.mybatisflex.core.query.QueryCondition;
import com.mybatisflex.core.query.RawQueryCondition;

final class PostgresQueryConditions {

    private PostgresQueryConditions() {
    }

    // 列名由调用方写死，查询值通过 JDBC 参数绑定。
    static QueryCondition equalIgnoringCaseAndTrailingSpaces(String column, String value) {
        if (value == null) {
            return QueryCondition.createEmpty();
        }
        return new RawQueryCondition("LOWER(RTRIM(\"" + column + "\")) = LOWER(RTRIM(?))", value);
    }

    static QueryCondition containsIgnoringCase(String column, String value) {
        if (value == null) {
            return QueryCondition.createEmpty();
        }
        return new RawQueryCondition("\"" + column + "\" ILIKE ?", "%" + value + "%");
    }
}
