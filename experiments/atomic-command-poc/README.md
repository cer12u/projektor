# Projektor 最初の縦断: Issue.UpdateTitle

## 結果と位置づけ

ゼロベース設計 v0.3 から新規に書いた、単一 synthetic workspace の原子的 command 境界のローカル検証。既存の業務コードは流用していない。REST 形 / MCP 形 adapter は共通 executeCommand を呼び、実際の Node SQLite ファイルを更新する。HTTP server や実際の MCP server を起動した統合試験ではなく、protocol shape の契約試験である。

## 再現

Node 24.19.0 以上で、リポジトリーのルートから実行する。追加依存は不要。

```sh
cd experiments/atomic-command-poc
node --test test/*.test.mjs
```

`node:sqlite` / `node:test` / `worker_threads` のみを使う。テストは synthetic
fixture を `evidence/` 下に作成して終了時に削除する。SQLite experimental
warning はテスト失敗ではない。既存アプリ、DB、production build には接続しない。

任意で `node scripts/verify.mjs` を実行すると、ローカルの `TEST-RESULTS.json`、
`evidence/final-test.tap`、`SHA256SUMS` を生成する。これらは実行ごとに変わるため
コミットしない。このスクリプトの `notRun` はローカル試験の範囲を示し、GitHub CI
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
- canonical issue/version、workspace changeSeq、Activity、FTS DELETE→INSERT、outbox、committed receipt が同一 BEGIN IMMEDIATE transaction
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

node:sqlite は実 DB だが正式採用候補の SQLite-backed DO / workerd ではない。Cloudflare output gate / storage.sync、provider 認証、browser、負荷/容量/料金、disk-full、OS/hardware power loss、本番、migration/restore、旧 writer fence は未検証。WAL/FULL の設定と正常な接続間可視性しか durability に関して主張しない。

receipt はこの PoC では削除・期限切れさせない。90日 compaction、長期 retention、backup/restore 時の独立 incarnation 発行と現認可再構築は未実装。outbox は pending 行を原子的に作るだけで配信しない。検索は FTS projection 一致を検証するだけで製品検索 API、短語 byte bound、rebuild は未実装。DDL は初期 schema migration のみ。

本番置換の完成ではない。SQLite の契約試験に限定した実験であり、次の runtime gate は
SQLite-backed Durable Object / workerd 上で同じ契約を実証すること。
