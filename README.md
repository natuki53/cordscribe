# CordScribe

Discord VCの参加者別音声を、本人が同意した時点から文字起こしするBotです。会議記録データを手動でAIへ渡せるMarkdownとして投稿します。仕様は[詳細設計 v0.1](docs/design-v0.1.md)を参照してください。

## できること

- 会議ごと、参加者ごとの明示的な同意と撤回
- 話者・経過時刻・発言ID・欠損箇所付きの全文`.md`をDiscordへ投稿
- 音声をRAMだけで処理し、Bot側の文字起こし本文を30日で削除
- 一部欠損・Bot再起動の記録と、部分会議記録の確定
- LLM連携は`SUMMARY_MODE=ollama`で明示的に有効化でき、既定では完全に無効

Discordに投稿済みの添付は、30日後も自動削除しません。開始コマンドを実行する通常テキストチャンネルまたはVCチャットは、VC参加者が閲覧できる場所を選んでください。

Discordアプリは作成済みです。導入時の操作は[Discordアプリの初期設定](docs/discord-setup.md)を参照してください。

## 必要なもの

- DiscordアプリとBotトークン、対象Guild ID
- RyzenホストのNVIDIA GPUとドライバ
- Docker Engine / Composeと、STT用のPython 3.12環境
- Botに対象VCの`View Channel`・`Connect`、開始コマンドを実行する通常テキストチャンネルまたはVCチャットの`View Channel`・`Send Messages`・`Attach Files`・`Read Message History`・`Embed Links`権限

非公開のVCや会議テキストチャンネルでは、サーバーへのBot招待時に選んだ権限だけでは足りません。各チャンネルの権限設定でCordScribeロールを追加し、上記の権限を許可してください。

Discordアプリを`bot`と`applications.commands`で対象Guildに追加します。Bot Gateway Intentは`Guilds`と`GuildVoiceStates`だけで、Message Content Intentは不要です。`/meeting`の操作ロールは不要です。開始は対象Guild内の通常テキストチャンネルまたはVCチャットから行えます。以後の操作と会議記録の投稿先は開始チャンネルです。

## ローカル開発

```text
npm ci
npm run check
```

Node.js 24が必要です。テストはDiscordやGPUに接続しません。音声受信の実機試験は別途行ってください。

ホスト上では`test/audio-smoke.mjs`でOpus変換と撤回時の破棄を確認できます。`test/ollama-smoke.mjs`と`test/gpu-handoff-smoke.mjs`は、将来LLM連携を有効にする場合だけ手動で実行する検証スクリプトです。

## Ryzenホストへの配置

以下はリポジトリを`/home/natuki/cordscribe`へ置いた場合の手順です。既存のOllama、Minecraft、CI VMは変更しません。

1. Python 3.12と`uv`を公式配布元から用意し、`uv python install 3.12`を実行します。
2. `mkdir -p runtime data models`で保存先を作り、`chmod 700 runtime data models`、`uv venv --python 3.12 stt/.venv`、`uv pip install --python stt/.venv/bin/python -r stt/requirements.txt`を実行します。GPU用cuBLASとcuDNN 9もこの環境に入ります。Pythonの版を変えた場合はsystemdの`LD_LIBRARY_PATH`を合わせてください。
3. `stt/env.example`を`runtime/stt.env`に、`.env.example`を`runtime/bot.env`にコピーします。後者へBotトークンとApplication ID・Guild IDを入力し、`SUMMARY_MODE=off`を維持して両ファイルを`chmod 600`にします。これらはGitへ追加しません。
4. `deploy/cordscribe-stt.service`を`/etc/systemd/system/cordscribe-stt.service`へ配置し、`sudo systemctl daemon-reload && sudo systemctl enable --now cordscribe-stt`を実行します。初回はWhisperモデルの取得が必要です。
5. `curl http://127.0.0.1:8765/ready`で`ready: true`を確認します。
6. `docker compose up -d --build`でBotを起動し、`docker compose logs --tail=100 bot`に`CORDSCRIBE_READY`があることを確認します。

`compose.yaml`はホストネットワークを使います。BotがループバックのSTTにアクセスするためで、HTTPポートを外部公開する設定はありません。自宅サーバー用Composeは`SUMMARY_MODE=off`を明示的に固定しており、`runtime/bot.env`にOllama設定が残っていてもBotはOllamaへ接続しません。BotのSQLiteは`./data`にのみ書き込みます。`runtime`と`data`は`natuki`（UID 1000）だけが読めるようにしてください。

STTは起動時にGPUへロードし、会議がなければ5分後に自動解放します。録音中はBotがロード状態を維持し、停止後に即時解放します。
会議開始時はWhisperの準備だけを確認します。ほかのサービスが同じGPUを使う場合、その負荷は別途実機で確認します。

起動順はSTT、Botです。停止時は`docker compose stop bot`、`sudo systemctl stop cordscribe-stt`の順です。Botは進行中の会議をDrainしてから終了しますが、強制終了でRAM上の音声が失われた場合は次回起動時に`LOST`として記録します。

## 操作

VC参加者が、対象Guild内の通常テキストチャンネルまたはVCチャットで`/meeting start`を実行します。記録対象は実行者が参加中のVCです。開始時点のVC参加者全員が閲覧できるチャンネルを選んでください。コマンド実行者は開始時に同意済みとなり、ほかの参加者は同じチャンネルに出る案内のボタンで同意・拒否・撤回を選びます。停止は開始チャンネルから`/meeting stop`です。停止後の処理は非同期で、同じチャンネルの`/meeting status`で待ち行列を確認できます。

Botクラッシュ後は`/meeting finalize id:<会議ID>`で欠損を明示した部分会議記録を作成します。投稿済みファイルは`/meeting transcript`で確認できます。`/meeting delete`はBotの投稿を削除したうえで会議DBを削除します。Discordの利用者が既にダウンロードした添付ファイルは回収できません。

要約が必要なときは添付された`.md`を手動でAIへ渡してください。Bot側での自動要約は既定で無効です。将来別の配置で利用する場合は`SUMMARY_MODE=ollama`と`OLLAMA_BASE_URL`・`OLLAMA_MODEL`を設定できます。自宅サーバー用Composeでは`off`に固定しているため、そこで有効化するにはComposeの設定変更も必要です。有効化時のみBotはOllamaへ接続し、`/meeting regenerate`も表示されます。

## 保守・バックアップ

- ログに発言本文は出しません。`docker compose logs bot`と`journalctl -u cordscribe-stt`で状態コードを確認します。
- SQLiteはWALを使います。稼働中に`.sqlite`ファイルだけをコピーするバックアップは作らず、停止中に`data`ディレクトリ全体を保護された場所へコピーするか、SQLiteのオンラインバックアップ機能を使います。
- バックアップにも文字起こし本文が含まれます。30日の保存期限を守るため、長期保存せず、復旧作業後にバックアップを削除してください。復旧したDBでも起動時の期限処理が走ります。
- モデル・依存ライブラリ更新時は実VCで音声受信、同意、再接続、停止、Markdown添付の投稿を再試験します。

## 実機受け入れ試験

2〜8人の同時発話と既存AIチャットBotの同時利用で、GPUメモリ不足や無告知の音声欠損がないことを確認します。代表的な1時間の会議で、停止後30分以内にMarkdownの会議記録が投稿されることを公開条件とします。

録音は最長8時間です。3時間超の会議でも発言時刻を`時:分:秒`で記録し、発言IDと欠損状態を保ちます。手動で使うAIの入力上限を超える場合は添付の時系列を区切って渡してください。過去に行った任意のLLM連携の合成会議評価は[長時間会議の評価](docs/long-meeting-benchmark.md)に残しています。実VCでの3時間超の処理時間は未確認です。

現在の実機結果と未完了項目は[受け入れ記録](docs/acceptance.md)を参照してください。3時間超を想定した5件の合成データと分析は[長時間会議の評価](docs/long-meeting-benchmark.md)にあります。
