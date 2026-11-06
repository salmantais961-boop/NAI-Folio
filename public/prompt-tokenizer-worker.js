import { loadTokenizer } from './prompt-tokenizer-core.js'

const encoders = new Map()
self.onmessage = async ({ data: { id, type, texts } }) => {
  try {
    if (!encoders.has(type)) encoders.set(type, loadTokenizer(type).catch((error) => { encoders.delete(type); throw error }))
    const tokenizer = await encoders.get(type)
    const counts = texts.map((text) => tokenizer.encode(text).length)
    self.postMessage({ id, counts })
  } catch (error) {
    self.postMessage({ id, error: error.message || 'Token 计数暂不可用。' })
  }
}
