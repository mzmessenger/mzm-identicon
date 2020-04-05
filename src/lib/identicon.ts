import crypto from 'crypto'
import path from 'path'
import { promisify } from 'util'
import { promises as fs } from 'fs'
import * as identicon from 'identicon'
import { IDENTICON_CACHE_DIR } from '../config'

const generateAsync = promisify(identicon.generate)

export function getFileName(str: string, size: number) {
  const fileName = crypto.createHash('md5').update(`${str}\n${size}`).digest('hex')
  return `${fileName}.png`
}

export async function generate(str: string, size: number, dir?: string) {
  if (!str) {
    throw new Error('empty string')
  }

  const cacheDir = dir ? dir : IDENTICON_CACHE_DIR
  const fileName = getFileName(str, size)
  const file = path.join(cacheDir, fileName)

  try {
    const st = await fs.stat(file)
    if (!st.isFile()) {
      throw new Error('unknown file')
    }
  } catch (e) {
    const binary = await generateAsync({ id: str, size })
    const rand = (0x2000000000 + Math.random() + (Date.now() & 0x1f)).toString(32)
    const randName = `${fileName}_${rand}`
    const tmpFile = path.join(cacheDir, randName)
    await fs.writeFile(tmpFile, binary)
    await fs.rename(tmpFile, file)
    return binary
  }

  const data = await fs.readFile(file)
  return data
}
