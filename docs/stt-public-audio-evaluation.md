# 公開音声によるSTT予備評価（2026-09-27）

個人の会議音声を保存・閲覧せずに、Ryzen機上の認識設定を比較した。これは実際のDiscordマイク音声の精度を保証する試験ではない。

## 音声と測定方法

- 日本語発話: [Kokoro Speech Datasetの100件サンプル](https://github.com/kaiidams/Kokoro-Speech-Dataset)から、ID順の一覧を固定乱数シード42で抽出した12件。付属の`metadata.csv`を正解文とした。元データは文学作品の読み上げで、会議の会話体ではない。正解文にも自動整列による誤りがあり得る。
- 非発話: Wikimedia Commonsの[Cough 2](https://commons.wikimedia.org/wiki/File:Cough_2.ogg)、[Short coughs](https://commons.wikimedia.org/wiki/File:Short_coughs.ogg)、[Man coughing](https://commons.wikimedia.org/wiki/File:Man_coughing.ogg)、[Sneezing](https://commons.wikimedia.org/wiki/File:Sneezing.ogg)、[Sneeze](https://commons.wikimedia.org/wiki/File:Sneeze.ogg)の5件。
- すべて16kHz・モノラルに変換した。同じ12件について、全角・半角を正規化し、空白と句読点を除いた文字誤り率（CER）を集計した。Whisper系には本番と同じSilero VAD（最小発話250ms、無音500ms、前後150ms）を適用した。数値はモデル読み込み時間を含まない。
- `SenseVoiceSmall`は[sherpa-onnxのint8変換モデル](https://k2-fsa.github.io/sherpa/onnx/sense-voice/pretrained.html)をCPU 2スレッド、日本語指定で試した。これは本番環境へ組み込んでいない。
- 日本語向けの[Kotoba Whisper v2.0 faster](https://huggingface.co/kotoba-tech/kotoba-whisper-v2.0-faster)も同じ`faster-whisper`とGPU設定で試した。こちらも本番環境へ組み込んでいない。

| 構成 | 日本語CER | 発話の空出力 | 非発話からの誤った本文 | 17件の処理時間 |
| --- | ---: | ---: | ---: | ---: |
| 現行 Whisper large-v3-turbo、beam 1 | 18.7% | 0/12 | 3/5 | 5.63秒 |
| Whisper large-v3-turbo、beam 5、温度0 | 19.4% | 0/12 | 3/5 | 4.65秒 |
| Whisper large-v3、beam 1 | 19.7% | 0/12 | 2/5 | 6.98秒 |
| Kotoba Whisper v2.0 faster、beam 1 | 22.8% | 0/12 | 3/5 | 4.20秒 |
| Kotoba Whisper v2.0 faster、beam 5、温度0 | 20.1% | 0/12 | 3/5 | 4.39秒 |
| SenseVoiceSmall int8、CPU | 21.8% | 0/12 | 2/5（句読点のみは除外） | 4.21秒 |

現行Whisperでは`Cough 2`と`Sneeze`に「ご視聴ありがとうございました」という架空の文が付いた。Silero VADはこの2件を発話として通した。モデルの大型化、beam拡大、日本語向けKotobaモデルへの切り替えでは、咳・くしゃみの誤認識と日本語の誤字を同時に改善できなかった。

SenseVoiceの音イベント判定は単独の咳5件のうち2件を`Cough`とした。ただし、日本語発話の後に公開の咳音声をつないだ3件では、**発話を含む2件を`Cough`と判定**した。判定を使って発言全体を削除すると実際の発言も失うため、咳検出による自動削除は採用しない。一方、現行Whisperも混合音声1件で発話の後に架空の「おやすみなさい」を追加した。音声イベントが発話に重なる場合は、今回の候補では確実に取り除けない。SenseVoiceの重みには[FunASRのモデルライセンス](https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE)が別途適用される。

## 実装への反映

Whisper large-v3-turboとSilero VADは維持する。Bot側の`ffmpeg`出力はチャンク長が一定でないので、20msのPCMフレームごとに音量を判定する。最後の有音フレームから発言を確定するまでの間を900msから1400msへ延ばし、日本語の短い間で文が切れにくくする。これは転写の誤字率改善を実測できた変更ではなく、音声分割の改善である。実際のDiscord VCで、発話の抜け、咳の誤認識、発言時刻、投稿時間を再確認する。
