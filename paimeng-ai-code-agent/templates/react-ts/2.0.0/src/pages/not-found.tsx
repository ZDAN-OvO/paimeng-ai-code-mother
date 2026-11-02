import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export function NotFoundPage() {
  return (
    <Card className="mx-auto max-w-lg text-center">
      <CardHeader>
        <CardTitle>页面不存在</CardTitle>
        <CardDescription>链接可能已经失效，回到工作台继续。</CardDescription>
      </CardHeader>
      <CardContent>
        <Button asChild>
          <Link to="/">返回工作台</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
