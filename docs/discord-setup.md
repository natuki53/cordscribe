# Discord アプリの初期設定

CordScribe アプリの Application ID は `1552393241570050169`。Bot トークンは公開リポジトリやチャットに貼らず、Ryzen 機の `/home/natuki/cordscribe/runtime/bot.env` にだけ記入する。

1. [Discord Developer Portal の Bot 設定](https://discord.com/developers/applications/1552393241570050169/bot)でトークンを発行する。既存トークンを表示できない場合は「トークンをリセット」から新しいものを作る。再発行すると以前のトークンは無効になる。
2. 対象 Discord サーバーに、VC 参加者が閲覧できる議事録用テキストチャンネルを用意する。サーバー設定で開発者モードを有効にし、サーバーとチャンネルの各 ID を控える。会議チャンネルを閲覧できるメンバーは全員`/meeting`を操作できるため、閲覧権限を運用に合わせて設定する。
3. [このアプリの招待リンク](https://discord.com/oauth2/authorize?client_id=1552393241570050169&scope=bot%20applications.commands&permissions=1166336)から対象サーバーへ追加する。要求権限は `View Channel`、`Connect`、`Send Messages`、`Attach Files`、`Read Message History`、`Embed Links`。非公開チャンネルでは、対象VCと会議テキストチャンネルの両方にCordScribeロールを追加し、VCで閲覧・接続、会議テキストチャンネルで閲覧・送信・添付・履歴閲覧・埋め込みリンクを許可する。
4. `runtime/bot.env`に `DISCORD_APPLICATION_ID=1552393241570050169`、Guild ID、会議チャンネル ID、Bot トークンを記入する。ファイルを所有者だけが読める `0600` にする。

Gateway Intent は `Guilds` と `GuildVoiceStates` のみ使用する。Bot の Presence、Server Members、Message Content の特権 Intent は有効化しない。コマンド登録は起動時に対象 Guild 限定で実行する。

招待後、Bot が対象 VC に参加できること、議事録チャンネルに案内と添付ファイルを投稿できることを実機試験で確認する。会議中の発言が残るチャンネルなので、VC 参加者が見られることと、想定外のメンバーには見えないことをサーバー管理者が確認する。
