# Paimeng

个人本地 Web 开发助手，通过对话创建和修改 Next.js / React 项目。

## 启动界面

```bash
npm install
npm run dev -- --hostname 127.0.0.1
```

打开 <http://127.0.0.1:3000/>。

当前工作区使用演示数据，可以查看对话、预览、文件和改动。真实本地目录、项目进程和模型调用尚未接通；启动界面不需要 Docker、数据库服务或模型密钥。

产品与接口说明只维护 [docs/api.md](docs/api.md)。

## 初始化本地存储

```bash
cp .env.example .env
npm run db:migrate
```

默认创建 `data/paimeng.sqlite`。修改 `.env` 中的 `DATABASE_PATH` 可更换位置。模型接入参数也在 `.env.example`，尚未用于工作区的示例对话。
