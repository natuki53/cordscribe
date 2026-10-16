# ASR精度改善と再現評価

更新日: 2026-10-16。対象は文字起こしまでで、要約、文脈補完、TODO抽出、生成AIによる誤認識修正は対象外。実装は話者別音声と同意境界を維持する。

## 2回目の実VC議事録から分かったこと

59分48秒・817発言の議事録では、空転写は60件（7.3%）だった。一方、`うん`、`あー`、`Google`、`Google Analytics`などが数百文字続く反復ループが17件あり、すべて従来の疑い判定から漏れた。Whisper segmentごとの`compression_ratio`最大値だけでは、複数segmentを結合した発言全体の反復を表現できないため、結合後本文をzlib圧縮した`text_repetition_ratio`を追加する。3.0以上かつ正規化後40文字以上は強い反復根拠として扱うが、本文は保持する。

既知の終端定型文で終わる発言40件のうち29件だけが従来フラグ付きだった。完全一致からsuffix一致へ広げ、異なる本文の末尾に同じ定型文が5分以内に3回出た場合も同一フレーズとして数える。用語集由来に見える反復も確認されたため、hotwordsは設定を残したまま既定OFFとし、同一音声のA/B評価時だけ明示的に有効化する。

## パイプライン

```text
同意済みDiscord UserのVoiceReceiver
  → Opus 48kHz stereo / 20ms
  → prism-media Decoder
  → FFmpeg speechnorm（最大3倍）
  → 16kHz mono signed 16-bit little-endian PCM
  → 20msフレーム / RMSゲート / 300ms pre-roll
  → 話者別発言（無音1400ms、最大28秒）
  → RAM内の直列STTキュー
  → Silero VAD（threshold 0.35、最小100ms、pad 250ms）
  → faster-whisper（日本語、transcribe、内部VAD無効）
  → 本文とASR品質値をSQLiteへ保存
  → 発言ID・話者・時刻・低品質フラグ付きMarkdown
```

音声は話者ごとに独立し、同時発話もmixしない。同意前は購読せず、撤回時は未確定PCMとpre-rollを破棄する。

## 原因と優先度

| 重要度 | 原因候補 | 根拠 | 対応 | 副作用と確認方法 |
| --- | --- | --- | --- | --- |
| Critical | Whisperが雑音・弱い音声をもっともらしい終端文へ変換 | 公開の咳・くしゃみ5件中3件で誤本文。実VC議事録にも終端文が反復 | 本文を消さず、音量・音声長・no-speech・logprob・compression・反復を保存して疑い判定 | 実発話の「ありがとうございました」を誤検知し得る。定型文だけでは判定しないテストを固定 |
| Critical | 旧APIがWhisperの品質値を捨てていた | DBはlanguage probabilityしか保持していなかった | 発言単位のASR・音声指標をAPIとSQLiteへ追加 | DB列増加。既存DBには起動時に追加列をmigration |
| High | RMSゲート開始前のPCMを破棄 | Segmenterは最初の有音フレームまでreturnしていた | 300msの話者別ring buffer | ノイズも前置される。Silero VADと非発話fixtureで確認 |
| High | 250ms未満の短い発話をSileroが破棄 | 「はい」等の欠損要因になり得る | 最小音声を100ms、padを250msへ | click・呼吸音が増え得る。短文と雑音fixtureを同時評価 |
| High | Whisper設定の一部がライブラリ既定値任せ | temperature fallback等がコードから確認できなかった | 全主要値を環境変数化し、temperature 0を明示 | 難音声で空転写が増える可能性。CER・空転写数で比較 |
| High | 感覚調整しかできない | 実VC議事録には元音声・正解文がない | manifest方式のbenchmarkを追加 | 評価音声の準備が必要。実会議音声をGitへ入れない |
| Medium | 固有名詞の誤認識 | VNavi等が別語へ変化 | hotwordsまたはJSON用語ファイル | 用語hallucinationを誘発し得る。用語あり・なしを同じmanifestで比較 |
| Medium | 入力音声の切り分けが困難 | STT直前PCMを聴けなかった | 既定OFFの入力/VAD後WAV保存 | 個人音声をディスクへ残す。明示設定、0600、件数上限、一時領域で制限 |

## Whisper設定 Before / After

| 項目 | Before | After（既定） |
| --- | --- | --- |
| model | `STT_MODEL=turbo` | 同じ。任意モデルへ設定変更可能 |
| compute type | `int8_float16` | 同じ。設定変更可能 |
| language / task | `ja` / `transcribe` | 同じ。明示維持 |
| beam size | 1 | 1、`STT_BEAM_SIZE` |
| best of | ライブラリ既定 | 1、`STT_BEST_OF` |
| temperature | ライブラリのfallback列 | 0、`STT_TEMPERATURE` |
| no-speech threshold | ライブラリ既定0.6 | 0.6を明示 |
| logprob threshold | ライブラリ既定-1.0 | -1.0を明示 |
| compression threshold | ライブラリ既定2.4 | 2.4を明示 |
| repetition penalty | 1.0 | 1.08。弱い反復抑制 |
| no-repeat n-gram | 0（無効） | 3-token n-gram |
| previous text | false | falseを明示。話者・品質を考慮した評価ができるまで有効化しない |
| initial prompt | 既定OFF | OFFを維持 |
| hotwords | 常時有効 | 既定OFF。環境変数またはJSONファイルをA/B評価時だけ有効化 |
| faster-whisper VAD | false | false。手前のSileroとの二重切断を避ける |
| Bot minimum utterance | 300ms | 100ms。20msの単発clickは破棄し、Sileroでも再判定 |
| Silero minimum speech | 250ms | 100ms |
| Silero speech pad | 150ms | 250ms |

## 品質情報とhallucination

発言には`avg_logprob`、`no_speech_prob`、`compression_ratio`、`text_repetition_ratio`、`rms_dbfs`、`peak`、`clipping_ratio`、`speech_duration_ms`、`confidence`、`suspected_hallucination`、理由配列を保存する。定型文だけで削除・置換しない。既知の定型文には少なくとも1件の音声・モデル警告が必要で、それ以外の文は3件以上の警告が揃った場合だけ疑いとする。発言全体の強い反復ループは単独で疑い根拠とする。同じ定型文が5分内に3回以上出た場合は反復理由を追加する。Markdownにも低confidenceと疑いを表示し、後段AIが原文と併せて判断できるようにする。

## 評価方法

`stt/fixtures/asr/manifest.example.json`をコピーし、同意済み音声と人手の正解文をGit管理外へ配置する。最低限、通常会話、30〜60秒の長文、100〜500msの短文、固有名詞、完全無音、キーボード・マウス、同時発話の話者別音声、小声、大音量を含める。

```bash
python stt/benchmark.py stt/fixtures/asr/manifest.json \
  --model turbo:int8_float16:1 \
  --model large-v3:int8_float16:1 \
  --output stt/fixtures/asr/result.json
```

hotwords比較時だけ、同じmanifestへ`--hotwords 'VRChat、VNavi、CordScribe、WordPress、Search Console'`を追加する。

主要指標は日本語CER。補助としてWER、latency、real-time factor、非発話hallucination件数、空転写件数、疑い件数、GPU使用量を出す。既存の公開音声17件では、large-v3-turbo / beam 1がCER 18.7%、非発話誤本文3/5で、比較候補中の日本語CERが最良だった。この結果は旧VAD値と公開読み上げ音声によるもので、新しい実VC設定の合格証明ではない。

## 未完了の実機確認

- 提供議事録で欠損率40.9%だった小声話者を含む短いVCを再実施し、話者別の空転写率を比較する。
- debug WAVでDiscord上の聞こえ方とWhisper入力の文頭・文末、clipping、packet loss由来の欠落を確認する。
- 同じ音声manifestでhotwords有無、VAD threshold 0.35/0.40、turbo/large-v3を比較する。
- 2人同時発話を話者別に評価し、mixされていないことを再確認する。
- 実VCで確認できるまで、精度改善はローカル実装・合成経路検証済みであり、本番受け入れ済みとは扱わない。
