# Projektor 最初の縦断: Issue.UpdateTitle

## 結果と位置づけ

ゼロベース設計 v0.3 から新規に書いた、単一 synthetic workspace の原子的 command 境界のローカル検証。既存の業務コードは流用していない。REST 形 / MCP 形 adapter は共通 executeCommand を呼び、実際の Node SQLite ファイルを更新する。Node suite の REST/MCP adapter 試験は protocol shape の契約試験である。追加の workerd suite は local HTTP→DO RPC を通す実 runtime 試験（後述）。実際の MCP wire protocol と production HTTP/authentication は未検証。

## 再現

Node 24.19.0 以上で、リポジトリーのルートから実行する。Node SQLite 試験だけなら追加依存は不要。workerd 試験は lockfile 固定の Miniflare を使う。

```sh
cd experiments/atomic-command-poc
npm ci
npm run test:all
```

Node suite は `node:sqlite` / `node:test` / `worker_threads` を使い、追加 package は不要。workerd suite は Miniflare と実 workerd runtime を使う。Node テストは synthetic
fixture を `evidence/` 下に作成して終了時に削除する。SQLite experimental
warning はテスト失敗ではない。既存アプリ、DB、production build には接続しない。

任意で `node scripts/verify.mjs` を実行すると、ローカルの `TEST-RESULTS.json`、
`evidence/node.tap`、`evidence/workerd.tap`、`SHA256SUMS` を生成する。これらは実行ごとに変わるため
コミットしない。このスクリプトの `limitations` はローカル試験の範囲を示し、GitHub CI
の実行結果は各 PR のチェックで確認する。

PR 用の専用 CI は変更パスを限定し、Node 24.19.0 で同じ `node --test` を実行する。
既存の全体 CI はそのまま維持する。専用 CI は read-only 権限で、秘密情報、外部サービス、
デプロイを必要としない。

## 所有する狭い契約

- schemaVersion=1、commandType=Issue.UpdateTitle のみ
- workspaceId/workspaceEpoch/operationId/entityId は小文字 UUIDv4。operationId は呼出側が CSPRNG で作る前提
- expectedVersion は正の安全な整数。欠落は PRECONDITION_REQUIRED
- payload は title 一つだけ。UTF-8 4096 bytes 以内、well-formed Unicode。空白のみ title は typed domain rejection
- fingerprint は command-json-v1 の key 順ソート JSON + SHA-256。principal、schema、workspace、epoch、target、expectedVersion、payload、operation ID を含む。transport、requestId、credential ID、送信時刻を含まない
- Unicode、改行、title の空白を正本保存時に正規化しない。FTS projection だけ NFKC/lowercase
- ActorContext は trusted fixture 入力。HTTP/MCP body から受けない。署名検証や provider 認証の代替ではない
- workspace、fresh-incarnation 一致、active fence、current credential expiry/revocation、membership を transaction 内で確認
- 同じ principal の既存 receipt は現在の read/operations:read_own 権限、元 project と現在 project を検査後に返す。write 権限は replay に再要求しない
- 新規 command は current write + read grant と CAS を確認。typed 拒否は receipt のみ commit。予期しない例外は全 rollback
- canonical issue/version、workspace changeSeq、Activity、FTS DELETE→INSERT、outbox、committed receipt が同一 transaction（Node は BEGIN IMMEDIATE、DO は storage.transactionSync）
- success receipt は過去の committedVersion を表す。最新 GET の version と混同しない
- response loss は outcome=unknown。rollback 成功を確認した例外は今回試行の attemptOutcome=not_committed を別記するが、元操作の outcome は unknown のまま。rollback まで失敗した場合は attemptOutcome も unknown
- operation_get の not_observed は永続的未実行証明ではない
- 認可された空一覧は items=[] / nextCursor=null。read scope のない credential は FORBIDDEN

request 単体の schema/route/header 不整合、KEY_REUSE、認可や receipt ACL の照合拒否も、過去の元操作が未実行とは断定せず outcome=unknown、effectApplied は省略する。

transaction で新たに確定した rejected receipt だけ outcome=rejected とする。rejected receipt には入力本文を保存せず error code / effectApplied=false を返す。対象不存在の拒否は現在も workspace membership + read credential + read_own がある元 principal に generic NOT_FOUND を返す。UpdateTitle 以外の create、bulk、move command、監査 role、deleted-resource/history read は実装範囲外。soft-deleted 対象の古い成功 receipt は fail-closed にする。過去に権限があって受領済みの情報を回収する保証はしない。

## 試験の読み方

`node --test` の出力（CI ではジョブログ）がその実行の証跡。検証内容:

1. REST/MCP の機械可読結果一致、parameter SQL、title 原文保全
2. 100 worker threads / 100 独立 connection を全員 ready の barrier 後に解放。同一 ID 100 要求で effect/version/sequence/Activity/outbox/receipt が一回だけ
3. 異 payload 同 ID、および別 ID 同 expectedVersion の独立 connection 競合
4. stale CAS、title 拒否、rejected receipt 照合、hash/schema/Unicode/改行差
5. commit 後応答喪失→同 ID 照合/replay、v8 receipt と現在 v9
6. mutation の前、issue 後、sequence 後、Activity 後、FTS delete 後、FTS insert 後、outbox 後、receipt 後の計8地点 throw に対し全テーブルの前後 snapshot 一致
7. 同 principal の current project/read-own/membership/credential 剥奪で receipt 非開示。project 移動時の双方 scope、削除時の fail-closed
8. 別 actor、別 workspace、期限切れ、旧 epoch、inactive store の停止
9. 真の空 read と認証/権限失敗の区別
10. SQLite WAL、synchronous=FULL、integrity_check、別接続での commit 読取り

100 件は Promise 同期 queue の見かけの並列ではない。ただし SQLite が BEGIN IMMEDIATE で write transaction を直列化するため、これは SQLite のファイル lock とこの transaction 境界の競合試験であり、Cloudflare DO scheduling、分散競合、性能 SLO の証明ではない。

## 検証限界と次の gate

Node 試験に加え、下記の actual workerd SQLite 試験を実行した。provider 認証、browser、負荷/容量/料金、disk-full、OS/hardware power loss、本番、migration/restore、旧 writer fence は未検証。WAL/FULL は Node 側のみの設定。DO の durability は clean restart 後の再読取りまでで、Cloudflare 本番の分散永続性を実証したとはしない。

receipt はこの PoC では削除・期限切れさせない。90日 compaction、長期 retention、backup/restore 時の独立 incarnation 発行と現認可再構築は未実装。outbox は pending 行を原子的に作るだけで配信しない。検索は FTS projection 一致を検証するだけで製品検索 API、短語 byte bound、rebuild は未実装。DDL は初期 schema migration のみ。

本番置換の完成ではない。Node とローカル workerd の狭い契約試験であり、必須 capability 全体、認証境界、UI、移行・本番切替の gate は残る。


## SQLite-backed Durable Object / workerd adapter

- `src/shared-core.mjs` が両 runtime 共通の validation/fingerprint/domain/CAS/ACL/receipt ロジック。`src/core.mjs` は Node SQLite の開き方・migration だけを追加する
- `workerd/adapter.mjs` は実 `storage.sql.exec` を使う statement adapter と DO class。`storage.transactionSync` の synchronous callback 内で全 read/write を完結し、await・外部 I/O を入れない
- DO DDL は同じ `schema.sql`。Node 専用 PRAGMA は Node entrypoint に分離した。DO は SQLite foreign key enforcement を使い、BEGIN/COMMIT SQL を送らない
- `rowsWritten` は index 等の内部書込みも数えるため、業務 row-count invariant には `SELECT changes()` を使う
- callback exception の rollback 保証だけ `attemptOutcome=not_committed`。それ以外の storage transaction 例外は unknown。どちらも元 operation の outcome は unknown のまま
- `workerd/harness.mjs` は synthetic identity、SQL fixture 管理、fault injection だけの TEST ONLY entrypoint。production fetch/authentication/deployment config は存在しない。これを production 公開してはならない
- stable Miniflare `4.20260730.0` を exact pin。調査時 latest tag は `5.20261006.0-alpha` だったため採用しなかった。lockfile と実 binary の SHA は verification evidence に記録する

20 workerd tests は Node `node:test` から Miniflare の actual workerd process を起動する。DO storage mock は使わない。8 mutation fault points の全 snapshot rollback、16 concurrent HTTP→RPC 同 ID 配信の effect 一回、別 ID CAS 競合、typed rejection receipt、receipt ACL、current query 非開示、commit 後 storage.sync 完了から RPC exception を注入した応答喪失、同 ID retry の receipt 読取り前 rollback、clean process restart 後 replay を含む。

16 concurrent delivery はローカル HTTP と DO RPC scheduling の範囲である。production network retry、packet loss、跨 host race の検証ではない。response-loss fixture は意図的な post-commit exception であり、実際の packet drop ではない。clean restart は abrupt kill や power failure の試験ではない。ストレージ本体が callback 外で失敗する経路は actual runtime で未注入。

この adapter は既存 title PoC の project ACL に限定する。v0.4 resource ACL / immutable revision / historical audience / no-op semantics の全実装を主張しない。Activity はこの title command の before/after 履歴であり、一般 ContentRevision 機構ではない。

現行公式資料（2026-10-07 閲覧）:
- https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/ （transactionSync、cursor、sync）
- https://developers.cloudflare.com/workers/testing/miniflare/ （actual workerd の local testing）
- https://developers.cloudflare.com/workers/testing/vitest-integration/write-your-first-test/ （現行 Vitest integration。今回の runner は Node＋Miniflare）
- https://developers.cloudflare.com/durable-objects/examples/testing-with-durable-objects/
