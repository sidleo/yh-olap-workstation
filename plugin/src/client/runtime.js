// 客户端运行时上下文（apply 时注入），供不能直接拿到 ctx 的模块使用。
let clientCtx = null

export function setClientCtx(ctx) { clientCtx = ctx }

export function getService(name) {
  try { return clientCtx ? clientCtx.get(name) : undefined } catch (e) { return undefined }
}

export function waitService(deps, cb) {
  if (!clientCtx) return function () {}
  try { return clientCtx.inject(deps, cb) } catch (e) { return function () {} }
}
