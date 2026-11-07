import { Button } from '@/components/ui/button';

export default function Home() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-5xl flex-col justify-center gap-10 px-6 py-24">
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">骨架阶段</p>
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">Paimeng</h1>
        <p className="max-w-xl text-base leading-7 text-muted-foreground">
          用一句自然语言描述，生成一个完整的 Next.js
          应用，在沙箱里实时预览，通过对话迭代，按版本回滚，最后发布成一个可访问的地址。
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button disabled title="生成闭环尚未接通">
          开始构建
        </Button>
        <Button variant="outline" disabled title="项目列表尚未接通">
          我的项目
        </Button>
      </div>
      <dl className="grid max-w-2xl grid-cols-1 gap-4 text-sm sm:grid-cols-3">
        <div className="rounded-lg border p-4">
          <dt className="font-medium">沙箱</dt>
          <dd className="mt-1 text-muted-foreground">每个对话一个 Docker 容器，默认禁出站。</dd>
        </div>
        <div className="rounded-lg border p-4">
          <dt className="font-medium">版本</dt>
          <dd className="mt-1 text-muted-foreground">每条助手消息一个源码快照，可 diff 可回滚。</dd>
        </div>
        <div className="rounded-lg border p-4">
          <dt className="font-medium">发布</dt>
          <dd className="mt-1 text-muted-foreground">构建产物跑在只读容器里，按地址路由。</dd>
        </div>
      </dl>
    </main>
  );
}
