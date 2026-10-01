/**
 * dsh-whale-chan 浏览器半侧入口（lazy-CJS 工厂注册）。
 *
 * 【形态约束（0.1.7-rc.2 实测，见开发计划附录 B）】
 *   宿主 client-modules 以 combo script（普通脚本）形式加载本文件：
 *   顶层只能是 `window.__ModuleLoader__.load({ id, factory })` 的工厂注册，
 *   不能是 ESM（import/export 声明在普通脚本上下文是语法错误）。
 *   工厂运行于「物化」时机（首次 import/require），React 由平台种子表提供
 *   （require('react')，禁止自行打包）。
 *
 * 【实现模块装载】
 *   全部实现（DOM/逻辑/渲染）在 lib/client/*.mjs（ESM，node --test 可直接单测），
 *   由宿主半侧 /api/whale-pet/client/* 同源路由静态服务，这里动态 import 装载。
 *   动态 import 是异步的：apply 同步注册一个「桥」，模块就绪后完成 slots 注入。
 */
window.__ModuleLoader__.load({
  id: 'dsh-whale-chan',
  factory: (require) => {
    const React = require('react')

    return {
      name: 'whale-pet',
      inject: ['slots'],
      apply(ctx) {
        const bridge = { dispose: null, ready: false }
        import('/api/whale-pet/client/main.mjs')
          .then((mod) => {
            if (bridge.disposed) return
            bridge.ready = true
            bridge.dispose = mod.mountPet({ ctx, React })
          })
          .catch((error) => {
            console.warn('[whale-pet] client 模块装载失败（宠物不可见，宿主不受影响）：', error)
          })
        return () => {
          bridge.disposed = true
          if (typeof bridge.dispose === 'function') {
            try { bridge.dispose() } catch (error) { console.warn('[whale-pet] dispose 异常：', error) }
          }
          bridge.dispose = null
        }
      },
    }
  },
})
