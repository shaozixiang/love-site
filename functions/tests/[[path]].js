// 敏感/内部目录一律不对外发布（Pages Function 优先于静态资源，弥补 _redirects 静态资源优先的限制）
export async function onRequest() {
  return new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
