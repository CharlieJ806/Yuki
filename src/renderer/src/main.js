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
} else {
  document.body.classList.add('is-pet')
  createApp(PetApp).mount(root)
}
