import { spawn } from 'node:child_process';
import { createFolioServer } from './server.mjs';

const port = Number(process.env.PORT || 4389);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('PORT 必须是有效端口号。');
const url = 'http://127.0.0.1:' + port + '/';
function openBrowser() {
  console.log('Folio · ' + url);
  const proc = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  proc.on('error', () => console.log('请在浏览器中打开上面的地址。'));
  proc.unref();
}
const server = createFolioServer();
server.on('error', async (error) => {
  if (error.code === 'EADDRINUSE') {
    try {
      const reply = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (reply.ok && (await reply.text()).includes('<title>Folio — NovelAI 图像工作台</title>')) {
        openBrowser();
        return;
      }
    } catch {}
    console.error('端口 ' + port + ' 已被其他程序占用，请修改 PORT 后启动。');
  } else console.error('启动失败：' + error.message);
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => {
  openBrowser();
  console.log('关闭此窗口会停止本地服务。');
});
