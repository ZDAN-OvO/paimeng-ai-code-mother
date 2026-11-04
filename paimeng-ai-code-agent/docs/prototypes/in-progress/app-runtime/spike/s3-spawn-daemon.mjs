import { spawn } from 'node:child_process';

/** 双 fork 型后台进程：detached + unref，父进程退出后仍然写文件。 */
const file = process.argv[2] ?? '/work/late.log';
const child = spawn('sh', ['-c', `sleep 1.5; echo leak-daemon >> ${file}`], { detached: true, stdio: 'ignore' });
child.unref();
console.log(JSON.stringify({ pid: child.pid }));
