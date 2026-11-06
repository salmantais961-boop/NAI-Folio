// Local implementations of the tokenizers used by NovelAI's public image client.
// Upstream revisions and vocabulary checksums live in tokenizers/sources.json.
const encoder = new TextEncoder()
const cacheLimit = 4096
const escapeRE = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function tokenizerSpec(model = '') {
  if (/^nai-diffusion-5-(full|curated)(?:-|$)/.test(model))
    return { type: 'qwen35', label: 'Qwen 3.5', limit: model.includes('curated') ? 703 : 1471, characters: true }
  if (/^nai-diffusion-4(?:-5)?-(full|curated)(?:-|$)/.test(model))
    return { type: 't5', label: 'T5', limit: 512, characters: true }
  if (/^nai-diffusion-(?:furry-)?3(?:-|$)/.test(model))
    return { type: 'clip', label: 'CLIP', limit: 225, characters: false }
  return null
}

function byteAlphabet() {
  const bytes = []
  for (const [start, end] of [[33, 126], [161, 172], [174, 255]])
    for (let value = start; value <= end; value++) bytes.push(value)
  const codepoints = [...bytes]
  let extra = 256
  for (let value = 0; value < 256; value++)
    if (!bytes.includes(value)) { bytes.push(value); codepoints.push(extra++) }
  const map = []
  bytes.forEach((value, index) => { map[value] = String.fromCodePoint(codepoints[index]) })
  return { map, characters: codepoints.map((value) => String.fromCodePoint(value)) }
}
const alphabet = byteAlphabet()

class BytePairTokenizer {
  constructor(vocab, merges, { clip = false, specials = [], regex, normalization, entities = {} } = {}) {
    this.vocab = vocab
    this.ranks = new Map(merges.map(([left, right], rank) => [left + '\0' + right, rank]))
    this.clip = clip
    this.specials = new Set(specials)
    this.specialPattern = specials.length ? new RegExp('(' + [...specials].sort((a, b) => b.length - a.length).map(escapeRE).join('|') + ')', 'g') : null
    this.regex = new RegExp(regex, 'gu')
    this.normalization = normalization
    this.entities = entities
    this.cache = new Map()
  }
  pieces(word) {
    if (this.cache.has(word)) return this.cache.get(word)
    let parts = Array.from(encoder.encode(word), (byte) => alphabet.map[byte])
    if (this.clip && parts.length) parts[parts.length - 1] += '</w>'
    while (parts.length > 1) {
      let rank = Infinity, pair
      for (let i = 0; i < parts.length - 1; i++) {
        const key = parts[i] + '\0' + parts[i + 1]
        const candidate = this.ranks.get(key)
        if (candidate < rank) { rank = candidate; pair = key }
      }
      if (!pair) break
      const merged = []
      for (let i = 0; i < parts.length; i++) {
        if (i + 1 < parts.length && parts[i] + '\0' + parts[i + 1] === pair)
          merged.push(parts[i] + parts[++i])
        else merged.push(parts[i])
      }
      parts = merged
    }
    const ids = parts.map((part) => this.vocab[part])
    if (ids.some((id) => id === undefined)) throw Error('Tokenizer vocabulary is incomplete.')
    if (this.cache.size >= cacheLimit) this.cache.delete(this.cache.keys().next().value)
    this.cache.set(word, ids)
    return ids
  }
  encode(text) {
    text = String(text ?? '')
    if (this.clip) {
      text = text.replace(/[[\]{}]/g, ' ').trim()
      text = decodeEntities(decodeEntities(text, this.entities), this.entities)
      text = text.replace(/\s+/g, ' ').trim().toLowerCase()
    } else if (this.normalization) text = text.normalize(this.normalization)
    const ids = []
    for (const segment of this.specialPattern ? text.split(this.specialPattern) : [text]) {
      if (this.specials.has(segment)) { ids.push(this.vocab[segment]); continue }
      for (const match of segment.matchAll(this.regex)) ids.push(...this.pieces(match[0]))
    }
    return ids
  }
}

function decodeEntities(text, entities) {
  return text.replace(/&(#(?:x[\da-f]+|\d+);?|[a-z][\da-z]*;?)/gi, (match, name) => {
    if (name[0] === '#') {
      const hex = name[1].toLowerCase() === 'x'
      let code = parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10)
      const win1252 = {128:8364,130:8218,131:402,132:8222,133:8230,134:8224,135:8225,136:710,137:8240,138:352,139:8249,140:338,142:381,145:8216,146:8217,147:8220,148:8221,149:8226,150:8211,151:8212,152:732,153:8482,154:353,155:8250,156:339,158:382,159:376}
      code = win1252[code] || code
      return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? '\ufffd' : String.fromCodePoint(code)
    }
    for (let end = name.length; end > 0; end--)
      if (Object.hasOwn(entities, name.slice(0, end))) return entities[name.slice(0, end)] + name.slice(end)
    return match
  })
}

class T5Tokenizer {
  constructor(config) {
    this.vocab = config.model.vocab
    this.unknown = config.model.unk_id
    this.eos = this.vocab.findIndex(([piece]) => piece === '</s>')
    this.unknownScore = Math.min(...this.vocab.map(([, score]) => score)) - 10
    this.root = { children: new Map() }
    this.cache = new Map()
    this.vocab.forEach(([piece, score], id) => {
      let node = this.root
      // The public T5 counter indexes UTF-16, including its unknown-character fallback.
      for (let i = 0; i < piece.length; i++) {
        if (!node.children.has(piece[i])) node.children.set(piece[i], { children: new Map() })
        node = node.children.get(piece[i])
      }
      node.id = id
      node.score = id === this.unknown ? this.unknownScore : score
    })
  }
  pieces(word) {
    if (this.cache.has(word)) return this.cache.get(word)
    const length = word.length, scores = new Float64Array(length + 1).fill(-Infinity)
    const previous = new Int32Array(length + 1), chosen = new Int32Array(length + 1)
    scores[0] = 0
    for (let start = 0; start < length; start++) {
      let node = this.root, single = false
      for (let end = start; end < length; end++) {
        node = node.children.get(word[end])
        if (!node) break
        if (node.id !== undefined) {
          if (end === start) single = true
          const score = scores[start] + node.score
          if (score > scores[end + 1]) { scores[end + 1] = score; previous[end + 1] = start; chosen[end + 1] = node.id }
        }
      }
      if (!single) {
        const score = scores[start] + this.unknownScore
        if (score > scores[start + 1]) { scores[start + 1] = score; previous[start + 1] = start; chosen[start + 1] = this.unknown }
      }
    }
    const ids = []
    for (let at = length; at > 0; at = previous[at]) ids.push(chosen[at])
    ids.reverse()
    if (this.cache.size >= cacheLimit) this.cache.delete(this.cache.keys().next().value)
    this.cache.set(word, ids)
    return ids
  }
  encode(text) {
    if (text == null || text === '') return [this.eos]
    // Matches the current official web counter: emphasis markers are not T5 content.
    text = String(text).replace(/[[\]{}]/g, '').replace(/-?\d*\.?\d*::/g, '')
    const ids = []
    for (const word of text.split(/\s+/)) ids.push(...this.pieces(word.startsWith('▁') ? word : '▁' + word))
    ids.push(this.eos)
    return ids
  }
}

export function createTokenizer(type, config) {
  if (type === 't5') return new T5Tokenizer(config)
  if (type === 'qwen35') return new BytePairTokenizer(config.vocab, config.merges, {
    specials: config.specialTokens,
    regex: config.config.splitRegex,
    normalization: config.config.normalization,
  })
  if (type === 'clip') {
    const merges = config.merges || config.text.split('\n').slice(1, 48895).map((line) => line.split(' '))
    const pieces = [...alphabet.characters, ...alphabet.characters.map((char) => char + '</w>'), ...merges.map((pair) => pair.join('')), '<|startoftext|>', '<|endoftext|>']
    return new BytePairTokenizer(Object.fromEntries(pieces.map((piece, id) => [piece, id])), merges, {
      clip: true,
      specials: ['<|startoftext|>', '<|endoftext|>'],
      regex: "'s|'t|'re|'ve|'m|'ll|'d|[\\p{L}]+|[\\p{N}]|[^\\s\\p{L}\\p{N}]+",
      entities: config.entities,
    })
  }
  throw Error('当前模型暂无已核实的 tokenizer。')
}

export async function loadTokenizer(type, fetcher = fetch) {
  const response = await fetcher(new URL('./tokenizers/' + type + '.def', import.meta.url))
  if (!response.ok) throw Error('本地 tokenizer 词表读取失败。')
  if (typeof DecompressionStream === 'undefined') throw Error('当前浏览器不支持本地词表解压。')
  const stream = response.body.pipeThrough(new DecompressionStream('deflate-raw'))
  const config = await new Response(stream).json()
  return createTokenizer(type, config)
}
