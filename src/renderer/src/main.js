/**
 * 渲染入口 —— 同一份构建产物按 ?route=pet|panel|chat|chatpet|petmenu 挂载不同应用。
 */
/* 必须是第一个 import：desk-shim 靠副作用装 window.desk，
   stores/app.js 在模块求值时就决定用 desk 还是 mock */
import './lib/desk-shim.js'
import { createApp } from 'vue'
import { store } from './stores/app.js'
import PetApp from './pet/PetApp.vue'
import PanelApp from './panel/PanelApp.vue'
import ChatApp from './chat/ChatApp.vue'
import ChatPetApp from './chat/ChatPetApp.vue'
import MenuApp from './pet/MenuApp.vue'
import './styles.css'

/*
 * 全局错误边界：渲染异常此前只进控制台 —— 托盘应用里用户面对的是
 * 白窗/缺件窗口，毫无感知。落 store.lastError 走现成的错误条展示；
 * 已有 lastError 时不再覆盖（避免错误条自身渲染出错时循环刷屏）。
 */
function installErrorHandlers(app) {
  app.config.errorHandler = (err, _instance, info) => {
    console.error('[renderer] 渲染异常:', err, `(${info})`)
    if (!store.lastError) store.lastError = `渲染异常: ${err?.message ?? err}`
  }
  window.addEventListener('error', (e) => {
    console.error('[renderer] 未捕获异常:', e.error ?? e.message)
  })
  window.addEventListener('unhandledrejection', (e) => {
    console.warn('[renderer] 未处理的 Promise 拒绝:', e.reason)
  })
}

const route = new URLSearchParams(window.location.search).get('route') || 'pet'
const root = document.getElementById('app')

/* pet 窗是业务宿主：service 随它装载（总线宿主 + 广播 + 托盘接线）。
   动态 import 让宿主只进 pet 窗的启动路径，不阻塞首屏渲染。 */
if (route === 'pet') {
  import('./lib/service-host.js')
    .then((m) => m.bootServiceHost())
    .catch((err) => console.error('[service-host] 业务宿主启动失败:', err))
}

if (route === 'panel') {
  document.body.classList.add('is-panel')
  const app = createApp(PanelApp)
  installErrorHandlers(app)
  app.mount(root)
} else if (route === 'chat') {
  document.body.classList.add('is-chat')
  const app = createApp(ChatApp)
  installErrorHandlers(app)
  app.mount(root)
} else if (route === 'chatpet') {
  document.body.classList.add('is-chatpet')
  const app = createApp(ChatPetApp)
  installErrorHandlers(app)
  app.mount(root)
} else if (route === 'petmenu') {
  /* 桌宠右键菜单窗：常驻隐藏，右键时由壳层定位到光标并显示 */
  document.body.classList.add('is-petmenu')
  const app = createApp(MenuApp)
  installErrorHandlers(app)
  app.mount(root)
} else {
  document.body.classList.add('is-pet')
  const app = createApp(PetApp)
  installErrorHandlers(app)
  app.mount(root)
}
