import path from 'path'

export const PORT = process.env.PORT || 3000

export const IDENTICON_CACHE_DIR = process.env.IDENTICON_CACHE_DIR
  ? process.env.IDENTICON_CACHE_DIR
  : path.resolve(__dirname, '../cache')
