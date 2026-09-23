# CordScribe

Discord VCの参加者別音声を、本人が同意した時点から文字起こしして議事録にするBotです。初回リリースの仕様は[詳細設計 v0.1](docs/design-v0.1.md)を参照してください。

## できること

- 会議ごと、参加者ごとの明示的な同意と撤回
- 話者・時刻・発言ID付きの全文`.txt`と、根拠発言ID付き要約のDiscord投稿
- 音声をRAMだけで処理し、Bot側の文字起こし本文を30日で削除
- 一部欠損・Bot再起動・要約失敗の記録と、部分議事録の確定

Discordに投稿済みの全文と要約は、30日後も自動削除しません。会議用テキストチャンネルの閲覧権限を参加者に合わせて設定してください。

Discordアプリは作成済みです。導入時の操作は[Discordアプリの初期設定](docs/discord-setup.md)を参照してください。

## 必要なもの

- DiscordアプリとBotトークン、対象Guild ID、操作ロールID、会議用テキストチャンネルID
- RyzenホストのNVIDIA GPU、ドライバ、Ollama（ループバックの`127.0.0.1:11434`）
- Docker Engine / Composeと、STT用のPython 3.12環境
- Botに対象VCの`View Channel`・`Connect`、会議テキストチャンネルの`View Channel`・`Send Messages`・`Attach Files`・`Read Message History`権限

Discordアプリを`bot`と`applications.commands`で対象Guildに追加します。Bot Gateway Intentは`Guilds`と`GuildVoiceStates`だけで、Message Content Intentは不要です。操作ロールはBotに付けるロールではなく、`/meeting`を使う人のロールです。

## ローカル開発

```text
npm ci
npm run check
```

Node.js 24が必要です。テストはDiscordやGPUに接続しません。音声受信の実機試験は別途行ってください。

## Ryzenホストへの配置

以下はリポジトリを`/home/natuki/cordscribe`へ置いた場合の手順です。既存のOllama、Minecraft、CI VMは変更しません。

1. Python 3.12と`uv`を公式配布元から用意し、`uv python install 3.12`を実行します。
2. `mkdir -p runtime data models`で保存先を作り、`chmod 700 runtime data models`、`uv venv --python 3.12 stt/.venv`、`uv pip install --python stt/.venv/bin/python -r stt/requirements.txt`を実行します。GPU用cuBLASとcuDNN 9もこの環境に入ります。Pythonの版を変えた場合はsystemdの`LD_LIBRARY_PATH`を合わせてください。
3. `stt/env.example`を`runtime/stt.env`に、`.env.example`を`runtime/bot.env`にコピーします。後者へBotトークンと4つのDiscord IDを入力し、両ファイルを`chmod 600`にします。これらはGitへ追加しません。
4. `deploy/cordscribe-stt.service`を`/etc/systemd/system/cordscribe-stt.service`へ配置し、`sudo systemctl daemon-reload && sudo systemctl enable --now cordscribe-stt`を実行します。初回はWhisperモデルの取得が必要です。
5. `curl http://127.0.0.1:8765/ready`で`ready: true`を確認します。
6. `docker compose up -d --build`でBotを起動し、`docker compose logs --tail=100 bot`に`CORDSCRIBE_READY`があることを確認します。

`compose.yaml`はホストネットワークを使います。BotがループバックのSTTとOllamaにアクセスするためで、HTTPポートを外部公開する設定はありません。BotのSQLiteは`./data`にのみ書き込みます。`runtime`と`data`は`natuki`（UID 1000）だけが読めるようにしてください。

STTは起動時にGPUへロードし、会議がなければ5分後に自動解放します。録音中はBotがロード状態を維持し、停止後に即時解放します。

起動順はSTT、Botです。停止時は`docker compose stop bot`、`sudo systemctl stop cordscribe-stt`の順です。Botは進行中の会議をDrainしてから終了しますが、強制終了でRAM上の音声が失われた場合は次回起動時に`LOST`として記録します。

## 操作

操作ロールを持つVC参加者が、会議用テキストチャンネルで`/meeting start`を実行します。参加者は案内メッセージで同意・拒否・撤回を選びます。停止は`/meeting stop`です。停止後の処理は非同期で、`/meeting status`で待ち行列を確認できます。

Botクラッシュ後は`/meeting finalize id:<会議ID>`で部分議事録を作成します。要約だけが失敗した場合は`/meeting regenerate id:<会議ID>`を実行します。`/meeting delete`はBotが投稿した全文・要約を削除したうえで会議DBを削除します。Discordの利用者が既にダウンロードした添付ファイルは回収できません。

## 保守・バックアップ

- ログに発言本文は出しません。`docker compose logs bot`と`journalctl -u cordscribe-stt`で状態コードを確認します。
- SQLiteはWALを使います。稼働中に`.sqlite`ファイルだけをコピーするバックアップは作らず、停止中に`data`ディレクトリ全体を保護された場所へコピーするか、SQLiteのオンラインバックアップ機能を使います。
- バックアップにも文字起こし本文が含まれます。30日の保存期限を守るため、長期保存せず、復旧作業後にバックアップを削除してください。復旧したDBでも起動時の期限処理が走ります。
- モデル・依存ライブラリ更新時は実VCで音声受信、同意、再接続、停止、全文と要約の投稿を再試験します。

## 実機受け入れ試験

2〜8人の同時発話と既存AIチャットBotの同時利用で、GPUメモリ不足や無告知の音声欠損がないことを確認します。代表的な1時間の会議で、停止後30分以内に全文と要約が投稿されることを公開条件とします。`qwen3.5:9b`で満たせない場合は`OLLAMA_MODEL=qwen3.5:4b`で同じ試験を行います。
