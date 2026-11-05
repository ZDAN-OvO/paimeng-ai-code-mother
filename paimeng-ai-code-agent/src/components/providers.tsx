'use client';
import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  type ReactNode,
} from 'react';
import { ConfigProvider, App as AntApp, Layout, Button, Dropdown, Avatar, Menu } from 'antd';
import { HomeOutlined, LogoutOutlined, UserOutlined } from '@ant-design/icons';
import Link from 'next/link';
import Image from 'next/image';
import { usePathname, useRouter } from 'next/navigation';
import type { User } from '@/shared/contracts';
import { api } from '@/client/api';
const AuthContext = createContext<{
  user: User | null;
  loading: boolean;
  /**
   * 身份作用域：登录用户变了（换账号或退出）就 +1。
   * 页面用 `<X key={sessionKey}>` 挂到它上面，上一位用户留下的组件状态会随重新挂载一起消失，
   * 不需要每个组件自己判断「这条响应是不是上个用户的」。
   */
  sessionKey: number;
  refresh: () => Promise<void>;
}>({ user: null, loading: true, sessionKey: 0, refresh: async () => {} });
export const useAuth = () => useContext(AuthContext);

/** 会话读取失败就是未登录；挂载和登录后的 refresh 共用同一份判断。 */
async function readSession(): Promise<User | null> {
  try {
    return await api<User>('user/get/login');
  } catch {
    return null;
  }
}
export function Providers({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [sessionKey, setSessionKey] = useState(0);
  const pathname = usePathname();
  const router = useRouter();
  // 已确认过的身份。首次读会话是 null → 用户，不算切换，避免刚打开页面就整页重挂。
  const knownIdentity = useRef<string | null>(null);
  // 登录、退出和挂载会并发读会话；只有最后一次请求能决定当前身份。
  const sessionTicket = useRef(0);
  const adopt = useCallback((next: User | null) => {
    const identity = next?.id ?? null;
    if (knownIdentity.current !== null && knownIdentity.current !== identity) {
      setSessionKey((value) => value + 1);
    }
    knownIdentity.current = identity;
    setUser(next);
    setLoading(false);
  }, []);
  const refresh = useCallback(async () => {
    const ticket = ++sessionTicket.current;
    const next = await readSession();
    if (ticket !== sessionTicket.current) return;
    adopt(next);
  }, [adopt]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const items = [
    { key: '/', icon: <HomeOutlined />, label: '主页' },
    ...(user ? [{ key: '/billing', label: '我的账单' }] : []),
    ...(user?.userRole === 'admin'
      ? [
          { key: '/admin/userManage', label: '用户管理' },
          { key: '/admin/appManage', label: '应用管理' },
          { key: '/admin/modelManage', label: '模型管理' },
          { key: '/admin/billing', label: '额度管理' },
        ]
      : []),
  ];
  async function logout() {
    await api('user/logout', {});
    await refresh();
    router.push('/user/login');
  }
  return (
    <ConfigProvider theme={{ token: { colorPrimary: '#cb573e', colorInfo: '#cb573e' } }}>
      <AntApp>
        <AuthContext.Provider value={{ user, loading, sessionKey, refresh }}>
          <Layout className="site-layout">
            <Layout.Header className="site-header">
              <Link className="brand" href="/">
                <Image
                  className="brand-logo"
                  src="/paimeng.png"
                  alt="派蒙"
                  width={64}
                  height={64}
                />
                <span>派蒙 AI 应用工坊</span>
              </Link>
              <Menu
                className="navigation"
                mode="horizontal"
                selectedKeys={[pathname]}
                items={items}
                onClick={(item) => router.push(item.key)}
              />
              {user ? (
                <Dropdown
                  menu={{
                    items: [{ key: 'logout', label: '退出登录', icon: <LogoutOutlined /> }],
                    onClick: () => {
                      void logout();
                    },
                  }}
                >
                  <Button type="text">
                    <Avatar src={user.userAvatar} icon={<UserOutlined />} />
                    {user.userName || '无名'}
                  </Button>
                </Dropdown>
              ) : (
                <Link href="/user/login">
                  <Button type="primary">登录</Button>
                </Link>
              )}
            </Layout.Header>
            {/* 换账号或退出后整块内容重挂：上一位用户的页面状态不可能留到新身份下。 */}
            <Layout.Content key={sessionKey} className="site-content">
              {children}
            </Layout.Content>
            {pathname.startsWith('/app/chat/') ? null : (
              <Layout.Footer className="site-footer">
                <a
                  className="author-link"
                  href="http://github.com/ZDAN-GHN"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Code by ZDAN-GHN
                </a>
              </Layout.Footer>
            )}
          </Layout>
        </AuthContext.Provider>
      </AntApp>
    </ConfigProvider>
  );
}
export function AdminGuard({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();
  const path = usePathname();
  useEffect(() => {
    if (!loading && user?.userRole !== 'admin')
      router.replace('/user/login?redirect=' + encodeURIComponent(path));
  }, [loading, user, router, path]);
  if (loading) return <p className="page-container">正在验证权限…</p>;
  return user?.userRole === 'admin' ? children : <p className="page-container">需要管理员权限</p>;
}
