/**
 * 渲染入口 —— 同一份构建产物按 ?route=pet|panel|chat|chatpet 挂载不同应用。
 */
import { createApp } from 'vue'
import PetApp from './pet/PetApp.vue'
import PanelApp from './panel/PanelApp.vue'
import ChatApp from './chat/ChatApp.vue'
import ChatPetApp from './chat/ChatPetApp.vue'
import './styles.css'

const route = new URLSearchParams(window.location.search).get('route') || 'pet'
const root = document.getElementById('app')

if (route === 'panel') {
  document.body.classList.add('is-panel')
  createApp(PanelApp).mount(root)
} else if (route === 'chat') {
  document.body.classList.add('is-chat')
  createApp(ChatApp).mount(root)
} else if (route === 'chatpet') {
  document.body.classList.add('is-chatpet')
  createApp(ChatPetApp).mount(root)
} else if (route === 'pet3d') {
  /*
   * 3D 可行性验证台，动态 import：
   * 它会拖进 three.js（约 600KB），静态引入等于让桌宠窗白付这份体积。
   * 只有真的走 ?route=pet3d 时才拉这个 chunk。
   */
  const { default: Pet3DLabView } = await import('./views/Pet3DLabView.vue')
  createApp(Pet3DLabView).mount(root)
} else {
  document.body.classList.add('is-pet')
  createApp(PetApp).mount(root)
}
