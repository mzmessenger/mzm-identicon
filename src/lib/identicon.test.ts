jest.mock('./logger')
jest.mock('fs', () => ({
  promises: {
    writeFile: jest.fn(),
    rename: jest.fn(),
    readFile: jest.fn(),
    stat: jest.fn()
  }
}))
jest.mock('identicon', () => {
  return {
    generate: jest.fn((arg, cb) => {
      cb(null, Buffer.from('image', 'binary'))
    })
  }
})

import identiconModule from 'identicon'
import { getMockType } from '../../jest/testUtil'
import { IDENTICON_CACHE_DIR } from '../config'
import path from 'path'
import fs from 'fs'
import * as identicon from './identicon'

const writeFileMock = getMockType(fs.promises.writeFile)
const renameMock = getMockType(fs.promises.rename)
const readFileMock = getMockType(fs.promises.readFile)
const statMock = getMockType(fs.promises.stat)
const identiconGenerateMock = getMockType(identiconModule.generate)

test('identicon', async () => {
  const str = 'koh110'
  const size = 128
  const fileName = identicon.getFileName(str, size)

  writeFileMock.mockClear()
  renameMock.mockClear()
  readFileMock.mockClear()
  identiconGenerateMock.mockClear()

  const fileMock = Buffer.from('image', 'binary')

  const png = await identicon.generate(str, size)
  expect(png.toString()).toStrictEqual(fileMock.toString())

  expect(writeFileMock.mock.calls.length).toBe(1)
  expect(renameMock.mock.calls.length).toBe(1)
  expect(readFileMock.mock.calls.length).toBe(0)
  expect(identiconGenerateMock.mock.calls.length).toBe(1)

  const [, calledFileName] = renameMock.mock.calls[0]
  expect(calledFileName).toStrictEqual(path.resolve(IDENTICON_CACHE_DIR, fileName))
})

test('identicon (existFile)', async () => {
  const str = 'koh110'
  const size = 128
  const fileName = identicon.getFileName(str, size)

  writeFileMock.mockClear()
  renameMock.mockClear()
  readFileMock.mockClear()
  identiconGenerateMock.mockClear()

  statMock.mockReturnValue({ isFile: () => true })
  const fileMock = Buffer.from('image', 'binary')
  readFileMock.mockResolvedValue(fileMock)

  const png = await identicon.generate(str, size)
  expect(png.toString()).toStrictEqual(fileMock.toString())

  expect(writeFileMock.mock.calls.length).toBe(0)
  expect(renameMock.mock.calls.length).toBe(0)
  expect(readFileMock.mock.calls.length).toBe(1)
  expect(identiconGenerateMock.mock.calls.length).toBe(0)

  const [calledFileName] = readFileMock.mock.calls[0]
  expect(calledFileName).toStrictEqual(path.resolve(IDENTICON_CACHE_DIR, fileName))
})
