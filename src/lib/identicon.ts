/**
 * identicon@3.1.1 (Ajido/node-identicon) と互換な SVG 生成。
 * patch 配列・派生ビット・回転・配色は元実装をそのまま移植する。
 * ユーザー入力は SHA-1 計算のみに使用し、SVG 本文には埋め込まない。
 */

const SIZE = 150

const patch0 = [0, 4, 24, 20]
const patch1 = [0, 4, 20]
const patch2 = [2, 24, 20]
const patch3 = [0, 2, 20, 22]
const patch4 = [2, 14, 22, 10]
const patch5 = [0, 14, 24, 22]
const patch6 = [2, 24, 22, 13, 11, 22, 20]
const patch7 = [0, 14, 22]
const patch8 = [6, 8, 18, 16]
const patch9 = [4, 20, 10, 12, 2]
const patch10 = [0, 2, 12, 10]
const patch11 = [10, 14, 22]
const patch12 = [20, 12, 24]
const patch13 = [10, 2, 12]
const patch14 = [0, 2, 10]

const patchTypes = [
  patch0,
  patch1,
  patch2,
  patch3,
  patch4,
  patch5,
  patch6,
  patch7,
  patch8,
  patch9,
  patch10,
  patch11,
  patch12,
  patch13,
  patch14,
  patch0,
]

const centerPatchTypes = [0, 4, 8, 15]

export interface IdenticonCode {
  code: number
  middleType: number
  middleInvert: boolean
  cornerType: number
  cornerInvert: boolean
  cornerTurn: number
  sideType: number
  sideInvert: boolean
  sideTurn: number
  red: number
  green: number
  blue: number
  foreColor: string
}

/**
 * SHA-1 の先頭 4byte から signed 32bit code を生成し、
 * identicon@3.1.1 と同じビット位置から各属性を派生する。
 */
export async function deriveCode(str: string): Promise<IdenticonCode> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-1', new TextEncoder().encode(str)),
  )
  // 元実装は 8bit 文字列の charCodeAt を用いるため、
  // 2 の補数符号付き 32bit 整数として解釈する。
  const code = ((digest[0] << 24) | (digest[1] << 16) | (digest[2] << 8) | digest[3]) | 0
  const middleType = centerPatchTypes[code & 3]
  const middleInvert = ((code >> 2) & 1) !== 0
  const cornerType = (code >> 3) & 15
  const cornerInvert = ((code >> 7) & 1) !== 0
  const cornerTurn = (code >> 8) & 3
  const sideType = (code >> 10) & 15
  const sideInvert = ((code >> 14) & 1) !== 0
  const sideTurn = (code >> 15) & 3
  const blue = (code >> 16) & 31
  const green = (code >> 21) & 31
  const red = (code >> 27) & 31
  const foreColor = `rgb(${red << 3},${green << 3},${blue << 3})`
  return {
    code,
    middleType,
    middleInvert,
    cornerType,
    cornerInvert,
    cornerTurn,
    sideType,
    sideInvert,
    sideTurn,
    red,
    green,
    blue,
    foreColor,
  }
}

interface PatchPlacement {
  x: number
  y: number
  turn: number
}

/** 3x3 の各セル配置。side は上から時計回り、corner は左上から時計回り。 */
function placements(turn: number, kind: 'side' | 'corner'): PatchPlacement[] {
  const cell = SIZE / 3
  if (kind === 'side') {
    return [
      { x: cell, y: 0, turn: turn % 4 },
      { x: cell * 2, y: cell, turn: (turn + 1) % 4 },
      { x: cell, y: cell * 2, turn: (turn + 2) % 4 },
      { x: 0, y: cell, turn: (turn + 3) % 4 },
    ]
  }
  return [
    { x: 0, y: 0, turn: turn % 4 },
    { x: cell * 2, y: 0, turn: (turn + 1) % 4 },
    { x: cell * 2, y: cell * 2, turn: (turn + 2) % 4 },
    { x: 0, y: cell * 2, turn: (turn + 3) % 4 },
  ]
}

/** 1つの patch を <rect> 背景 + 回転した <polygon> として SVG 断片に変換する。 */
function patchFragment(
  patch: number,
  turn: number,
  invert: boolean,
  foreColor: string,
  backColor: string,
  x: number,
  y: number,
): string {
  patch %= patchTypes.length
  turn %= 4
  if (patch === 15) {
    invert = !invert
  }
  const vertices = patchTypes[patch]
  const cell = SIZE / 3
  const offset = cell / 2
  const scale = cell / 4
  const cx = x + offset
  const cy = y + offset
  const points = vertices
    .map((v) => {
      const px = (v % 5) * scale - offset
      const py = Math.floor(v / 5) * scale - offset
      return `${cx + px},${cy + py}`
    })
    .join(' ')
  const bgFill = invert ? foreColor : backColor
  const fgFill = invert ? backColor : foreColor
  return [
    `  <rect x="${x}" y="${y}" width="${cell}" height="${cell}" fill="${bgFill}"/>`,
    `  <polygon points="${points}" fill="${fgFill}" transform="rotate(${turn * 90} ${cx} ${cy})"/>`,
  ].join('\n')
}

/** identicon@3.1.1 と同じ配置・配色の 150x150 SVG を返す。 */
export async function renderSvg(str: string, size: number = SIZE): Promise<string> {
  const code = await deriveCode(str)
  const foreColor = code.foreColor
  const backColor = 'rgb(255,255,255)'
  const cell = size / 3
  const lines: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`,
    `  <rect width="${size}" height="${size}" fill="${backColor}"/>`,
    patchFragment(code.middleType, 0, code.middleInvert, foreColor, backColor, cell, cell),
  ]
  for (const placement of placements(code.sideTurn, 'side')) {
    lines.push(
      patchFragment(code.sideType, placement.turn, code.sideInvert, foreColor, backColor, placement.x, placement.y),
    )
  }
  for (const placement of placements(code.cornerTurn, 'corner')) {
    lines.push(
      patchFragment(code.cornerType, placement.turn, code.cornerInvert, foreColor, backColor, placement.x, placement.y),
    )
  }
  lines.push('</svg>')
  return lines.join('\n')
}
