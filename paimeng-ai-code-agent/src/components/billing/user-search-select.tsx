'use client';
import { useEffect, useRef, useState } from 'react';
import { Select, Spin } from 'antd';
import { api } from '@/client/api';
import type { AdminCreditUser, AdminUserSearchResult } from '@/shared/billing';

/**
 * 管理面的用户选择器：按账号/用户名模糊搜索，完整用户 ID 直接粘贴也能命中。
 * 下拉候选与选中后的身份展示都读同一份 `AdminCreditUser`，提交仍然只送用户 ID。
 */
export function UserSearchSelect({
  value,
  onChange,
  ariaLabel = '选择用户',
  placeholder = '搜索账号、用户名或粘贴用户 ID',
}: {
  value?: string;
  onChange?: (value: string, user: AdminCreditUser | null) => void;
  ariaLabel?: string;
  placeholder?: string;
}) {
  const [options, setOptions] = useState<AdminCreditUser[]>([]);
  const [loading, setLoading] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requested = useRef('');

  async function fetchUsers(query: string): Promise<AdminCreditUser[]> {
    const result = await api<AdminUserSearchResult>(
      'admin/billing/users?limit=10&q=' + encodeURIComponent(query.trim()),
    );
    return result.users;
  }

  async function search(query: string) {
    requested.current = query;
    setLoading(true);
    try {
      const users = await fetchUsers(query);
      if (requested.current === query) setOptions(users);
    } catch {
      if (requested.current === query) setOptions([]);
    } finally {
      if (requested.current === query) setLoading(false);
    }
  }

  /** 完整 ID 粘贴后直接回车：先取一次精确结果，有候选就选中第一条，不要求用户再点下拉。 */
  async function selectFirst(query: string) {
    try {
      const users = await fetchUsers(query);
      setOptions(users);
      const first = users[0];
      if (first) onChange?.(first.userId, first);
    } catch {
      setOptions([]);
    }
  }

  useEffect(() => {
    // 已选中的 ID 可能来自总览行或直接粘贴：即使没有搜索词，也要把它解析成可读身份。
    void search(value ?? '');
  }, [value]);

  function schedule(query: string) {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void search(query), 250);
  }

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return (
    <Select
      aria-label={ariaLabel}
      style={{ width: '100%', minWidth: 240 }}
      showSearch
      allowClear
      value={value}
      placeholder={placeholder}
      filterOption={false}
      onSearch={schedule}
      onInputKeyDown={(event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        void selectFirst(event.currentTarget.value);
      }}
      notFoundContent={loading ? <Spin size="small" /> : '没有匹配的用户'}
      options={options.map((user) => ({
        value: user.userId,
        label: `${user.userAccount}（${user.userName || '未设置用户名'}）· ${user.userId}`,
        user,
      }))}
      onChange={(next: string | undefined) => {
        const user = options.find((option) => option.userId === next) ?? null;
        onChange?.(next ?? '', user);
      }}
    />
  );
}
