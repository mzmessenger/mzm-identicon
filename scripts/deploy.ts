#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir as systemTempDirectory } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject
type JsonObject = { [key: string]: JsonValue }
type EntryType = 'file' | 'directory'

type FileIdentity = {
  device: number
  inode: number
  owner: number
  type: EntryType
}

type TreeEntry = {
  path: string
  identity: FileIdentity
}

type PrivateConfig = {
  rootPath: string
  rootIdentity: FileIdentity
  configPath: string
  configIdentity: FileIdentity
  configHash: string
  outputPath: string
  outputIdentity: FileIdentity
  tmpPath: string
  tmpIdentity: FileIdentity
}

type CommandResult = {
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  timedOut: boolean
  outputOverflow: boolean
  terminationConfirmed: boolean
  launchError: Error | null
}

type DeploymentInterruption = {
  signal: AbortSignal
  receivedSignal: () => NodeJS.Signals | null
  dispose: () => void
}

const EXPECTED_WORKER = 'mzm-identicon'
const CONFIG_FILE = 'wrangler.jsonc'
const OUTPUT_FILE = 'wrangler-output.jsonl'
const RELEASE_VARIABLE = 'MZM_IDENTICON_RELEASE_SHA'
const EXPECTED_ZONE = 'mzm.dev'
const EXPECTED_HOSTNAME = 'identicon.mzm.dev'
const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4'
const CLOUDFLARE_API_ORIGIN = new URL(CLOUDFLARE_API_BASE).origin
const MAX_OUTPUT_BYTES = 1_000_000
const CLOUDFLARE_PAGE_SIZE = 50
const VERSION_TIMEOUT_MS = 30_000
const PREFLIGHT_TIMEOUT_MS = 15_000
const DEPLOY_TIMEOUT_MS = 600_000
const TERMINATION_GRACE_MS = 2_000
const TERMINATION_CONFIRM_TIMEOUT_MS = 8_000
const SCRIPT_PATH = fileURLToPath(import.meta.url)
const REPOSITORY_ROOT = realpathSync(resolve(dirname(SCRIPT_PATH), '..'))

function fail(message: string): never {
  throw new Error(message)
}

function isObject(value: JsonValue | unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isWithin(parentPath: string, targetPath: string): boolean {
  const relativePath = relative(parentPath, targetPath)
  return (
    relativePath === '' ||
    (relativePath !== '..' &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath))
  )
}

class StrictJsoncParser {
  private position = 0
  private readonly source: string

  constructor(source: string) {
    this.source = source
  }

  parse(): JsonValue {
    this.skipTrivia()
    const value = this.parseValue()
    this.skipTrivia()
    if (this.position !== this.source.length) {
      fail(`unexpected JSONC content at offset ${this.position}`)
    }
    return value
  }

  private skipTrivia(): void {
    while (this.position < this.source.length) {
      const character = this.source[this.position]
      if (
        character === ' ' ||
        character === '\t' ||
        character === '\r' ||
        character === '\n'
      ) {
        this.position += 1
        continue
      }
      if (character !== '/') {
        return
      }
      const nextCharacter = this.source[this.position + 1]
      if (nextCharacter === '/') {
        this.position += 2
        while (
          this.position < this.source.length &&
          this.source[this.position] !== '\n' &&
          this.source[this.position] !== '\r'
        ) {
          this.position += 1
        }
        continue
      }
      if (nextCharacter === '*') {
        const commentEnd = this.source.indexOf('*/', this.position + 2)
        if (commentEnd === -1) {
          fail(`unterminated JSONC block comment at offset ${this.position}`)
        }
        this.position = commentEnd + 2
        continue
      }
      return
    }
  }

  private parseValue(): JsonValue {
    this.skipTrivia()
    const character = this.source[this.position]
    if (character === '{') {
      return this.parseObject()
    }
    if (character === '[') {
      return this.parseArray()
    }
    if (character === '"') {
      return this.parseString()
    }
    if (character === 't' && this.source.startsWith('true', this.position)) {
      this.position += 4
      return true
    }
    if (character === 'f' && this.source.startsWith('false', this.position)) {
      this.position += 5
      return false
    }
    if (character === 'n' && this.source.startsWith('null', this.position)) {
      this.position += 4
      return null
    }
    const numberMatch = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
      this.source.slice(this.position)
    )
    if (numberMatch) {
      this.position += numberMatch[0].length
      const number = Number(numberMatch[0])
      if (!Number.isFinite(number)) {
        fail(`non-finite JSON number at offset ${this.position}`)
      }
      return number
    }
    fail(`expected a JSON value at offset ${this.position}`)
  }

  private parseString(): string {
    const start = this.position
    this.position += 1
    while (this.position < this.source.length) {
      const code = this.source.charCodeAt(this.position)
      const character = this.source[this.position]
      if (character === '"') {
        this.position += 1
        return JSON.parse(this.source.slice(start, this.position)) as string
      }
      if (character === '\\') {
        this.position += 2
        continue
      }
      if (code <= 0x1f) {
        fail(
          `unescaped control character in JSON string at offset ${this.position}`
        )
      }
      this.position += 1
    }
    fail(`unterminated JSON string at offset ${start}`)
  }

  private parseObject(): JsonObject {
    this.position += 1
    this.skipTrivia()
    const result: JsonObject = Object.create(null) as JsonObject
    const keys = new Set<string>()
    if (this.source[this.position] === '}') {
      this.position += 1
      return result
    }
    while (this.position < this.source.length) {
      this.skipTrivia()
      if (this.source[this.position] !== '"') {
        fail(`expected a quoted object key at offset ${this.position}`)
      }
      const key = this.parseString()
      if (keys.has(key)) {
        fail(`duplicate key ${JSON.stringify(key)} at offset ${this.position}`)
      }
      keys.add(key)
      this.skipTrivia()
      if (this.source[this.position] !== ':') {
        fail(`expected ':' after object key at offset ${this.position}`)
      }
      this.position += 1
      const value = this.parseValue()
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        value,
        writable: true
      })
      this.skipTrivia()
      if (this.source[this.position] === '}') {
        this.position += 1
        return result
      }
      if (this.source[this.position] !== ',') {
        fail(`expected ',' or '}' at offset ${this.position}`)
      }
      this.position += 1
      this.skipTrivia()
      if (this.source[this.position] === '}') {
        this.position += 1
        return result
      }
    }
    fail(`unterminated JSON object at offset ${this.position}`)
  }

  private parseArray(): JsonValue[] {
    this.position += 1
    this.skipTrivia()
    const result: JsonValue[] = []
    if (this.source[this.position] === ']') {
      this.position += 1
      return result
    }
    while (this.position < this.source.length) {
      result.push(this.parseValue())
      this.skipTrivia()
      if (this.source[this.position] === ']') {
        this.position += 1
        return result
      }
      if (this.source[this.position] !== ',') {
        fail(`expected ',' or ']' at offset ${this.position}`)
      }
      this.position += 1
      this.skipTrivia()
      if (this.source[this.position] === ']') {
        this.position += 1
        return result
      }
    }
    fail(`unterminated JSON array at offset ${this.position}`)
  }
}

export function parseStrictJsonc(source: string): JsonValue {
  const normalized = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source
  return new StrictJsoncParser(normalized).parse()
}

function resolveRepositoryPath(
  repositoryRoot: string,
  configuredPath: string,
  expectedType: EntryType,
  fieldName: string
): string {
  const candidatePath = resolve(repositoryRoot, configuredPath)
  if (!isWithin(repositoryRoot, candidatePath)) {
    fail(`${fieldName} resolves outside the release repository`)
  }
  const canonicalPath = realpathSync(candidatePath)
  if (
    !isWithin(repositoryRoot, canonicalPath) ||
    canonicalPath !== candidatePath
  ) {
    fail(`${fieldName} escapes the release repository or traverses a symlink`)
  }
  const stats = lstatSync(canonicalPath)
  if (stats.isSymbolicLink()) {
    fail(`${fieldName} must not be a symlink`)
  }
  if (expectedType === 'file' ? !stats.isFile() : !stats.isDirectory()) {
    fail(`${fieldName} must resolve to a regular ${expectedType}`)
  }
  return canonicalPath
}

export function assertExposureReadback(
  workersDev: string | undefined,
  previewUrls: string | undefined
): void {
  if (workersDev !== 'false' || previewUrls !== 'false') {
    fail(
      'fresh Cloudflare preflight must confirm workers.dev and preview URLs are both disabled'
    )
  }
}

function assertNoNestedRouteKeys(value: JsonValue, currentPath: string): void {
  if (Array.isArray(value)) {
    value.forEach((child, index) =>
      assertNoNestedRouteKeys(child, `${currentPath}[${index}]`)
    )
    return
  }
  if (!isObject(value)) {
    return
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === 'route' || key === 'routes') {
      fail(
        `nested route key ${JSON.stringify(`${currentPath}.${key}`)} is not allowed`
      )
    }
    assertNoNestedRouteKeys(child, `${currentPath}.${key}`)
  }
}

export function buildRouteFreeConfig(
  configText: string,
  accountId: string,
  repositoryRoot: string
): JsonObject {
  if (!/^[a-f0-9]{32}$/.test(accountId)) {
    fail('CLOUDFLARE_ACCOUNT_ID must be 32 lowercase hexadecimal characters')
  }
  const canonicalRoot = realpathSync(repositoryRoot)
  const parsed = parseStrictJsonc(configText)
  if (!isObject(parsed)) {
    fail('wrangler.jsonc must contain a JSON object')
  }
  if (parsed.name !== EXPECTED_WORKER) {
    fail(`wrangler.jsonc must target the expected Worker ${EXPECTED_WORKER}`)
  }
  if (parsed.account_id !== undefined && parsed.account_id !== accountId) {
    fail('CLOUDFLARE_ACCOUNT_ID does not match wrangler.jsonc account_id')
  }
  const config: JsonObject = { ...parsed }
  delete config.route
  delete config.routes
  assertNoNestedRouteKeys(config, '$')

  if (typeof config.main !== 'string') {
    fail('wrangler.jsonc main must be a path string')
  }
  config.main = resolveRepositoryPath(
    canonicalRoot,
    config.main,
    'file',
    'main'
  )

  if (typeof config.$schema === 'string') {
    config.$schema = resolveRepositoryPath(
      canonicalRoot,
      'node_modules/wrangler/config-schema.json',
      'file',
      '$schema'
    )
  }
  if (isObject(config.assets) && typeof config.assets.directory === 'string') {
    config.assets.directory = resolveRepositoryPath(
      canonicalRoot,
      config.assets.directory,
      'directory',
      'assets.directory'
    )
  }
  if (Array.isArray(config.d1_databases)) {
    for (const [index, binding] of config.d1_databases.entries()) {
      if (isObject(binding) && typeof binding.migrations_dir === 'string') {
        binding.migrations_dir = resolveRepositoryPath(
          canonicalRoot,
          binding.migrations_dir,
          'directory',
          `d1_databases[${index}].migrations_dir`
        )
      }
    }
  }

  config.account_id = accountId
  config.workers_dev = false
  config.preview_urls = false
  return config
}

function currentUid(): number {
  if (typeof process.getuid !== 'function') {
    fail('deployment wrapper requires POSIX filesystem ownership checks')
  }
  return process.getuid()
}

function createDeploymentInterruption(): DeploymentInterruption {
  const controller = new AbortController()
  let received: NodeJS.Signals | null = null
  const interrupt = (signal: NodeJS.Signals): void => {
    if (received !== null) return
    received = signal
    controller.abort(signal)
  }
  const onSigint = (): void => interrupt('SIGINT')
  const onSigterm = (): void => interrupt('SIGTERM')
  process.on('SIGINT', onSigint)
  process.on('SIGTERM', onSigterm)
  return {
    signal: controller.signal,
    receivedSignal: () => received,
    dispose: () => {
      process.off('SIGINT', onSigint)
      process.off('SIGTERM', onSigterm)
    }
  }
}

function assertNotInterrupted(
  interruption: DeploymentInterruption,
  phase: string
): void {
  if (interruption.signal.aborted) {
    fail(
      `${phase} interrupted by ${interruption.receivedSignal() ?? 'external signal'}`
    )
  }
}

function identityFor(path: string, expectedType: EntryType): FileIdentity {
  const stats = lstatSync(path)
  if (stats.isSymbolicLink()) {
    fail(`refusing symlink in private deploy tree: ${path}`)
  }
  if (expectedType === 'file' ? !stats.isFile() : !stats.isDirectory()) {
    fail(`unexpected filesystem entry type in private deploy tree: ${path}`)
  }
  if (stats.uid !== currentUid()) {
    fail(`private deploy artifact is not owned by the current user: ${path}`)
  }
  return {
    device: stats.dev,
    inode: stats.ino,
    owner: stats.uid,
    type: expectedType
  }
}

function assertIdentity(path: string, identity: FileIdentity): void {
  const actual = identityFor(path, identity.type)
  if (
    actual.device !== identity.device ||
    actual.inode !== identity.inode ||
    actual.owner !== identity.owner
  ) {
    fail(`private deploy artifact identity changed: ${path}`)
  }
}

function createPrivateConfig(configText: string): PrivateConfig {
  const tempParent = resolve(process.env.TMPDIR || systemTempDirectory())
  const parentStats = lstatSync(tempParent)
  const privateParent = (parentStats.mode & 0o022) === 0
  const trustedStickyParent =
    (parentStats.mode & 0o1000) !== 0 &&
    (parentStats.mode & 0o002) !== 0 &&
    (parentStats.uid === 0 || parentStats.uid === currentUid())
  if (
    parentStats.isSymbolicLink() ||
    !parentStats.isDirectory() ||
    (!privateParent && !trustedStickyParent) ||
    realpathSync(tempParent) !== tempParent
  ) {
    fail(
      'TMPDIR must be canonical, private, or a trusted sticky temporary directory'
    )
  }
  if (typeof constants.O_NOFOLLOW !== 'number') {
    fail(
      'this platform does not provide O_NOFOLLOW for private config creation'
    )
  }
  const rootPath = mkdtempSync(join(tempParent, 'mzm-identicon-deploy-'))
  chmodSync(rootPath, 0o700)
  const rootIdentity = identityFor(rootPath, 'directory')
  if (
    (lstatSync(rootPath).mode & 0o777) !== 0o700 ||
    realpathSync(rootPath) !== rootPath
  ) {
    fail('private deploy directory permissions or identity are invalid')
  }
  const tmpPath = join(rootPath, 'tmp')
  const configPath = join(rootPath, CONFIG_FILE)
  const outputPath = join(rootPath, OUTPUT_FILE)
  let configIdentity: FileIdentity | undefined
  let outputIdentity: FileIdentity | undefined
  try {
    mkdirSync(tmpPath, { mode: 0o700 })
    chmodSync(tmpPath, 0o700)
    const tmpIdentity = identityFor(tmpPath, 'directory')
    const flags =
      constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW
    const descriptor = openSync(configPath, flags, 0o600)
    let configHash: string
    try {
      const stats = fstatSync(descriptor)
      if (!stats.isFile() || stats.nlink !== 1 || stats.uid !== currentUid()) {
        fail('private Wrangler config file identity is invalid')
      }
      configIdentity = {
        device: stats.dev,
        inode: stats.ino,
        owner: stats.uid,
        type: 'file'
      }
      writeFileSync(descriptor, configText, { encoding: 'utf8' })
      configHash = createHash('sha256').update(configText, 'utf8').digest('hex')
    } finally {
      closeSync(descriptor)
    }
    if ((lstatSync(configPath).mode & 0o777) !== 0o600) {
      fail('private Wrangler config file permissions are not 0600')
    }
    const outputFlags =
      constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW
    const outputDescriptor = openSync(outputPath, outputFlags, 0o600)
    try {
      const outputStats = fstatSync(outputDescriptor)
      if (
        !outputStats.isFile() ||
        outputStats.nlink !== 1 ||
        outputStats.uid !== currentUid()
      ) {
        fail('private Wrangler output file identity is invalid')
      }
      outputIdentity = {
        device: outputStats.dev,
        inode: outputStats.ino,
        owner: outputStats.uid,
        type: 'file'
      }
    } finally {
      closeSync(outputDescriptor)
    }
    if ((lstatSync(outputPath).mode & 0o777) !== 0o600) {
      fail('private Wrangler output file permissions are not 0600')
    }
    return {
      rootPath,
      rootIdentity,
      configPath,
      configIdentity,
      configHash,
      outputPath,
      outputIdentity,
      tmpPath,
      tmpIdentity
    }
  } catch (error) {
    try {
      cleanupPrivateTree(
        rootPath,
        rootIdentity,
        configIdentity,
        undefined,
        outputIdentity
      )
    } catch (cleanupError) {
      const cleanupMessage =
        cleanupError instanceof Error ? cleanupError.message : 'cleanup failed'
      fail(
        `${error instanceof Error ? error.message : 'private config creation failed'}; ` +
          `private directory retained at ${rootPath}: ${cleanupMessage}`
      )
    }
    throw error
  }
}

function validateTreeEntry(path: string, rootPath: string): FileIdentity {
  const stats = lstatSync(path)
  if (stats.isSymbolicLink() || (!stats.isFile() && !stats.isDirectory())) {
    fail(`unexpected symlink or special file in private deploy tree: ${path}`)
  }
  if (stats.uid !== currentUid()) {
    fail(
      `private deploy tree contains a file not owned by the current user: ${path}`
    )
  }
  const canonicalPath = realpathSync(path)
  if (!isWithin(rootPath, canonicalPath) || canonicalPath !== path) {
    fail(`private deploy tree entry escapes its recorded root: ${path}`)
  }
  if (stats.isFile() && stats.nlink !== 1) {
    fail(`refusing hard-linked private deploy artifact: ${path}`)
  }
  if (stats.isDirectory() && (stats.mode & 0o022) !== 0) {
    fail(`private deploy directory is group/world writable: ${path}`)
  }
  return {
    device: stats.dev,
    inode: stats.ino,
    owner: stats.uid,
    type: stats.isFile() ? 'file' : 'directory'
  }
}

function inventoryTree(
  path: string,
  rootPath: string,
  entries: TreeEntry[]
): void {
  const identity = validateTreeEntry(path, rootPath)
  if (identity.type === 'directory') {
    for (const name of readdirSync(path)) {
      inventoryTree(join(path, name), rootPath, entries)
    }
  }
  entries.push({ path, identity })
}

function cleanupPrivateTree(
  rootPath: string,
  rootIdentity: FileIdentity,
  expectedConfigIdentity?: FileIdentity,
  expectedConfigHash?: string,
  expectedOutputIdentity?: FileIdentity
): void {
  assertIdentity(rootPath, rootIdentity)
  const configPath = join(rootPath, CONFIG_FILE)
  const outputPath = join(rootPath, OUTPUT_FILE)
  const allowedTopLevel = new Set([
    CONFIG_FILE,
    OUTPUT_FILE,
    'tmp',
    '.wrangler'
  ])
  const names = readdirSync(rootPath)
  if (names.some((name) => !allowedTopLevel.has(name))) {
    fail('private deploy directory contains an unexpected sibling')
  }
  const hasConfig = names.includes(CONFIG_FILE)
  const hasOutput = names.includes(OUTPUT_FILE)
  if (hasConfig !== (expectedConfigIdentity !== undefined)) {
    fail(
      'private Wrangler config presence does not match the recorded creation state'
    )
  }
  if (hasOutput !== (expectedOutputIdentity !== undefined)) {
    fail(
      'private Wrangler output presence does not match the recorded creation state'
    )
  }
  if (expectedConfigIdentity) {
    assertIdentity(configPath, expectedConfigIdentity)
    const configStats = lstatSync(configPath)
    if (
      (configStats.mode & 0o777) !== 0o600 ||
      (expectedConfigHash !== undefined &&
        createHash('sha256').update(readFileSync(configPath)).digest('hex') !==
          expectedConfigHash)
    ) {
      fail(
        'private Wrangler config changed while the deployment command was running'
      )
    }
  }
  if (expectedOutputIdentity) {
    assertIdentity(outputPath, expectedOutputIdentity)
    if ((lstatSync(outputPath).mode & 0o777) !== 0o600) {
      fail('private Wrangler output permissions changed')
    }
  }
  const entries: TreeEntry[] = []
  for (const name of names) {
    inventoryTree(join(rootPath, name), rootPath, entries)
  }
  if (expectedConfigIdentity) {
    const expectedConfig = entries.find((entry) => entry.path === configPath)
    if (
      !expectedConfig ||
      expectedConfig.identity.device !== expectedConfigIdentity.device ||
      expectedConfig.identity.inode !== expectedConfigIdentity.inode
    ) {
      fail('private Wrangler config identity changed before cleanup')
    }
  }
  if (expectedOutputIdentity) {
    const expectedOutput = entries.find((entry) => entry.path === outputPath)
    if (
      !expectedOutput ||
      expectedOutput.identity.device !== expectedOutputIdentity.device ||
      expectedOutput.identity.inode !== expectedOutputIdentity.inode
    ) {
      fail('private Wrangler output identity changed before cleanup')
    }
  }
  assertIdentity(rootPath, rootIdentity)
  for (const entry of entries) {
    assertIdentity(entry.path, entry.identity)
    if (entry.identity.type === 'file') {
      unlinkSync(entry.path)
    } else {
      rmdirSync(entry.path)
    }
  }
  assertIdentity(rootPath, rootIdentity)
  if (readdirSync(rootPath).length !== 0) {
    fail('private deploy directory was not empty after cleanup')
  }
  rmdirSync(rootPath)
}

function cleanupPrivateConfig(privateConfig: PrivateConfig): void {
  assertIdentity(privateConfig.tmpPath, privateConfig.tmpIdentity)
  cleanupPrivateTree(
    privateConfig.rootPath,
    privateConfig.rootIdentity,
    privateConfig.configIdentity,
    privateConfig.configHash,
    privateConfig.outputIdentity
  )
}

function decodeOutput(chunks: Buffer[]): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
}

const SAFE_CHILD_ENVIRONMENT_KEYS = [
  'HOME',
  'PATH',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TERM',
  'NO_COLOR',
  'FORCE_COLOR',
  'SYSTEMROOT',
  'WINDIR'
]

function safeBaseEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  for (const key of SAFE_CHILD_ENVIRONMENT_KEYS) {
    const value = source[key]
    if (value !== undefined) environment[key] = value
  }
  return environment
}

export function buildWranglerEnvironment(
  source: NodeJS.ProcessEnv,
  accountId: string,
  apiToken: string | undefined,
  tmpPath: string,
  outputPath: string
): NodeJS.ProcessEnv {
  const environment = safeBaseEnvironment(source)
  environment.CLOUDFLARE_ACCOUNT_ID = accountId
  if (apiToken) environment.CLOUDFLARE_API_TOKEN = apiToken
  environment.TMPDIR = tmpPath
  environment.WRANGLER_OUTPUT_FILE_PATH = outputPath
  environment.WRANGLER_SEND_METRICS = 'false'
  environment.CI = 'true'
  return environment
}

async function runWrangler(
  binaryPath: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  interruption?: DeploymentInterruption,
  onUnconfirmedTermination?: () => void
): Promise<CommandResult> {
  return runCommand(
    process.execPath,
    [binaryPath, ...args],
    env,
    timeoutMs,
    interruption,
    onUnconfirmedTermination
  )
}

async function runCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  interruption?: DeploymentInterruption,
  onUnconfirmedTermination?: () => void
): Promise<CommandResult> {
  if (process.platform === 'win32') {
    fail(
      'deployment wrapper requires POSIX process-group termination semantics'
    )
  }
  if (interruption) assertNotInterrupted(interruption, 'subprocess launch')
  let timedOut = false
  let outputOverflow = false
  let terminationConfirmed = true
  let launchError: Error | null = null
  let externalSignal: NodeJS.Signals | null = null
  let totalOutputBytes = 0
  let escalationTimer: NodeJS.Timeout | undefined
  let confirmationTimer: NodeJS.Timeout | undefined
  let timeoutTimer: NodeJS.Timeout | undefined
  let terminationStarted = false
  let finished = false
  let finalize: ((result: CommandResult) => void) | undefined
  const stdoutChunks: Buffer[] = []
  const stderrChunks: Buffer[] = []
  let abortListener: (() => void) | undefined

  const previousUmask = process.umask(0o077)
  let child: ReturnType<typeof spawn>
  try {
    child = spawn(command, args, {
      cwd: REPOSITORY_ROOT,
      detached: true,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } finally {
    process.umask(previousUmask)
  }
  const closePromise = new Promise<CommandResult>((resolvePromise) => {
    finalize = resolvePromise
  })

  const clearRunState = (): void => {
    if (timeoutTimer) clearTimeout(timeoutTimer)
    if (escalationTimer) clearTimeout(escalationTimer)
    if (confirmationTimer) clearTimeout(confirmationTimer)
    if (abortListener && interruption) {
      interruption.signal.removeEventListener('abort', abortListener)
    }
  }
  const finish = (result: CommandResult): void => {
    if (finished) return
    finished = true
    clearRunState()
    if (!result.terminationConfirmed) onUnconfirmedTermination?.()
    finalize?.(result)
  }
  const processGroupExists = (): boolean => {
    if (child.pid === undefined) return false
    try {
      process.kill(-child.pid, 0)
      return true
    } catch (error) {
      return !(
        error instanceof Error &&
        'code' in error &&
        error.code === 'ESRCH'
      )
    }
  }
  const stopProcessGroup = (signal: NodeJS.Signals): boolean => {
    if (child.pid === undefined) return false
    try {
      process.kill(-child.pid, signal)
      return true
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ESRCH')
        return true
      return false
    }
  }
  let groupExitPromise: Promise<boolean> | undefined
  const confirmProcessGroupExit = (): Promise<boolean> => {
    if (groupExitPromise) return groupExitPromise
    groupExitPromise = (async () => {
      if (!processGroupExists()) return true
      stopProcessGroup('SIGTERM')
      await new Promise((resolvePromise) =>
        setTimeout(resolvePromise, TERMINATION_GRACE_MS)
      )
      if (!processGroupExists()) return true
      stopProcessGroup('SIGKILL')
      const deadline = Date.now() + TERMINATION_CONFIRM_TIMEOUT_MS
      while (Date.now() < deadline) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
        if (!processGroupExists()) return true
      }
      return !processGroupExists()
    })()
    return groupExitPromise
  }
  const completeAfterClose = async (
    exitCode: number | null,
    signal: NodeJS.Signals | null
  ) => {
    const groupExited = await confirmProcessGroupExit()
    terminationConfirmed = terminationConfirmed && groupExited
    let stdout = ''
    let stderr = ''
    try {
      stdout = decodeOutput(stdoutChunks)
      stderr = decodeOutput(stderrChunks)
    } catch (error) {
      launchError =
        error instanceof Error
          ? error
          : new Error('subprocess output was not valid UTF-8')
    }
    if (externalSignal && !launchError) {
      launchError = new Error(`interrupted by ${externalSignal}`)
    }
    finish({
      exitCode,
      signal,
      stdout,
      stderr,
      timedOut,
      outputOverflow,
      terminationConfirmed,
      launchError
    })
  }
  const requestTermination = (
    reason: 'timeout' | 'output-limit' | 'signal',
    signal: NodeJS.Signals = 'SIGTERM'
  ): void => {
    if (reason === 'signal') externalSignal = signal
    if (terminationStarted) {
      if (reason === 'signal' && !stopProcessGroup('SIGKILL'))
        terminationConfirmed = false
      return
    }
    terminationStarted = true
    timedOut = reason === 'timeout'
    outputOverflow = reason === 'output-limit'
    if (!stopProcessGroup(reason === 'signal' ? signal : 'SIGTERM')) {
      terminationConfirmed = false
    }
    escalationTimer = setTimeout(() => {
      if (!stopProcessGroup('SIGKILL')) terminationConfirmed = false
    }, TERMINATION_GRACE_MS)
    confirmationTimer = setTimeout(() => {
      terminationConfirmed = false
      if (externalSignal && !launchError) {
        launchError = new Error(`interrupted by ${externalSignal}`)
      }
      finish({
        exitCode: null,
        signal: externalSignal,
        stdout: '',
        stderr: '',
        timedOut,
        outputOverflow,
        terminationConfirmed,
        launchError
      })
    }, TERMINATION_GRACE_MS + TERMINATION_CONFIRM_TIMEOUT_MS)
  }
  if (interruption) {
    abortListener = () => {
      requestTermination('signal', interruption.receivedSignal() ?? 'SIGTERM')
    }
    interruption.signal.addEventListener('abort', abortListener, { once: true })
  }

  const capture = (target: Buffer[], chunk: Buffer): void => {
    if (terminationStarted) return
    if (totalOutputBytes + chunk.length > MAX_OUTPUT_BYTES) {
      const remaining = Math.max(0, MAX_OUTPUT_BYTES - totalOutputBytes)
      if (remaining > 0) {
        target.push(chunk.subarray(0, remaining))
        totalOutputBytes += remaining
      }
      requestTermination('output-limit')
      return
    }
    target.push(chunk)
    totalOutputBytes += chunk.length
  }
  child.stdout?.on('data', (chunk: Buffer) => capture(stdoutChunks, chunk))
  child.stderr?.on('data', (chunk: Buffer) => capture(stderrChunks, chunk))
  child.on('error', (error) => {
    launchError = error
  })
  child.on('close', (exitCode, signal) => {
    if (timeoutTimer) clearTimeout(timeoutTimer)
    if (escalationTimer) clearTimeout(escalationTimer)
    if (confirmationTimer) clearTimeout(confirmationTimer)
    void completeAfterClose(exitCode, signal)
  })
  timeoutTimer = setTimeout(() => requestTermination('timeout'), timeoutMs)
  return closePromise
}

function readJsonObject(path: string): JsonObject {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!isObject(parsed)) {
    fail(`${path} must contain a JSON object`)
  }
  return parsed
}

async function readGitOutput(
  args: string[],
  interruption?: DeploymentInterruption,
  onUnconfirmedTermination?: () => void
): Promise<string> {
  const environment = safeBaseEnvironment(process.env)
  environment.GIT_TERMINAL_PROMPT = '0'
  const result = await runCommand(
    'git',
    args,
    environment,
    30_000,
    interruption,
    onUnconfirmedTermination
  )
  return assertCommandSucceeded(result, `git ${args[0]}`).trim()
}

export function assertTrackedWorktreeMatchesIndex(
  repositoryRoot: string,
  indexOutput: string,
  indexFlagsOutput: string
): void {
  const root = realpathSync(repositoryRoot)
  const entries = indexOutput.split('\0').filter((entry) => entry.length > 0)
  const flags = indexFlagsOutput.split('\0').filter((entry) => entry.length > 0)
  const files = new Map<string, { mode: string; blobId: string }>()
  for (const entry of entries) {
    const tab = entry.indexOf('\t')
    if (tab < 0) fail('Git index returned a malformed tracked-file record')
    const [mode, blobId, stage] = entry.slice(0, tab).split(' ')
    const path = entry.slice(tab + 1)
    if (
      !['100644', '100755'].includes(mode) ||
      !/^[a-f0-9]{40}$/.test(blobId) ||
      stage !== '0' ||
      path.length === 0 ||
      files.has(path)
    ) {
      fail(
        'release index contains an unsupported, unmerged, or duplicate tracked file'
      )
    }
    files.set(path, { mode, blobId })
  }
  const flagPaths = new Set<string>()
  for (const entry of flags) {
    if (entry.length < 3 || entry[1] !== ' ') {
      fail('Git index returned a malformed index-flag record')
    }
    const flag = entry[0]
    const path = entry.slice(2)
    if (flag !== 'H' || flagPaths.has(path)) {
      fail(
        'release index uses assume-unchanged, skip-worktree, or a nonstandard index flag'
      )
    }
    flagPaths.add(path)
  }
  if (
    flagPaths.size !== files.size ||
    [...files.keys()].some((path) => !flagPaths.has(path))
  ) {
    fail('Git index entries and index-flag records do not match')
  }
  for (const [path, entry] of files) {
    const absolutePath = resolve(root, path)
    if (
      !isWithin(root, absolutePath) ||
      realpathSync(absolutePath) !== absolutePath
    ) {
      fail(`tracked release file escapes or traverses a symlink: ${path}`)
    }
    const stats = lstatSync(absolutePath)
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
      fail(`tracked release path is not a single-link regular file: ${path}`)
    }
    const executable = (stats.mode & 0o111) !== 0
    if (executable !== (entry.mode === '100755')) {
      fail(`tracked release file mode differs from the Git index: ${path}`)
    }
    const content = readFileSync(absolutePath)
    const actualBlobId = createHash('sha1')
      .update(`blob ${content.length}\0`, 'utf8')
      .update(content)
      .digest('hex')
    if (actualBlobId !== entry.blobId) {
      fail(
        `tracked release file content differs from its indexed blob: ${path}`
      )
    }
  }
}

async function releaseCheckout(
  interruption?: DeploymentInterruption,
  onUnconfirmedTermination?: () => void
): Promise<{ branch: string; sha: string }> {
  const gitRoot = await readGitOutput(
    ['rev-parse', '--show-toplevel'],
    interruption,
    onUnconfirmedTermination
  )
  if (realpathSync(gitRoot) !== REPOSITORY_ROOT) {
    fail('deploy wrapper is not running at the repository root')
  }
  const branch = await readGitOutput(
    ['branch', '--show-current'],
    interruption,
    onUnconfirmedTermination
  )
  if (!branch.startsWith('verify/')) {
    fail('production release commands must run from a verify/<release> branch')
  }
  const sha = await readGitOutput(
    ['rev-parse', 'HEAD'],
    interruption,
    onUnconfirmedTermination
  )
  if (!/^[a-f0-9]{40}$/.test(sha)) {
    fail('release HEAD is not a full lowercase commit SHA')
  }
  const cachedDiff = await readGitOutput(
    ['diff', '--cached', '--quiet', 'HEAD', '--'],
    interruption,
    onUnconfirmedTermination
  )
  if (cachedDiff !== '') {
    fail('release index differs from HEAD')
  }
  const trackedFiles = await readGitOutput(
    ['ls-files', '--stage', '-z'],
    interruption,
    onUnconfirmedTermination
  )
  const indexFlags = await readGitOutput(
    ['ls-files', '-v', '-z'],
    interruption,
    onUnconfirmedTermination
  )
  assertTrackedWorktreeMatchesIndex(REPOSITORY_ROOT, trackedFiles, indexFlags)
  const status = await readGitOutput(
    [
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.untrackedCache=false',
      'status',
      '--porcelain=v1',
      '--untracked-files=all'
    ],
    interruption,
    onUnconfirmedTermination
  )
  if (status !== '') {
    fail('deploy wrapper refuses a dirty or untracked worktree')
  }
  return { branch, sha }
}

function resolveWranglerBinary(): {
  binaryPath: string
  expectedVersion: string
} {
  const packageJson = readJsonObject(join(REPOSITORY_ROOT, 'package.json'))
  const lockJson = readJsonObject(join(REPOSITORY_ROOT, 'package-lock.json'))
  const devDependencies = packageJson.devDependencies
  if (
    !isObject(devDependencies) ||
    typeof devDependencies.wrangler !== 'string'
  ) {
    fail('package.json must pin Wrangler as a direct development dependency')
  }
  const expectedVersion = devDependencies.wrangler
  if (!/^\d+\.\d+\.\d+$/.test(expectedVersion)) {
    fail('Wrangler must be pinned to an exact semantic version')
  }
  const lockPackages = lockJson.packages
  if (!isObject(lockPackages) || !isObject(lockPackages[''])) {
    fail('package-lock.json is missing its root package record')
  }
  const lockDependencies = lockPackages[''].devDependencies
  if (
    !isObject(lockDependencies) ||
    lockDependencies.wrangler !== expectedVersion
  ) {
    fail(
      'package.json and package-lock.json do not pin the same Wrangler version'
    )
  }
  const lexicalPath = join(REPOSITORY_ROOT, 'node_modules/.bin/wrangler')
  const binaryPath = realpathSync(lexicalPath)
  if (!isWithin(REPOSITORY_ROOT, binaryPath)) {
    fail(
      'repository-local Wrangler binary resolves outside the release worktree'
    )
  }
  const binaryStats = statSync(binaryPath)
  if (!binaryStats.isFile()) {
    fail('repository-local Wrangler binary is not a regular file')
  }
  accessSync(binaryPath, constants.X_OK)
  return { binaryPath, expectedVersion }
}

function formatCommandFailure(result: CommandResult): string {
  const details = [
    result.launchError ? `launch error: ${result.launchError.message}` : '',
    result.timedOut ? 'subprocess timed out' : '',
    result.outputOverflow ? 'subprocess output exceeded the limit' : '',
    !result.terminationConfirmed
      ? 'process-group termination was not confirmed'
      : '',
    `exit=${result.exitCode ?? 'null'} signal=${result.signal ?? 'none'}`,
    result.stdout.length > 0
      ? `stdout bytes=${Buffer.byteLength(result.stdout)} (omitted)`
      : '',
    result.stderr.length > 0
      ? `stderr bytes=${Buffer.byteLength(result.stderr)} (omitted)`
      : ''
  ].filter(Boolean)
  return details.join('\n')
}

function assertCommandSucceeded(result: CommandResult, label: string): string {
  if (
    result.launchError ||
    result.timedOut ||
    result.outputOverflow ||
    !result.terminationConfirmed ||
    result.exitCode !== 0
  ) {
    fail(`${label} failed:\n${formatCommandFailure(result)}`)
  }
  return result.stdout.trim()
}

function temporaryConfigText(accountId: string): string {
  const checkedInConfig = readFileSync(join(REPOSITORY_ROOT, CONFIG_FILE))
  const configText = new TextDecoder('utf-8', { fatal: true }).decode(
    checkedInConfig
  )
  const config = buildRouteFreeConfig(configText, accountId, REPOSITORY_ROOT)
  return `${JSON.stringify(config, null, 2)}\n`
}

function readStructuredOutput(privateConfig: PrivateConfig): JsonObject[] {
  assertIdentity(privateConfig.outputPath, privateConfig.outputIdentity)
  const stats = lstatSync(privateConfig.outputPath)
  if (stats.size === 0 || stats.size > 256 * 1024) {
    fail('Wrangler structured output is empty or exceeds the accepted size')
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(
    readFileSync(privateConfig.outputPath)
  )
  return parseStructuredOutput(text)
}

export function parseStructuredOutput(text: string): JsonObject[] {
  if (!text.endsWith('\n')) {
    fail('Wrangler structured output is incomplete')
  }
  const lines = text.slice(0, -1).split('\n')
  if (lines.some((line) => line.length === 0)) {
    fail('Wrangler structured output contains an empty record')
  }
  const records = lines.map((line) => {
    const record = parseStrictJsonc(line)
    if (!isObject(record)) {
      fail('Wrangler structured output record is not an object')
    }
    return record
  })
  for (const record of records.filter(
    (entry) => entry.type === 'wrangler-session'
  )) {
    assertAllowedKeys(
      record,
      [
        'type',
        'version',
        'wrangler_version',
        'command_line_args',
        'log_file_path',
        'timestamp'
      ],
      'Wrangler session output'
    )
    if (
      record.version !== 1 ||
      typeof record.wrangler_version !== 'string' ||
      typeof record.timestamp !== 'string' ||
      !Number.isFinite(Date.parse(record.timestamp)) ||
      !Array.isArray(record.command_line_args) ||
      !record.command_line_args.every(
        (argument) => typeof argument === 'string'
      ) ||
      (record.log_file_path !== undefined &&
        record.log_file_path !== null &&
        typeof record.log_file_path !== 'string')
    ) {
      fail('Wrangler session output has an unsupported schema')
    }
  }
  return records.filter((record) => record.type !== 'wrangler-session')
}

function assertAllowedKeys(
  record: JsonObject,
  allowedKeys: string[],
  label: string
): void {
  const allowed = new Set(allowedKeys)
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    fail(`${label} contains an unknown structured-output field`)
  }
}

function parseVersionUploadRecord(
  privateConfig: PrivateConfig,
  expectedVersionId: 'null' | 'uuid'
): string | null {
  const records = readStructuredOutput(privateConfig)
  if (records.length !== 1) {
    fail('expected exactly one Wrangler version-upload output record')
  }
  const record = records[0]
  assertAllowedKeys(
    record,
    [
      'type',
      'version',
      'worker_name',
      'worker_tag',
      'version_id',
      'preview_url',
      'preview_alias_url',
      'wrangler_environment',
      'worker_name_overridden',
      'bundle_size',
      'timestamp'
    ],
    'Wrangler version-upload output'
  )
  if (
    record.type !== 'version-upload' ||
    record.version !== 1 ||
    record.worker_name !== EXPECTED_WORKER
  ) {
    fail('Wrangler version-upload output does not match the expected Worker')
  }
  if (record.preview_url != null || record.preview_alias_url != null) {
    fail(
      'Wrangler returned a preview URL while preview exposure is required to stay disabled'
    )
  }
  const versionId = record.version_id
  if (expectedVersionId === 'null') {
    if (versionId !== null) {
      fail('dry-run unexpectedly returned a remote Worker Version ID')
    }
    return null
  }
  if (
    typeof versionId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      versionId
    )
  ) {
    fail('Wrangler upload did not return a valid Worker Version ID')
  }
  return versionId
}

export function parseVersionView(
  stdout: string,
  versionId: string,
  message: string,
  releaseSha: string
): void {
  const view = parseStrictJsonc(stdout)
  if (
    !isObject(view) ||
    view.id !== versionId ||
    !isObject(view.annotations) ||
    !isObject(view.resources) ||
    !Array.isArray(view.resources.bindings)
  ) {
    fail(
      'Cloudflare version read-back did not identify the uploaded Worker Version'
    )
  }
  if (view.annotations['workers/message'] !== message) {
    fail(
      'Cloudflare version read-back does not contain the exact commit-SHA message'
    )
  }
  const releaseBindings = view.resources.bindings.filter(
    (binding) => isObject(binding) && binding.name === RELEASE_VARIABLE
  )
  if (
    releaseBindings.length !== 1 ||
    !isObject(releaseBindings[0]) ||
    releaseBindings[0].type !== 'plain_text' ||
    releaseBindings[0].text !== releaseSha
  ) {
    fail(
      'Cloudflare version read-back does not contain the exact release SHA binding'
    )
  }
}

type CloudflareTargetState = {
  accountId: string
  zoneId: string
  workerName: string
  workersDevEnabled: false
  previewUrlsEnabled: false
  customDomain: JsonObject
  routeDnsReadback: 'not-read'
  secretNames: string[]
  secretPagination: 'available' | 'unavailable-by-api'
  readbacks: JsonObject
}

type CloudflareEvidenceStore = {
  directory: string
  write: (phase: string, label: string, evidence: JsonObject) => string
}

type CloudflareReadContext = {
  phase: string
  interruption?: DeploymentInterruption
  evidenceStore?: CloudflareEvidenceStore
}

function cloudflareUrl(
  path: string,
  parameters: Record<string, string> = {}
): string {
  const url = new URL(`${CLOUDFLARE_API_BASE}${path}`)
  for (const [key, value] of Object.entries(parameters)) {
    url.searchParams.set(key, value)
  }
  return url.toString()
}

function createCloudflareEvidenceStore(): CloudflareEvidenceStore {
  const tempParent = resolve(process.env.TMPDIR || systemTempDirectory())
  const parentStats = lstatSync(tempParent)
  const privateParent = (parentStats.mode & 0o022) === 0
  const trustedStickyParent =
    (parentStats.mode & 0o1000) !== 0 &&
    (parentStats.mode & 0o002) !== 0 &&
    (parentStats.uid === 0 || parentStats.uid === currentUid())
  if (
    parentStats.isSymbolicLink() ||
    !parentStats.isDirectory() ||
    (!privateParent && !trustedStickyParent) ||
    realpathSync(tempParent) !== tempParent
  ) {
    fail(
      'Cloudflare evidence requires a canonical private or trusted sticky temporary parent'
    )
  }
  const directory = mkdtempSync(
    join(tempParent, 'mzm-identicon-cloudflare-evidence-')
  )
  const directoryIdentity = identityFor(directory, 'directory')
  const directoryStats = lstatSync(directory)
  if (
    (directoryStats.mode & 0o077) !== 0 ||
    realpathSync(directory) !== directory
  ) {
    fail('Cloudflare evidence directory is not private and canonical')
  }
  let sequence = 0
  return {
    directory,
    write: (phase, label, evidence) => {
      if (!/^[a-z0-9-]+$/.test(phase) || !/^[a-z0-9-]+$/.test(label)) {
        fail('Cloudflare evidence labels must be fixed lowercase identifiers')
      }
      assertIdentity(directory, directoryIdentity)
      const filename = `${phase}-${String(++sequence).padStart(3, '0')}-${label}.json`
      const path = join(directory, filename)
      let descriptor: number | undefined
      try {
        descriptor = openSync(
          path,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600
        )
        const fileStats = fstatSync(descriptor)
        if (
          !fileStats.isFile() ||
          fileStats.uid !== currentUid() ||
          (fileStats.mode & 0o077) !== 0 ||
          fileStats.nlink !== 1
        ) {
          fail('Cloudflare evidence file has unsafe ownership or permissions')
        }
        writeFileSync(
          descriptor,
          `${JSON.stringify(evidence, null, 2)}\n`,
          'utf8'
        )
        fsyncSync(descriptor)
      } catch {
        fail('Cloudflare read-only evidence could not be persisted safely')
      } finally {
        if (descriptor !== undefined) closeSync(descriptor)
      }
      assertIdentity(path, identityFor(path, 'file'))
      return path
    }
  }
}

async function cloudflareGet(
  url: string,
  apiToken: string,
  fetcher: typeof fetch,
  context?: CloudflareReadContext,
  label = 'api-response',
  sensitiveBody = false
): Promise<JsonObject> {
  if (context?.interruption) {
    assertNotInterrupted(context.interruption, 'Cloudflare preflight request')
  }
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    fail('Cloudflare preflight refuses NODE_TLS_REJECT_UNAUTHORIZED=0')
  }
  const parsedUrl = new URL(url)
  if (
    parsedUrl.origin !== CLOUDFLARE_API_ORIGIN ||
    !parsedUrl.pathname.startsWith('/client/v4/')
  ) {
    fail('Cloudflare preflight refused an unexpected API origin')
  }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), PREFLIGHT_TIMEOUT_MS)
  const evidenceLabel = label
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const requestPath = `${parsedUrl.pathname}${parsedUrl.search}`
  const responseHeaders = (response: Response): JsonObject => {
    const headers: JsonObject = {}
    response.headers.forEach((value, name) => {
      headers[name] = /authorization|cookie|token|secret|api[-_]key/i.test(name)
        ? '[REDACTED]'
        : value
    })
    return headers
  }
  let response: Response
  try {
    response = await fetcher(parsedUrl.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        Accept: 'application/json'
      },
      signal: context?.interruption
        ? AbortSignal.any([controller.signal, context.interruption.signal])
        : controller.signal
    })
  } catch {
    clearTimeout(timeout)
    context?.evidenceStore?.write(context.phase, evidenceLabel, {
      request_path: requestPath,
      http_status: null,
      response_headers: {},
      request_error: 'fetch_failed'
    })
    if (context?.interruption?.signal.aborted) {
      fail(
        `Cloudflare read-only preflight interrupted by ${context.interruption.receivedSignal() ?? 'external signal'}`
      )
    }
    fail('Cloudflare read-only preflight request failed')
  }
  let rawBody: string
  try {
    rawBody = await response.text()
  } catch {
    clearTimeout(timeout)
    context?.evidenceStore?.write(context.phase, evidenceLabel, {
      request_path: requestPath,
      http_status: response.status,
      response_headers: responseHeaders(response),
      body_read_error: 'response_body_unavailable'
    })
    if (context?.interruption?.signal.aborted) {
      fail(
        `Cloudflare read-only preflight interrupted by ${context.interruption.receivedSignal() ?? 'external signal'}`
      )
    }
    fail(
      `Cloudflare read-only preflight could not read the response body (HTTP ${response.status})`
    )
  }
  clearTimeout(timeout)
  const bodyHash = createHash('sha256').update(rawBody, 'utf8').digest('hex')
  const headers = responseHeaders(response)
  if (sensitiveBody) {
    context?.evidenceStore?.write(context.phase, evidenceLabel, {
      request_path: requestPath,
      http_status: response.status,
      response_headers: headers,
      raw_body_sha256: bodyHash,
      raw_body: '[OMITTED: endpoint may return secret values]'
    })
  } else {
    context?.evidenceStore?.write(context.phase, evidenceLabel, {
      request_path: requestPath,
      http_status: response.status,
      response_headers: headers,
      raw_body_sha256: bodyHash,
      raw_body: rawBody
    })
  }
  let payload: unknown
  try {
    payload = JSON.parse(rawBody) as unknown
  } catch {
    if (context?.interruption?.signal.aborted) {
      fail(
        `Cloudflare read-only preflight interrupted by ${context.interruption.receivedSignal() ?? 'external signal'}`
      )
    }
    fail(
      `Cloudflare read-only preflight returned invalid JSON (HTTP ${response.status})`
    )
  }
  if (
    !response.ok ||
    !isObject(payload) ||
    payload.success !== true ||
    !('result' in payload)
  ) {
    const errorCodes =
      isObject(payload) && Array.isArray(payload.errors)
        ? payload.errors
            .filter(
              (error) => isObject(error) && typeof error.code === 'number'
            )
            .map((error) => (isObject(error) ? String(error.code) : ''))
            .join(',')
        : 'unavailable'
    fail(
      `Cloudflare read-only preflight failed (HTTP ${response.status}; API error codes ${errorCodes})`
    )
  }
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    fail(
      `Cloudflare read-only preflight reported API errors (HTTP ${response.status})`
    )
  }
  if (sensitiveBody) {
    context?.evidenceStore?.write(context.phase, `${evidenceLabel}-redacted`, {
      request_path: requestPath,
      http_status: response.status,
      response_headers: headers,
      raw_body_sha256: bodyHash,
      parsed_body: normalizedCloudflareEnvelope(payload, true)
    })
  }
  return payload
}

async function cloudflarePages(
  baseUrl: string,
  apiToken: string,
  fetcher: typeof fetch,
  label: string,
  initialPayload?: JsonObject,
  context?: CloudflareReadContext,
  redactSecretValues = false
): Promise<{ records: JsonObject[]; readbacks: JsonObject[] }> {
  const records: JsonObject[] = []
  const readbacks: JsonObject[] = []
  const identifiers = new Set<string>()
  let expectedCount: number | undefined
  let totalPages: number | undefined
  let expectedPerPage: number | undefined
  for (let page = 1; page <= 100; page += 1) {
    const url = new URL(baseUrl)
    url.searchParams.set('per_page', String(CLOUDFLARE_PAGE_SIZE))
    url.searchParams.set('page', String(page))
    const payload =
      page === 1 && initialPayload
        ? initialPayload
        : await cloudflareGet(
            url.toString(),
            apiToken,
            fetcher,
            context,
            `${label}-page-${page}`,
            redactSecretValues
          )
    if (!Array.isArray(payload.result) || !isObject(payload.result_info)) {
      fail(`Cloudflare ${label} read-back did not include a paginated result`)
    }
    readbacks.push(normalizedCloudflareEnvelope(payload, redactSecretValues))
    const pageRecords = payload.result
    const info = payload.result_info
    const countValue = info.total_count
    const perPageValue = info.per_page
    const returnedValue = info.count
    if (
      typeof countValue !== 'number' ||
      typeof perPageValue !== 'number' ||
      typeof returnedValue !== 'number'
    ) {
      fail(`Cloudflare ${label} read-back had non-numeric pagination metadata`)
    }
    const count = countValue
    const perPage = perPageValue
    const returned = returnedValue
    const responsePage = info.page
    if (typeof responsePage !== 'number' || responsePage !== page) {
      fail(`Cloudflare ${label} read-back returned an unexpected page number`)
    }
    const pageCount =
      typeof info.total_pages === 'number'
        ? info.total_pages
        : typeof count === 'number' && typeof perPage === 'number'
          ? Math.ceil(count / perPage)
          : Number.NaN
    if (
      !Number.isSafeInteger(count) ||
      !Number.isSafeInteger(perPage) ||
      perPage !== CLOUDFLARE_PAGE_SIZE ||
      !Number.isSafeInteger(returned) ||
      returned !== pageRecords.length ||
      !Number.isSafeInteger(pageCount) ||
      pageCount < 0 ||
      pageRecords.length > perPage ||
      ('total_pages' in info && typeof info.total_pages !== 'number') ||
      (count === 0 && (pageCount > 1 || returned !== 0)) ||
      (count > 0 && pageCount !== Math.ceil(count / perPage))
    ) {
      fail(`Cloudflare ${label} read-back had inconsistent pagination metadata`)
    }
    if (expectedCount === undefined) {
      expectedCount = count
      expectedPerPage = perPage
      totalPages = pageCount
    } else if (
      count !== expectedCount ||
      perPage !== expectedPerPage ||
      pageCount !== totalPages
    ) {
      fail(`Cloudflare ${label} read-back changed during pagination`)
    }
    for (const record of pageRecords) {
      if (!isObject(record)) {
        fail(`Cloudflare ${label} read-back contained a malformed record`)
      }
      const identity =
        typeof record.id === 'string' && record.id.length > 0
          ? `id:${record.id}`
          : typeof record.name === 'string' && record.name.length > 0
            ? `name:${record.name}`
            : undefined
      if (!identity || identifiers.has(identity)) {
        fail(
          `Cloudflare ${label} read-back contained a missing or duplicate record identity`
        )
      }
      identifiers.add(identity)
      records.push(record)
    }
    if (page >= pageCount) {
      break
    }
  }
  if (
    expectedCount === undefined ||
    records.length !== expectedCount ||
    (totalPages ?? 0) > 100
  ) {
    fail(`Cloudflare ${label} read-back was incomplete`)
  }
  return { records, readbacks }
}

async function cloudflareListWithOptionalPagination(
  baseUrl: string,
  apiToken: string,
  fetcher: typeof fetch,
  label: string,
  context?: CloudflareReadContext,
  redactSecretValues = false
): Promise<{
  records: JsonObject[]
  pagination: 'available' | 'unavailable-by-api'
  readbacks: JsonObject[]
}> {
  const firstUrl = new URL(baseUrl)
  firstUrl.searchParams.set('per_page', String(CLOUDFLARE_PAGE_SIZE))
  firstUrl.searchParams.set('page', '1')
  const firstPayload = await cloudflareGet(
    firstUrl.toString(),
    apiToken,
    fetcher,
    context,
    `${label}-page-1`,
    redactSecretValues
  )
  if (!Array.isArray(firstPayload.result)) {
    fail(`Cloudflare ${label} read-back did not contain a result array`)
  }
  if (!('result_info' in firstPayload)) {
    const identifiers = new Set<string>()
    const records: JsonObject[] = []
    for (const record of firstPayload.result) {
      if (!isObject(record)) {
        fail(`Cloudflare ${label} read-back contained a malformed record`)
      }
      const identity =
        typeof record.id === 'string' && record.id.length > 0
          ? `id:${record.id}`
          : typeof record.name === 'string' && record.name.length > 0
            ? `name:${record.name}`
            : undefined
      if (!identity || identifiers.has(identity)) {
        fail(
          `Cloudflare ${label} read-back contained a missing or duplicate record identity`
        )
      }
      identifiers.add(identity)
      records.push(record)
    }
    return {
      records,
      pagination: 'unavailable-by-api',
      readbacks: [
        normalizedCloudflareEnvelope(firstPayload, redactSecretValues)
      ]
    }
  }
  const pages = await cloudflarePages(
    baseUrl,
    apiToken,
    fetcher,
    label,
    firstPayload,
    context,
    redactSecretValues
  )
  return {
    records: pages.records,
    pagination: 'available',
    readbacks: pages.readbacks
  }
}

function canonicalizeJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJson)
  }
  if (!isObject(value)) {
    return value
  }
  const normalized: JsonObject = {}
  for (const key of Object.keys(value).sort()) {
    normalized[key] = canonicalizeJson(value[key])
  }
  return normalized
}

function normalizedCloudflareEnvelope(
  payload: JsonObject,
  redactSecretValues = false
): JsonObject {
  const normalize = (value: JsonValue, parentKey = ''): JsonValue => {
    if (Array.isArray(value)) {
      const normalized = value.map((item) => normalize(item))
      return ['result', 'errors', 'messages'].includes(parentKey)
        ? normalized.sort((left, right) =>
            JSON.stringify(left).localeCompare(JSON.stringify(right))
          )
        : normalized
    }
    if (!isObject(value)) return value
    const normalized: JsonObject = {}
    for (const key of Object.keys(value).sort()) {
      const normalizedKey = key.toLowerCase()
      if (
        redactSecretValues &&
        [
          'text',
          'key',
          'key_base64',
          'key_jwk',
          'secret',
          'token',
          'value'
        ].includes(normalizedKey)
      ) {
        normalized[key] = '[REDACTED]'
      } else {
        normalized[key] = normalize(value[key], normalizedKey)
      }
    }
    return normalized
  }
  const normalized = normalize(payload)
  if (!isObject(normalized)) fail('Cloudflare response envelope is malformed')
  return normalized
}

function requireStringField(
  record: JsonObject,
  field: string,
  label: string
): string {
  const value = record[field]
  if (typeof value !== 'string' || value.length === 0) {
    fail(`Cloudflare ${label} read-back is missing ${field}`)
  }
  return value
}

export async function readCloudflareTargetState(
  accountId: string,
  apiToken: string,
  fetcher: typeof fetch = fetch,
  context: CloudflareReadContext = { phase: 'preflight-test' }
): Promise<CloudflareTargetState> {
  if (!/^[a-f0-9]{32}$/.test(accountId)) {
    fail('Cloudflare preflight requires an explicit 32-character account id')
  }
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    fail('Cloudflare preflight refuses NODE_TLS_REJECT_UNAUTHORIZED=0')
  }
  const readbacks: JsonObject = {}
  const zoneReadback = await cloudflarePages(
    cloudflareUrl('/zones', {
      'account.id': accountId,
      name: EXPECTED_ZONE,
      status: 'active'
    }),
    apiToken,
    fetcher,
    'zone',
    undefined,
    context
  )
  const zones = zoneReadback.records
  readbacks.zones = zoneReadback.readbacks
  if (zones.length !== 1) {
    fail('Cloudflare preflight did not find exactly one active target zone')
  }
  const zone = zones[0]
  if (zone.name !== EXPECTED_ZONE || zone.status !== 'active') {
    fail('Cloudflare preflight did not find exactly one active target zone')
  }
  if (!isObject(zone.account) || typeof zone.account.id !== 'string') {
    fail('Cloudflare target zone does not expose its account identity')
  }
  if (zone.account.id !== accountId) {
    fail(
      'Cloudflare target zone does not belong to the explicitly selected account'
    )
  }
  const zoneId = zone.id
  if (typeof zoneId !== 'string' || !/^[a-f0-9]{32}$/.test(zoneId)) {
    fail('Cloudflare target zone does not expose a valid zone identity')
  }

  const accountPath = `/accounts/${encodeURIComponent(accountId)}`
  const workerPath = `${accountPath}/workers/scripts/${encodeURIComponent(EXPECTED_WORKER)}`
  const domainReadback = await cloudflarePages(
    cloudflareUrl(`${accountPath}/workers/domains`, {
      environment: 'production',
      hostname: EXPECTED_HOSTNAME,
      zone_id: zoneId
    }),
    apiToken,
    fetcher,
    'Worker domain',
    undefined,
    context
  )
  const domainRecords = domainReadback.records
  readbacks.customDomain = domainReadback.readbacks
  const matchingDomains = domainRecords.filter(
    (record) =>
      record.hostname === EXPECTED_HOSTNAME && record.zone_id === zoneId
  )
  if (domainRecords.length !== 1 || matchingDomains.length !== 1) {
    fail('Cloudflare preflight did not find exactly one target Custom Domain')
  }
  const domain = matchingDomains[0]
  requireStringField(domain, 'id', 'Custom Domain')
  const domainService = requireStringField(domain, 'service', 'Custom Domain')
  if (
    domain.zone_name !== EXPECTED_ZONE ||
    domain.environment !== 'production' ||
    domainService !== EXPECTED_WORKER ||
    domain.enabled !== true ||
    domain.previews_enabled !== false
  ) {
    fail(
      'Cloudflare Custom Domain is not enabled on the expected production Worker and zone'
    )
  }

  const subdomainPayload = await cloudflareGet(
    cloudflareUrl(`${workerPath}/subdomain`),
    apiToken,
    fetcher,
    context,
    'worker-subdomain'
  )
  readbacks.workerSubdomain = [normalizedCloudflareEnvelope(subdomainPayload)]
  if (
    !isObject(subdomainPayload.result) ||
    subdomainPayload.result.enabled !== false ||
    subdomainPayload.result.previews_enabled !== false
  ) {
    fail(
      'Cloudflare Worker workers.dev or preview exposure is not confirmed disabled'
    )
  }

  const secretResult = await cloudflareListWithOptionalPagination(
    cloudflareUrl(`${workerPath}/secrets`),
    apiToken,
    fetcher,
    'Worker secret-name',
    context,
    true
  )
  readbacks.workerSecrets = secretResult.readbacks
  const secretNames: string[] = []
  for (const secret of secretResult.records) {
    if (typeof secret.name !== 'string' || secret.name.length === 0) {
      fail(
        'Cloudflare Worker secret-name read-back contained a malformed record'
      )
    }
    if (secret.type !== undefined && typeof secret.type !== 'string') {
      fail(
        'Cloudflare Worker secret-name read-back contained an invalid secret type'
      )
    }
    secretNames.push(secret.name)
  }
  if (new Set(secretNames).size !== secretNames.length) {
    fail('Cloudflare Worker secret-name read-back contained duplicate names')
  }
  if (secretNames.includes(RELEASE_VARIABLE)) {
    fail('release marker name conflicts with an existing remote Worker secret')
  }
  secretNames.sort()

  readbacks.routeDns = {
    status: 'not-read',
    reason:
      'route-free version upload and promotion do not modify zone routes or DNS records'
  }

  const state: CloudflareTargetState = {
    accountId,
    zoneId,
    workerName: EXPECTED_WORKER,
    workersDevEnabled: false,
    previewUrlsEnabled: false,
    customDomain: canonicalizeJson(domain) as JsonObject,
    routeDnsReadback: 'not-read',
    secretNames,
    secretPagination: secretResult.pagination,
    readbacks: canonicalizeJson(readbacks) as JsonObject
  }
  context.evidenceStore?.write(
    context.phase,
    'summary',
    JSON.parse(JSON.stringify(state)) as JsonObject
  )
  return state
}

export function assertCloudflareTargetStateUnchanged(
  expected: CloudflareTargetState,
  actual: CloudflareTargetState,
  phase: string
): void {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    fail(
      `Cloudflare account, Custom Domain, exposure, or Worker secret state changed ${phase}`
    )
  }
}

export function assertPinnedWranglerVersion(
  output: string,
  expectedVersion: string
): void {
  if (output.trim() !== expectedVersion) {
    fail(
      `repository-local Wrangler version does not exactly match the pinned ${expectedVersion}`
    )
  }
}

function parseVersionDeployRecord(privateConfig: PrivateConfig): string {
  const records = readStructuredOutput(privateConfig)
  if (records.length !== 2) {
    fail('expected version-upload and version-deploy output records')
  }
  const record = records[1]
  assertAllowedKeys(
    record,
    [
      'type',
      'version',
      'worker_name',
      'worker_tag',
      'deployment_id',
      'version_traffic',
      'timestamp'
    ],
    'Wrangler version-deploy output'
  )
  if (
    record.type !== 'version-deploy' ||
    record.version !== 1 ||
    record.worker_name !== EXPECTED_WORKER
  ) {
    fail('Wrangler version-deploy output does not match the expected Worker')
  }
  if (
    typeof record.deployment_id !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      record.deployment_id
    )
  ) {
    fail('Wrangler version-deploy output did not return a deployment ID')
  }
  return record.deployment_id
}

function assertActiveDeployment(
  stdout: string,
  expectedVersionId: string,
  expectedDeploymentId: string,
  expectedMessage: string
): void {
  const deployment = parseStrictJsonc(stdout)
  if (!isObject(deployment) || deployment.id !== expectedDeploymentId) {
    fail(
      'Cloudflare deployment read-back does not match the deployment just created'
    )
  }
  if (
    !isObject(deployment.annotations) ||
    deployment.annotations['workers/message'] !== expectedMessage
  ) {
    fail(
      'Cloudflare deployment read-back does not contain the exact commit-SHA message'
    )
  }
  if (!Array.isArray(deployment.versions) || deployment.versions.length !== 1) {
    fail('Cloudflare latest deployment is not a single-version promotion')
  }
  const activeVersion = deployment.versions[0]
  if (
    !isObject(activeVersion) ||
    activeVersion.version_id !== expectedVersionId ||
    activeVersion.percentage !== 100
  ) {
    fail(
      'Cloudflare latest deployment does not serve the uploaded version at 100%'
    )
  }
}

async function runDeployment(
  mode: 'deploy' | 'dry-run',
  interruption: DeploymentInterruption
): Promise<void> {
  if (typeof process.getuid !== 'function') {
    fail('deployment wrapper requires POSIX filesystem ownership checks')
  }
  if (mode === 'dry-run') {
    assertExposureReadback(
      process.env.MZM_IDENTICON_PREFLIGHT_WORKERS_DEV,
      process.env.MZM_IDENTICON_PREFLIGHT_PREVIEW_URLS
    )
  }
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
  if (typeof accountId !== 'string') {
    fail('CLOUDFLARE_ACCOUNT_ID must be set from the verified target account')
  }
  const apiToken =
    mode === 'deploy' ? process.env.CLOUDFLARE_API_TOKEN : undefined
  if (mode === 'deploy' && !apiToken) {
    fail(
      'production deploy requires CLOUDFLARE_API_TOKEN injected through op run'
    )
  }

  const initialCheckout = await releaseCheckout(interruption)
  const { binaryPath, expectedVersion } = resolveWranglerBinary()
  const versionEnvironment = safeBaseEnvironment(process.env)
  const versionResult = await runWrangler(
    binaryPath,
    ['--version'],
    versionEnvironment,
    VERSION_TIMEOUT_MS,
    interruption
  )
  const versionOutput = assertCommandSucceeded(
    versionResult,
    'repository-pinned Wrangler version check'
  )
  assertPinnedWranglerVersion(versionOutput, expectedVersion)

  const evidenceStore = apiToken ? createCloudflareEvidenceStore() : undefined
  if (evidenceStore) {
    console.log(
      `Cloudflare read-only evidence directory: ${evidenceStore.directory}`
    )
  }
  const initialTargetState = apiToken
    ? await readCloudflareTargetState(accountId, apiToken, fetch, {
        phase: 'preflight-before-upload',
        interruption,
        evidenceStore
      })
    : undefined
  if (mode === 'deploy' && !initialTargetState) {
    fail('production deployment requires a completed live Cloudflare preflight')
  }

  const privateConfig = createPrivateConfig(temporaryConfigText(accountId))
  let operationError: Error | null = null
  let cleanupError: Error | null = null
  let cleanupSafe = true
  const markUnconfirmedTermination = (): void => {
    cleanupSafe = false
  }
  let remoteWriteAttempted = false
  let uploadedVersionId: string | null = null
  const message = `${EXPECTED_WORKER} release ${initialCheckout.sha}`
  try {
    assertNotInterrupted(interruption, 'deployment setup')
    assertIdentity(privateConfig.rootPath, privateConfig.rootIdentity)
    assertIdentity(privateConfig.tmpPath, privateConfig.tmpIdentity)
    assertIdentity(privateConfig.configPath, privateConfig.configIdentity)
    assertIdentity(privateConfig.outputPath, privateConfig.outputIdentity)
    const beforeUpload = await releaseCheckout(
      interruption,
      markUnconfirmedTermination
    )
    if (
      beforeUpload.branch !== initialCheckout.branch ||
      beforeUpload.sha !== initialCheckout.sha
    ) {
      fail(
        'release branch or HEAD changed after the initial clean-checkout check'
      )
    }

    const uploadArgs = [
      'versions',
      'upload',
      '--config',
      privateConfig.configPath,
      '--keep-vars',
      '--strict',
      '--message',
      message,
      '--var',
      `${RELEASE_VARIABLE}:${initialCheckout.sha}`
    ]
    if (mode === 'dry-run') {
      uploadArgs.push('--dry-run')
    } else {
      remoteWriteAttempted = true
    }
    console.log(
      mode === 'dry-run'
        ? `$ wrangler versions upload --dry-run --config <private-route-free-config> --keep-vars --strict --message "${EXPECTED_WORKER} release <full-commit-sha>" --var ${RELEASE_VARIABLE}:<full-commit-sha>`
        : `$ wrangler versions upload --config <private-route-free-config> --keep-vars --strict --message "${EXPECTED_WORKER} release <full-commit-sha>" --var ${RELEASE_VARIABLE}:<full-commit-sha>`
    )

    const childEnvironment = buildWranglerEnvironment(
      process.env,
      accountId,
      apiToken,
      privateConfig.tmpPath,
      privateConfig.outputPath
    )
    const uploadResult = await runWrangler(
      binaryPath,
      uploadArgs,
      childEnvironment,
      DEPLOY_TIMEOUT_MS,
      interruption,
      markUnconfirmedTermination
    )
    if (!uploadResult.terminationConfirmed) {
      cleanupSafe = false
    }
    assertCommandSucceeded(uploadResult, `Wrangler versions upload ${mode}`)

    uploadedVersionId = parseVersionUploadRecord(
      privateConfig,
      mode === 'dry-run' ? 'null' : 'uuid'
    )
    if (mode === 'dry-run') {
      console.log(
        `Wrangler versions upload dry-run completed for ${initialCheckout.sha}`
      )
    } else {
      if (!uploadedVersionId) {
        fail('Worker version upload did not return a deployable Version ID')
      }
      const versionReadback = await runWrangler(
        binaryPath,
        [
          'versions',
          'view',
          uploadedVersionId,
          '--name',
          EXPECTED_WORKER,
          '--config',
          privateConfig.configPath,
          '--json'
        ],
        childEnvironment,
        VERSION_TIMEOUT_MS,
        interruption,
        markUnconfirmedTermination
      )
      const versionViewOutput = assertCommandSucceeded(
        versionReadback,
        'Cloudflare Worker Version read-back'
      )
      parseVersionView(
        versionViewOutput,
        uploadedVersionId,
        message,
        initialCheckout.sha
      )

      assertNotInterrupted(interruption, 'pre-promotion read-back')
      const beforePromotionState = await readCloudflareTargetState(
        accountId,
        apiToken!,
        fetch,
        {
          phase: 'preflight-before-promotion',
          interruption,
          evidenceStore
        }
      )
      assertCloudflareTargetStateUnchanged(
        initialTargetState!,
        beforePromotionState,
        'before version promotion'
      )

      const beforePromotion = await releaseCheckout(
        interruption,
        markUnconfirmedTermination
      )
      if (
        beforePromotion.branch !== initialCheckout.branch ||
        beforePromotion.sha !== initialCheckout.sha
      ) {
        fail('release branch or HEAD changed before version promotion')
      }
      assertNotInterrupted(interruption, 'version promotion')
      const promoteArgs = [
        'versions',
        'deploy',
        '--config',
        privateConfig.configPath,
        '--name',
        EXPECTED_WORKER,
        '--version-id',
        uploadedVersionId,
        '--percentage',
        '100',
        '--message',
        message,
        '--yes'
      ]
      remoteWriteAttempted = true
      console.log(
        `$ wrangler versions deploy --config <private-route-free-config> --name ${EXPECTED_WORKER} --version-id ${uploadedVersionId} --percentage 100 --message "${message}" --yes`
      )
      const promoteResult = await runWrangler(
        binaryPath,
        promoteArgs,
        childEnvironment,
        DEPLOY_TIMEOUT_MS,
        interruption,
        markUnconfirmedTermination
      )
      if (!promoteResult.terminationConfirmed) {
        cleanupSafe = false
      }
      assertCommandSucceeded(promoteResult, 'Wrangler versions deploy')

      const deploymentId = parseVersionDeployRecord(privateConfig)
      const statusReadback = await runWrangler(
        binaryPath,
        [
          'deployments',
          'status',
          '--config',
          privateConfig.configPath,
          '--name',
          EXPECTED_WORKER,
          '--json'
        ],
        childEnvironment,
        VERSION_TIMEOUT_MS,
        interruption,
        markUnconfirmedTermination
      )
      const statusOutput = assertCommandSucceeded(
        statusReadback,
        'Cloudflare active Deployment read-back'
      )
      assertActiveDeployment(
        statusOutput,
        uploadedVersionId,
        deploymentId,
        message
      )
      assertNotInterrupted(interruption, 'post-deployment read-back')
      const afterDeploymentState = await readCloudflareTargetState(
        accountId,
        apiToken!,
        fetch,
        {
          phase: 'preflight-after-deployment',
          interruption,
          evidenceStore
        }
      )
      assertCloudflareTargetStateUnchanged(
        initialTargetState!,
        afterDeploymentState,
        'after version promotion'
      )
      console.log(
        `Cloudflare active deployment confirmed: ${uploadedVersionId} at 100% for ${initialCheckout.sha}; account, exposure, Custom Domain, and Worker secret names are read back unchanged. Zone routes and DNS were not read; this route-free Version-only flow does not modify them`
      )
    }
  } catch (error) {
    operationError =
      error instanceof Error ? error : new Error('deployment failed')
  }

  if (cleanupSafe) {
    try {
      cleanupPrivateConfig(privateConfig)
    } catch (error) {
      cleanupError =
        error instanceof Error
          ? error
          : new Error('private deploy config cleanup failed')
    }
  } else {
    cleanupError = new Error(
      'private config retained because the process group may still be running'
    )
  }
  if (operationError || cleanupError) {
    const messages = [operationError?.message, cleanupError?.message].filter(
      Boolean
    )
    if (remoteWriteAttempted) {
      messages.push(
        uploadedVersionId
          ? `Cloudflare may contain uploaded/promotion state for Version ${uploadedVersionId}; read it back before retrying`
          : 'Cloudflare may contain uploaded/promotion state; read it back before retrying'
      )
    }
    fail(messages.join('\n'))
  }
  assertNotInterrupted(interruption, 'deployment completion')
}

function showHelp(): void {
  console.log(`Usage: node scripts/deploy.ts <deploy|dry-run>

Production and dry-run commands use the same private route-free Wrangler config.
Required for both modes: CLOUDFLARE_ACCOUNT_ID for the intended target account.
Dry-run only: preflight flags confirming both exposure modes are disabled.
Production only: CLOUDFLARE_API_TOKEN injected by op run; the wrapper reads the target account, Custom Domain, exposure, and Worker secret names before upload/promotion, then verifies those same fields remain unchanged. Zone routes and DNS are not read because the private route-free Version-only flow does not modify them.

The command requires a clean verify/<release> branch and an exact repository-pinned Wrangler version. It promotes the uploaded Version explicitly at 100% traffic and then reads Cloudflare's active Deployment back before returning success.`)
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h', default: false }
    }
  })
  if (values.help) {
    showHelp()
    return
  }
  if (
    positionals.length !== 1 ||
    (positionals[0] !== 'deploy' && positionals[0] !== 'dry-run')
  ) {
    fail('expected exactly one command: deploy or dry-run')
  }
  const interruption = createDeploymentInterruption()
  try {
    await runDeployment(positionals[0], interruption)
  } finally {
    interruption.dispose()
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error: unknown) => {
    const message =
      error instanceof Error ? error.message : 'unexpected deployment failure'
    console.error(message)
    process.exitCode = 1
  })
}
