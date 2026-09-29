# Discord アプリの初期設定

CordScribe アプリの Application ID は `1552393241570050169`。Bot トークンは公開リポジトリやチャットに貼らず、Ryzen 機の `/home/natuki/cordscribe/runtime/bot.env` にだけ記入する。

1. [Discord Developer Portal の Bot 設定](https://discord.com/developers/applications/1552393241570050169/bot)でトークンを発行する。既存トークンを表示できない場合は「トークンをリセット」から新しいものを作る。再発行すると以前のトークンは無効になる。
2. 対象 Discord サーバー内で、VC 参加者が閲覧できる通常テキストチャンネルかVCチャットを開始時に選ぶ。サーバー設定で開発者モードを有効にし、サーバー ID を控える。会議の後続操作は開始チャンネルで行う。
3. [このアプリの招待リンク](https://discord.com/oauth2/authorize?client_id=1552393241570050169&scope=bot%20applications.commands&permissions=1166336)から対象サーバーへ追加する。要求権限は `View Channel`、`Connect`、`Send Messages`、`Attach Files`、`Read Message History`、`Embed Links`。非公開チャンネルではCordScribeロールに必要な権限を付ける。同じVCのチャットで開始する場合、そのVCに閲覧・接続に加えて送信・添付・履歴閲覧・埋め込みリンクも必要。
4. `runtime/bot.env`に `DISCORD_APPLICATION_ID=1552393241570050169`、`DISCORD_GUILD_IDS`（サーバーIDをカンマ区切り）、Bot トークン、`SUMMARY_MODE=off`を記入する。従来の`DISCORD_GUILD_ID`も単一サーバー用に利用できる。以前の`MEETING_CHANNEL_ID`は使わない。ファイルを所有者だけが読める `0600` にする。

Gateway Intent は `Guilds` と `GuildVoiceStates` のみ使用する。Bot の Presence、Server Members、Message Content の特権 Intent は有効化しない。コマンド登録は起動時に設定した各Guild限定で実行する。全サーバーを合わせて、録音・完了待ち処理中の会議は1件までとする。

招待後、Bot が対象 VC に参加できること、開始コマンドを実行した通常テキストチャンネルまたはVCチャットに案内と添付ファイルを投稿できることを実機試験で確認する。開始者を含むVC参加者全員が案内のボタンで同意する。会議中の発言が残るチャンネルなので、VC 参加者が見られることと、想定外のメンバーには見えないことをサーバー管理者が確認する。

## ぶいなびへの追加（2026-09-29）

既存サーバーとぶいなびを`DISCORD_GUILD_IDS=1053500294044074024,1227298476858015844`で許可し、両サーバー合計1会議、`SUMMARY_MODE=off`で配置した。両サーバーへのコマンド登録を確認済み。

| 対象チャンネル | 確認したBotの実効権限 |
| --- | --- |
| 作業VC ①・作業VC ②・限界作業部屋 | 閲覧、接続、送信、添付、履歴閲覧、埋め込みリンク |
| ぶいなび運営の雑談・共有用 | 閲覧、送信、添付、履歴閲覧、埋め込みリンク |

5チャンネルへのCordScribeロールの個別追加は利用者の承認後に行った。カテゴリ権限と非同期になるため、カテゴリと同期し直す場合は上記権限を再確認する。VCに参加し、いずれかの対象チャンネルで`/meeting start`を実行すると、実行者が参加しているVCで会議を開始する。開始者も案内のボタンで同意してから音声を取得する。停止は開始したチャンネルで`/meeting stop`を実行する。
