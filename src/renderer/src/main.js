/**
 * 渲染入口 —— 同一份构建产物按 ?route=pet|panel|chat|chatpet 挂载不同应用。
 */
/* 必须是第一个 import：desk-shim 靠副作用装 window.desk，
   stores/app.js 在模块求值时就决定用 desk 还是 mock */
import './lib/desk-shim.js'
import { createApp } from 'vue'
import PetApp from './pet/PetApp.vue'
import PanelApp from './panel/PanelApp.vue'
import ChatApp from './chat/ChatApp.vue'
import ChatPetApp from './chat/ChatPetApp.vue'
import './styles.css'

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
  createApp(PanelApp).mount(root)
} else if (route === 'chat') {
  document.body.classList.add('is-chat')
  createApp(ChatApp).mount(root)
} else if (route === 'chatpet') {
  document.body.classList.add('is-chatpet')
  createApp(ChatPetApp).mount(root)
} else {
  document.body.classList.add('is-pet')
  createApp(PetApp).mount(root)
}
