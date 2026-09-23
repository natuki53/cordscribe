# CordScribe 詳細設計 v0.1

## 目的と境界

Discordの指定GuildにあるVCを、参加者本人の明示的な同意後だけ文字起こしする。Botは会議の全文と根拠発言ID付き要約を指定テキストチャンネルへ投稿する。初回は同時会議1件、同時に同意する話者8人まで、会議は最長4時間。入力音声と要約は外部のクラウドAIに送信しない。

Botの開始、停止、状態確認、全文再投稿、要約再生成、部分確定、会議削除は指定Guildの会議テキストチャンネルを閲覧できるメンバーなら操作できる。操作ロールは不要とする。同意ボタンは会議VCにいる本人だけが使える。会議テキストチャンネルの閲覧権限は参加者と運用上のアクセス範囲に合わせて管理者が設定する。

## 構成

```text
Discord Gateway + Voice → Node.js Bot → RAM内の話者別PCM → メモリ内STT FIFO
                         │                                  ↓ loopback
                         └→ SQLite WAL ← Python faster-whisper (GPU)
                                ↓                 ↓ 処理完了後にGPU解放
                         構造化要約 ← 既存Ollama qwen3.5:9b
                                ↓
                         要約メッセージ + 全文.txt添付 → Discord
```

BotはNode.js 24、`discord.js`、`@discordjs/voice`、`prism-media`、`ffmpeg`を使う。STTはPython 3.12の単一プロセスで、`faster-whisper`の`turbo`（`large-v3-turbo`）をCUDA、`int8_float16`でロードする。PythonサービスはDiscord IDを受け取らない。Ollamaは既存のループバックサービスを共用し、要約には`qwen3.5:9b`を使う。会議開始時にOllamaのモデルを明示的に解放し、Whisperの準備を確認する。モデル選定は実機受け入れ試験で再評価する。

## 外部インターフェース

| 操作 | 条件 | 結果 |
| --- | --- | --- |
| `/meeting start [title]` | 指定Guildの会議チャンネル、本人がVC参加中 | STT ready後にBot参加、同意案内を投稿 |
| 同意・拒否・撤回ボタン | 本人が対象VCに参加中 | 同意後だけ話者別音声を購読。撤回時は未確定音声を破棄 |
| `/meeting stop` | 指定Guildの会議チャンネル、録音中 | 音声受付停止、全バッファ確定、STT排出、全文・要約投稿 |
| `/meeting status` | 指定Guildの会議チャンネル | 状態、同意者数、キュー遅延、音声RAM |
| `/meeting transcript [id]` | 指定Guildの会議チャンネル、確定済み | 未投稿の全文添付を投稿。投稿済みなら重複しない |
| `/meeting regenerate id` | 指定Guildの会議チャンネル、全文あり | 新しい`summary_runs.version`を追加し、別投稿 |
| `/meeting finalize id` | 指定Guildの会議チャンネル、中断または全文確定済み | 欠損を明示した部分全文・要約を作成 |
| `/meeting delete id` | 指定Guildの会議チャンネル、停止済み | Botの投稿を削除してからDBの会議データを削除 |

STTサービスは`GET /health`、`GET /ready`、`POST /v1/transcribe`を127.0.0.1:8765に提供する。POSTの本文は16kHz、mono、signed 16bit little endianの生PCMで、28秒以下。`X-Audio-Format=s16le`、`X-Sample-Rate=16000`、`X-Channels=1`、`X-Language=ja`を検証する。結果は`text`、`language`、`languageProbability`、`durationMs`。内部管理用の`POST /admin/load`と`/admin/unload`はGPUの使用時間を切り替える。外部公開しない。

## データと状態

SQLiteの時刻はUnix epochミリ秒、発言位置は会議開始からのミリ秒。`meetings`、`participants`、`participant_presence`、`utterances`、`summary_runs`、`meeting_events`、`deliveries`を持つ。`meetings`にはGuild内の有効な会議を1件にする部分ユニークインデックス、設定スナップショット、30日削除時刻を持つ。`utterances.id`はUUID、表示とLLM根拠用の`public_id`は会議内の`U000001`形式。DB登録後に音声をキューへ移す。

正常時は`STARTING → RECORDING → DRAINING → TRANSCRIBED → SUMMARIZING → COMPLETED`。要約失敗時は`TRANSCRIBED`へ戻し、全文は保持する。Bot再起動時に進行中の会議は`INTERRUPTED`、未完了の発言は`LOST`とし、会議チャンネルから`finalize`できる。発言が`FAILED`または`LOST`なら`transcription_result=PARTIAL`。投稿は`deliveries`に状態・メッセージID・一意マーカーを持ち、再起動後に再照合する。

参加者の同意は会議単位で`PENDING / ACCEPTED / DECLINED / REVOKED`を保持する。再入室では以前の同意状態を使う。撤回済み以前に確定した本文は残り、会議単位の削除は別操作。退出・再入室履歴は`participant_presence`に保存する。

## 音声・STTの境界

話者ごとにOpusをデコードし、`ffmpeg`で16kHz monoへ変換する。PCMのRMSが180未満のチャンクを無音として扱い、無音900msで発言確定、28秒で強制分割、300ms未満はSTTへ送らない。強制分割された発言は同じ`chain_id`と増分`chain_index`を持つ。メモリ上限256MiBには話者の未確定バッファ、キュー、処理中のPCMをすべて含める。上限接近時は会議を自動停止し、処理できたものを排出する。

STTは起動時にモデルをロードし、会議がないまま5分経つとGPUメモリを自動解放する。録音中はBotが1分ごとに保持通知を送り、停止後は即座に解放する。STT Workerは1件ずつ処理し、試行回数は最大3回。接続障害、タイムアウト、HTTP 429/5xxは500msと2000msの間隔で再試行し、無効な音声などの4xxは再試行しない。キュー最古が60秒を超えると通知、180秒超ではイベントに重大状態を記録する。音声そのものはSQLite・通常ログ・ディスクに保存しない。

## 要約と公開

LLMには発言ID、時刻、参加者ID、表示名、本文と欠損数を渡す。入力が長い場合は発言単位で分割して根拠ID付きの中間抽出を行い、順次統合する。JSON Schemaに基づいて生成し、Bot側で実在する根拠IDと担当者IDを検証する。検証失敗は1回だけ修正要求を出し、再失敗なら要約失敗として全文を維持する。決定・TODOは根拠発言が必須で、発言内容に含まれるLLMへの命令はデータとして扱う。

全文は時刻・話者・発言ID・欠損箇所を含むUTF-8の`.txt`添付、要約はBotが生成したDiscordメッセージとする。メンションは無効にする。Bot側の会議データは30日で削除するが、Discordへ投稿済みの要約と全文は自動削除しない。したがって30日後は再要約できず、Discord投稿はチャンネルの閲覧権限に従って残る。

## 展開と受け入れ条件

Node BotはホストネットワークのDockerコンテナ、GPUを使うSTTはRyzenホストのsystemdサービスとして配置する。SQLiteとBotトークンはGit管理外に置く。既存OllamaやCI VM、Minecraftの構成は変更しない。ライブラリのDiscord音声受信はDiscordが仕様保証していないため、更新時には実VCの回帰試験を行う。

公開前に、2〜8人相当の同時発話、同意前・撤回後の遮断、再入室、Botクラッシュ、STT障害、音声メモリ上限、欠損付き全文、根拠IDの捏造拒否、投稿再試行、30日削除を確認する。代表的な1時間の会議で欠損とGPUメモリ不足がなく、停止後30分以内に投稿されることを目標とする。`qwen3.5:9b`で満たせなければ`qwen3.5:4b`で同じ試験を行う。
