# mzm-identicon

Identicon 生成サービス。Cloudflare Workers 上で `identicon@3.1.1` (Ajido/node-identicon) と互換の SVG を生成する。

## 仕様

- `GET /` → 200 `identicon`
- `GET /api/identicon/:id` → 150x150 の SVG（`image/svg+xml; charset=utf-8`）
- 空IDなどの不正入力は 400、未知パスは 404
- ヘッダ: `Cache-Control: public, max-age=31536000, immutable` / `X-Content-Type-Options: nosniff`

## 生成ロジック

- 入力文字列を UTF-8 で SHA-1（Web Crypto）
- 先頭4byte から signed 32bit code を生成し、center/corner/side の patch 種別・invert・rotation・前景色を `identicon@3.1.1` と同じビット位置から派生
- patch 配列は `identicon@3.1.1` の `patchTypes` をそのまま移植
- 3x3 のセル配置（center / side×4 / corner×4）を SVG の `<rect>` + `<polygon>` + `rotate()` で描画
- ユーザー入力はハッシュ計算のみに使用し、SVG 本文には埋め込まない（script / foreignObject / 外部 href は生成しない）

## 開発

```sh
npm install
npm run dev        # wrangler dev（ローカル）
npm test           # Vitest
npm run typecheck  # tsc --noEmit
npm run deploy     # wrangler deploy（要 CLOUDFLARE_API_TOKEN）
```

## デプロイ

`.github/workflows/cloudflare.yml` が GitHub Actions で typecheck / test / `wrangler deploy --dry-run` を実行する。本番デプロイは master への push のときのみ行われる（要 `CLOUDFLARE_API_TOKEN` secret）。

旧構成（Express / Cloud Run / Docker / canvas / ファイルシステムcache）は廃止済み。
