# ASR評価フィクスチャ

音声ファイルは同意済みの評価用データだけを`audio/`へ配置し、正解文をmanifestへ人手で記録する。実会議音声やBotトークンをGitへ追加しない。`manifest.example.json`をコピーし、通常会話、長文、100〜500msの短文、固有名詞、無音、キーボード・マウス音、小声、大音量を区別する。同時発話はDiscordの話者別ストリームごとに別ファイルとして登録する。

例:

```bash
python stt/benchmark.py stt/fixtures/asr/manifest.json \
  --model turbo:int8_float16:1 \
  --model large-v3:int8_float16:1 \
  --hotwords 'VRChat、VNavi、CordScribe、WordPress、Search Console' \
  --output stt/fixtures/asr/result.json
```

出力には各サンプルのCER、WER、処理時間、RTF、音量指標、hallucination疑いと、モデル別の空転写・非発話hallucination件数、GPU使用量スナップショットを含む。日本語では`meanCer`を主指標とする。
