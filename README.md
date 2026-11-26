# mzm-identicon

Identicon 生成サービス

## development

```sh
npm install
npm run dev        # wrangler dev（ローカル）
npm test           # Vitest
npm run typecheck  # tsc --noEmit
```

## Production deployment

Production deploys must run from a clean `verify/<release>` checkout. The checked-in route-bearing config is never passed directly to Wrangler; the repository wrapper creates a private route-free config, keeps remote variables, uploads and verifies the exact release SHA (including the marker binding), then explicitly promotes that Version to 100% traffic. Before upload, before promotion, and after deployment it read-backs the selected account, Worker, Custom Domain, exposure settings, overlapping routes, relevant DNS records, and Worker secret names; it refuses any mismatch or change.

The production wrapper performs authenticated read-only API checks before upload, before promotion, and after deployment, including the account/zone match and disabled exposure settings. Set `CLOUDFLARE_ACCOUNT_ID` from the intended account's preflight. For the credential-free local dry-run only, provide the observed disabled exposure flags. Then run:

```sh
CLOUDFLARE_ACCOUNT_ID=<verified-account-id> MZM_IDENTICON_PREFLIGHT_WORKERS_DEV=false MZM_IDENTICON_PREFLIGHT_PREVIEW_URLS=false npm run deploy:dry-run
CLOUDFLARE_ACCOUNT_ID=<verified-account-id> op run -- npm run deploy
```

`op run` must inject `CLOUDFLARE_API_TOKEN` from the operator's approved 1Password item. Do not store the account ID or token in this repository. The deploy wrapper refuses a dirty checkout, an unexpected Worker name, route-bearing config, or a Wrangler version that does not exactly match the lockfile. `npm run test:deploy` runs the pinned local Wrangler dry-run integration test and requires the same clean verification checkout and account-ID environment variable.
