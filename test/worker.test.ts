import { describe, expect, it } from 'vitest'
import worker, { deriveCode, renderSvg } from '../src/index'

async function get(path: string) {
  return worker.fetch(new Request(`https://identicon.mzm.dev${path}`))
}

// identicon@3.1.1 実装で実測した期待値（SHA-1 先頭4byte・code・派生ビット・前景色）
const REFERENCE = [
  {
    id: 'koh110',
    code: -2100837965,
    middleType: 15,
    middleInvert: false,
    cornerType: 6,
    cornerInvert: true,
    cornerTurn: 1,
    sideType: 0,
    sideInvert: true,
    sideTurn: 3,
    foreColor: 'rgb(128,176,56)',
  },
  {
    id: 'test',
    code: -1454731291,
    middleType: 4,
    middleInvert: true,
    cornerType: 12,
    cornerInvert: true,
    cornerTurn: 3,
    sideType: 3,
    sideInvert: false,
    sideTurn: 1,
    foreColor: 'rgb(168,80,80)',
  },
  {
    id: 'user1',
    code: -1277515909,
    middleType: 15,
    middleInvert: false,
    cornerType: 15,
    cornerInvert: false,
    cornerTurn: 3,
    sideType: 9,
    sideInvert: false,
    sideTurn: 1,
    foreColor: 'rgb(176,240,208)',
  },
  {
    id: 'alice',
    code: 1378559850,
    middleType: 8,
    middleInvert: false,
    cornerType: 13,
    cornerInvert: false,
    cornerTurn: 3,
    sideType: 9,
    sideInvert: false,
    sideTurn: 2,
    foreColor: 'rgb(80,136,88)',
  },
  {
    id: 'bob',
    code: 1209539277,
    middleType: 4,
    middleInvert: true,
    cornerType: 9,
    cornerInvert: true,
    cornerTurn: 2,
    sideType: 6,
    sideInvert: false,
    sideTurn: 0,
    foreColor: 'rgb(72,0,192)',
  },
  {
    id: '123456',
    code: 2085260553,
    middleType: 4,
    middleInvert: false,
    cornerType: 1,
    cornerInvert: false,
    cornerTurn: 1,
    sideType: 3,
    sideInvert: false,
    sideTurn: 1,
    foreColor: 'rgb(120,16,80)',
  },
]

describe('deriveCode (identicon@3.1.1 互換)', () => {
  for (const ref of REFERENCE) {
    it(`seed "${ref.id}"`, async () => {
      const code = await deriveCode(ref.id)
      expect(code.code).toBe(ref.code)
      expect(code.middleType).toBe(ref.middleType)
      expect(code.middleInvert).toBe(ref.middleInvert)
      expect(code.cornerType).toBe(ref.cornerType)
      expect(code.cornerInvert).toBe(ref.cornerInvert)
      expect(code.cornerTurn).toBe(ref.cornerTurn)
      expect(code.sideType).toBe(ref.sideType)
      expect(code.sideInvert).toBe(ref.sideInvert)
      expect(code.sideTurn).toBe(ref.sideTurn)
      expect(code.foreColor).toBe(ref.foreColor)
    })
  }
})

describe('renderSvg', () => {
  it('同じIDは常に同じSVGを返す', async () => {
    expect(await renderSvg('koh110')).toBe(await renderSvg('koh110'))
  })

  it('異なるIDは異なるSVGを返す', async () => {
    expect(await renderSvg('koh110')).not.toBe(await renderSvg('test'))
  })

  it('150x150のSVG構造をもち、ユーザー入力を本文に埋め込まない', async () => {
    const svg = await renderSvg('<script>alert(1)</script>')
    expect(svg).toContain('width="150"')
    expect(svg).toContain('height="150"')
    expect(svg).toContain('viewBox="0 0 150 150"')
    expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg"')
    expect(svg).not.toContain('<script')
    expect(svg).not.toContain('foreignObject')
    expect(svg).not.toContain('href="http')
    expect(svg).not.toContain('<script>alert(1)</script>')
    expect(svg.match(/<polygon /g)).toHaveLength(9)
  })

  it('可変サイズでもSVGの寸法とpatch数が一致する', async () => {
    const svg = await renderSvg('koh110', 90)
    expect(svg).toContain('width="90"')
    expect(svg).toContain('height="90"')
    expect(svg.match(/<polygon /g)).toHaveLength(9)
  })

  it('背景は白で前景色は派生色を使う', async () => {
    const svg = await renderSvg('koh110')
    expect(svg).toContain('fill="rgb(255,255,255)"')
    expect(svg).toContain('fill="rgb(128,176,56)"')
  })
})

describe('API', () => {
  it('GET / は 200 "identicon"', async () => {
    const res = await get('/')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(await res.text()).toBe('identicon')
  })

  it('GET /api/identicon/koh110 は 200 SVG + キャッシュ・nosniff headers', async () => {
    const res = await get('/api/identicon/koh110')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/svg+xml; charset=utf-8')
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await res.text()).toContain('<svg')
  })

  it('空IDは400を返す', async () => {
    const res = await get('/api/identicon/')
    expect(res.status).toBe(400)
  })

  it('未知のパスは404を返す', async () => {
    const res = await get('/not-found')
    expect(res.status).toBe(404)
    expect(await res.text()).toBe('Not Found')
  })

  it('GET以外は405を返す', async () => {
    const res = await worker.fetch(new Request('https://identicon.mzm.dev/', { method: 'POST' }))
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toBe('GET, HEAD')
  })

  it('不正なpercent encodingは400を返す', async () => {
    const res = await get('/api/identicon/%E0%A4%A')
    expect(res.status).toBe(400)
  })
})
