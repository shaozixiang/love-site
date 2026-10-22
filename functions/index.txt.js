// 已归档/已移除的测试页与旧文件，不对外发布
export async function onRequest() {
  return new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
