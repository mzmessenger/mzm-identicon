import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  assertCloudflareTargetStateUnchanged,
  assertExposureReadback,
  assertPinnedWranglerVersion,
  assertTrackedWorktreeMatchesIndex,
  buildRouteFreeConfig,
  buildWranglerEnvironment,
  parseStrictJsonc,
  parseStructuredOutput,
  parseVersionView,
  readCloudflareTargetState
} from '../scripts/deploy.ts'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const accountId = 'a'.repeat(32)
const zoneId = 'b'.repeat(32)
const releaseSha = 'c'.repeat(40)
const releaseMessage = `mzm-identicon release ${releaseSha}`
const deployIntegrationTest =
  process.env.MZM_RUN_DEPLOY_INTEGRATION === '1' ? it : it.skip

type PreflightOptions = {
  zoneAccountId?: string
  workersDevEnabled?: boolean
  previewUrlsEnabled?: boolean
  secretName?: string
  domainEnvironment?: string
  domainEnabled?: boolean
  domainPreviewsEnabled?: boolean
  duplicateZonePage?: boolean
}

function cloudflareFetcher(options: PreflightOptions = {}): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input))
    if (url.origin !== 'https://api.cloudflare.com') {
      throw new Error('unexpected API origin')
    }
    if (
      new Headers(init?.headers).get('authorization') !== 'Bearer fixture-token'
    ) {
      throw new Error('unexpected authorization')
    }
    const paginated = (
      result: unknown[],
      totalCount = result.length,
      totalPages = result.length === 0 ? 0 : 1
    ) => ({
      success: true,
      result,
      result_info: {
        count: result.length,
        page: Number(url.searchParams.get('page') ?? 1),
        total_count: totalCount,
        per_page: Number(url.searchParams.get('per_page') ?? 50),
        total_pages: totalPages
      }
    })
    let body: unknown
    switch (url.pathname) {
      case '/client/v4/zones':
        {
          const zone = {
            id: zoneId,
            name: 'mzm.dev',
            status: 'active',
            account: { id: options.zoneAccountId ?? accountId }
          }
          const duplicateZonePage = options.duplicateZonePage === true
          const page = Number(url.searchParams.get('page') ?? 1)
          const zoneRecords = duplicateZonePage
            ? page === 1
              ? [
                  zone,
                  ...Array.from({ length: 49 }, (_, index) => ({
                    id: `other-zone-${index}`,
                    name: `other-${index}.invalid`,
                    status: 'inactive',
                    account: { id: accountId }
                  }))
                ]
              : [zone]
            : [zone]
          body = paginated(
            zoneRecords,
            duplicateZonePage ? 51 : 1,
            duplicateZonePage ? 2 : 1
          )
        }
        break
      case `/client/v4/accounts/${accountId}/workers/domains`:
        body = paginated([
          {
            id: 'domain-id',
            hostname: 'identicon.mzm.dev',
            service: 'mzm-identicon',
            zone_id: zoneId,
            zone_name: 'mzm.dev',
            environment: options.domainEnvironment ?? 'production',
            enabled: options.domainEnabled ?? true,
            previews_enabled: options.domainPreviewsEnabled ?? false
          }
        ])
        break
      case `/client/v4/accounts/${accountId}/workers/scripts/mzm-identicon/subdomain`:
        body = {
          success: true,
          result: {
            enabled: options.workersDevEnabled ?? false,
            previews_enabled: options.previewUrlsEnabled ?? false
          }
        }
        break
      case `/client/v4/accounts/${accountId}/workers/scripts/mzm-identicon/secrets`:
        body = {
          success: true,
          result: [
            {
              name: options.secretName ?? 'EXISTING_SECRET',
              type: 'secret_text'
            }
          ]
        }
        break
      default:
        throw new Error(`unexpected API path: ${url.pathname}`)
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }
}

describe('route-free deploy configuration', () => {
  it('pins the account, absolute entrypoint, and disabled exposure settings', () => {
    const config = buildRouteFreeConfig(
      readFileSync(join(repositoryRoot, 'wrangler.jsonc'), 'utf8'),
      accountId,
      repositoryRoot
    )

    expect(config.name).toBe('mzm-identicon')
    expect(config.account_id).toBe(accountId)
    expect(config.main).toBe(resolve(repositoryRoot, 'src/index.ts'))
    expect(config.workers_dev).toBe(false)
    expect(config.preview_urls).toBe(false)
    expect(config.routes).toBeUndefined()
  })

  it('rejects duplicate JSONC keys instead of silently selecting one', () => {
    expect(() => parseStrictJsonc('{"name":"first","name":"second"}')).toThrow(
      /duplicate key/i
    )
  })

  it('rejects nested route keys after stripping top-level routes', () => {
    expect(() =>
      buildRouteFreeConfig(
        '{"name":"mzm-identicon","main":"src/index.ts","routes":[],"env":{"preview":{"routes":[]}}}',
        accountId,
        repositoryRoot
      )
    ).toThrow(/nested.*route|route.*nested/i)
  })

  it('requires explicit disabled exposure flags for a credential-free dry-run', () => {
    expect(() => assertExposureReadback('false', 'false')).not.toThrow()
    expect(() => assertExposureReadback('true', 'false')).toThrow(/disabled/i)
    expect(() => assertExposureReadback(undefined, 'false')).toThrow(
      /disabled/i
    )
  })

  it('rejects an account id that is not a 32-character lowercase hexadecimal id', () => {
    expect(() =>
      buildRouteFreeConfig(
        readFileSync(join(repositoryRoot, 'wrangler.jsonc'), 'utf8'),
        'not-an-account',
        repositoryRoot
      )
    ).toThrow(/account/i)
  })

  it('binds release worktree bytes to tracked blobs and rejects hidden index flags', () => {
    const root = mkdtempSync(join(tmpdir(), 'mzm-identicon-index-test-'))
    const path = join(root, 'source.ts')
    const original = Buffer.from('committed source\n')
    const blobId = createHash('sha1')
      .update(`blob ${original.length}\0`, 'utf8')
      .update(original)
      .digest('hex')
    const index = `100644 ${blobId} 0\tsource.ts\0`
    writeFileSync(path, original, { mode: 0o644 })

    expect(() =>
      assertTrackedWorktreeMatchesIndex(root, index, 'H source.ts\0')
    ).not.toThrow()
    expect(() =>
      assertTrackedWorktreeMatchesIndex(root, index, 'h source.ts\0')
    ).toThrow(/assume-unchanged/i)
    writeFileSync(path, 'modified source\n', { mode: 0o644 })
    expect(() =>
      assertTrackedWorktreeMatchesIndex(root, index, 'H source.ts\0')
    ).toThrow(/differs from its indexed blob/i)

    unlinkSync(path)
    rmdirSync(root)
  })
})

describe('Cloudflare production preflight', () => {
  it('binds the live zone, Custom Domain, disabled exposure, and secret names to the target', async () => {
    const state = await readCloudflareTargetState(
      accountId,
      'fixture-token',
      cloudflareFetcher()
    )

    expect(state).toMatchObject({
      accountId,
      zoneId,
      workerName: 'mzm-identicon',
      workersDevEnabled: false,
      previewUrlsEnabled: false,
      customDomain: {
        hostname: 'identicon.mzm.dev',
        service: 'mzm-identicon'
      },
      routeDnsReadback: 'not-read',
      secretNames: ['EXISTING_SECRET']
    })
    expect(() =>
      assertCloudflareTargetStateUnchanged(state, state, 'after upload')
    ).not.toThrow()
    expect(() =>
      assertCloudflareTargetStateUnchanged(
        state,
        { ...state, customDomain: { ...state.customDomain, enabled: false } },
        'after upload'
      )
    ).toThrow(/changed/i)
  })

  it('does not require zone-route or DNS read permissions for a version-only preflight', async () => {
    const requestedPaths: string[] = []
    const baseFetcher = cloudflareFetcher()
    const fetcher: typeof fetch = async (input, init) => {
      requestedPaths.push(new URL(String(input)).pathname)
      return baseFetcher(input, init)
    }

    const state = await readCloudflareTargetState(
      accountId,
      'fixture-token',
      fetcher
    )

    expect(state).toHaveProperty('routeDnsReadback', 'not-read')
    expect(requestedPaths).not.toContain(
      `/client/v4/zones/${zoneId}/workers/routes`
    )
    expect(requestedPaths).not.toContain(
      `/client/v4/zones/${zoneId}/dns_records`
    )
  })

  it('refuses a zone owned by a different account', async () => {
    await expect(
      readCloudflareTargetState(
        accountId,
        'fixture-token',
        cloudflareFetcher({ zoneAccountId: 'd'.repeat(32) })
      )
    ).rejects.toThrow(/selected account/i)
  })

  it('rejects duplicate records returned on different pages', async () => {
    await expect(
      readCloudflareTargetState(
        accountId,
        'fixture-token',
        cloudflareFetcher({ duplicateZonePage: true })
      )
    ).rejects.toThrow(/duplicate record identity/i)
  })

  it('rejects a production domain with wrong environment or preview exposure', async () => {
    await expect(
      readCloudflareTargetState(
        accountId,
        'fixture-token',
        cloudflareFetcher({ domainEnvironment: 'staging' })
      )
    ).rejects.toThrow(/production Worker/i)
    await expect(
      readCloudflareTargetState(
        accountId,
        'fixture-token',
        cloudflareFetcher({ domainPreviewsEnabled: true })
      )
    ).rejects.toThrow(/production Worker/i)
  })

  it('refuses enabled exposure or a release-marker secret collision', async () => {
    await expect(
      readCloudflareTargetState(
        accountId,
        'fixture-token',
        cloudflareFetcher({ workersDevEnabled: true })
      )
    ).rejects.toThrow(/exposure.*disabled/i)
    await expect(
      readCloudflareTargetState(
        accountId,
        'fixture-token',
        cloudflareFetcher({ secretName: 'MZM_IDENTICON_RELEASE_SHA' })
      )
    ).rejects.toThrow(/conflicts/i)
  })

  it('refuses API reads when Node TLS certificate validation is disabled', async () => {
    const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED
    let fetchCalled = false
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
    try {
      await expect(
        readCloudflareTargetState(accountId, 'fixture-token', async () => {
          fetchCalled = true
          return new Response('{}', { status: 200 })
        })
      ).rejects.toThrow(/NODE_TLS_REJECT_UNAUTHORIZED=0/)
      expect(fetchCalled).toBe(false)
    } finally {
      if (previous === undefined)
        delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous
    }
  })
})

describe('pinned Wrangler invocation guards', () => {
  it('keeps ambient Worker-name, API endpoint, credentials, Git and Node overrides out of Wrangler', () => {
    const environment = buildWranglerEnvironment(
      {
        HOME: '/home/operator',
        PATH: '/usr/bin',
        CLOUDFLARE_API_KEY: 'ambient-key',
        CLOUDFLARE_EMAIL: 'untrusted-email-placeholder',
        CLOUDFLARE_API_BASE_URL: 'https://attacker.invalid/client/v4',
        CF_API_TOKEN: 'ambient-token',
        WRANGLER_CI_OVERRIDE_NAME: 'other-worker',
        NODE_OPTIONS: '--require=/tmp/untrusted.js',
        GIT_DIR: '/tmp/other-repository'
      },
      accountId,
      'explicit-token',
      '/private/tmp',
      '/private/wrangler-output.jsonl'
    )

    expect(environment.CLOUDFLARE_ACCOUNT_ID).toBe(accountId)
    expect(environment.CLOUDFLARE_API_TOKEN).toBe('explicit-token')
    expect(environment.WRANGLER_CI_OVERRIDE_NAME).toBeUndefined()
    expect(environment.CLOUDFLARE_API_BASE_URL).toBeUndefined()
    expect(environment.CLOUDFLARE_API_KEY).toBeUndefined()
    expect(environment.CF_API_TOKEN).toBeUndefined()
    expect(environment.NODE_OPTIONS).toBeUndefined()
    expect(environment.GIT_DIR).toBeUndefined()
    expect(environment.WRANGLER_SEND_METRICS).toBe('false')
  })

  it("filters Wrangler's session records but rejects unknown session schemas", () => {
    const session = {
      type: 'wrangler-session',
      version: 1,
      wrangler_version: '4.166.0',
      command_line_args: ['versions', 'upload'],
      log_file_path: null,
      timestamp: '2026-11-26T13:05:20.000Z'
    }
    const upload = {
      type: 'version-upload',
      version: 1,
      worker_name: 'mzm-identicon',
      worker_tag: null,
      version_id: null,
      worker_name_overridden: false,
      bundle_size: { raw_bytes: 2048, gzip_bytes: 512 },
      timestamp: '2026-11-26T13:05:20.000Z'
    }
    expect(
      parseStructuredOutput(
        `${JSON.stringify(session)}\n${JSON.stringify(upload)}\n`
      )
    ).toEqual([upload])
    expect(() =>
      parseStructuredOutput(
        `${JSON.stringify({ ...session, unrecognized: true })}\n`
      )
    ).toThrow(/unknown structured-output field/i)
    expect(() =>
      parseStructuredOutput(
        `${JSON.stringify({ ...session, timestamp: 'not-a-timestamp' })}\n`
      )
    ).toThrow(/unsupported schema/i)
  })

  it('requires the exact pinned Wrangler version rather than a matching substring', () => {
    expect(() =>
      assertPinnedWranglerVersion('4.166.0', '4.166.0')
    ).not.toThrow()
    expect(() =>
      assertPinnedWranglerVersion('4.166.0-beta.1', '4.166.0')
    ).toThrow(/exactly match/i)
  })

  it("checks both the exact release annotation and the Version's plain-text SHA binding", () => {
    const version = {
      id: 'fixture-version-id',
      annotations: { 'workers/message': releaseMessage },
      resources: {
        bindings: [
          {
            name: 'MZM_IDENTICON_RELEASE_SHA',
            type: 'plain_text',
            text: releaseSha
          }
        ]
      }
    }
    expect(() =>
      parseVersionView(
        JSON.stringify(version),
        'fixture-version-id',
        releaseMessage,
        releaseSha
      )
    ).not.toThrow()
    expect(() =>
      parseVersionView(
        JSON.stringify({ ...version, resources: { bindings: [] } }),
        'fixture-version-id',
        releaseMessage,
        releaseSha
      )
    ).toThrow(/release SHA binding/i)
  })
})

describe('pinned Wrangler deploy dry-run', () => {
  deployIntegrationTest(
    'runs the exact pinned CLI from a sticky temporary parent and cleans up',
    () => {
      const temporaryParent = mkdtempSync(
        join(tmpdir(), 'mzm-identicon-deploy-test-')
      )
      chmodSync(temporaryParent, 0o1777)
      const safeEnvironment = { ...process.env }
      delete safeEnvironment.CLOUDFLARE_API_TOKEN
      safeEnvironment.CLOUDFLARE_ACCOUNT_ID = accountId
      safeEnvironment.MZM_IDENTICON_PREFLIGHT_WORKERS_DEV = 'false'
      safeEnvironment.MZM_IDENTICON_PREFLIGHT_PREVIEW_URLS = 'false'
      safeEnvironment.TMPDIR = temporaryParent
      safeEnvironment.WRANGLER_CI_OVERRIDE_NAME = 'wrong-worker'
      safeEnvironment.CLOUDFLARE_API_BASE_URL =
        'https://attacker.invalid/client/v4'

      const result = spawnSync(
        process.execPath,
        [join(repositoryRoot, 'scripts/deploy.ts'), 'dry-run'],
        {
          cwd: repositoryRoot,
          encoding: 'utf8',
          env: safeEnvironment,
          maxBuffer: 2 * 1024 * 1024,
          timeout: 180_000
        }
      )

      expect(result.error).toBeUndefined()
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
      expect(readdirSync(temporaryParent)).toEqual([])
      rmdirSync(temporaryParent)
    }
  )

  deployIntegrationTest(
    'forwards SIGINT, confirms process-group termination, and cleans up',
    async () => {
      const temporaryParent = mkdtempSync(
        join(tmpdir(), 'mzm-identicon-deploy-signal-test-')
      )
      chmodSync(temporaryParent, 0o1777)
      const safeEnvironment = { ...process.env }
      delete safeEnvironment.CLOUDFLARE_API_TOKEN
      safeEnvironment.CLOUDFLARE_ACCOUNT_ID = accountId
      safeEnvironment.MZM_IDENTICON_PREFLIGHT_WORKERS_DEV = 'false'
      safeEnvironment.MZM_IDENTICON_PREFLIGHT_PREVIEW_URLS = 'false'
      safeEnvironment.TMPDIR = temporaryParent
      const child = spawn(
        process.execPath,
        [join(repositoryRoot, 'scripts/deploy.ts'), 'dry-run'],
        {
          cwd: repositoryRoot,
          env: safeEnvironment,
          stdio: ['ignore', 'pipe', 'pipe']
        }
      )
      let stdout = ''
      let stderr = ''
      let signalSent = false
      let timedOut = false
      const result = await new Promise<{
        code: number | null
        signal: NodeJS.Signals | null
      }>((resolvePromise) => {
        const timer = setTimeout(() => {
          timedOut = true
          child.kill('SIGKILL')
        }, 60_000)
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8')
          if (
            !signalSent &&
            stdout.includes('wrangler versions upload --dry-run')
          ) {
            signalSent = true
            child.kill('SIGINT')
          }
        })
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8')
        })
        child.once('close', (code, signal) => {
          clearTimeout(timer)
          resolvePromise({ code, signal })
        })
      })

      expect(timedOut, `${stdout}\n${stderr}`).toBe(false)
      expect(signalSent, `${stdout}\n${stderr}`).toBe(true)
      expect(result.code).not.toBe(0)
      expect(`${stdout}\n${stderr}`).toContain('interrupted by SIGINT')
      expect(readdirSync(temporaryParent)).toEqual([])
      rmdirSync(temporaryParent)
    }
  )
})
