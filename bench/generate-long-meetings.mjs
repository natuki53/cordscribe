import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const outputDir = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures');
mkdirSync(outputDir, { recursive: true });

const scenarios = [
  {
    id: 'release-planning', title: '配布ページ公開計画', durationMinutes: 190, utteranceCount: 480,
    speakers: ['進行', '開発', '品質', '広報'], topics: ['公開日', '配布ページ', '動作確認', '利用条件', '検索機能', '告知文'],
    anchorSpeakerIndexes: [0, 2, 1, 0, 0, 3],
    anchors: [
      ['decision', '新しい配布ページは2026年10月5日に公開することで合意します。'],
      ['action', '公開前の動作確認は品質担当の私が2026年10月3日までに行います。'],
      ['proposal', '検索機能を追加する案を出しますが、今日は決定せず次回検討します。'],
      ['revision', '公開日は2026年10月12日に変更します。先ほど決めた10月5日は取り消します。'],
      ['openQuestion', '英語版の公開範囲はまだ決まっていません。対象地域を次回確認します。'],
      ['action', '告知文の最終点検は広報担当の私が2026年10月10日までに行います。'],
    ],
  },
  {
    id: 'incident-review', title: 'サービス障害の振り返り', durationMinutes: 225, utteranceCount: 780,
    speakers: ['進行', '監視', '基盤', 'アプリ', '品質', 'サポート'], topics: ['検知', '復旧', '監視通知', 'データベース', '利用者連絡', '再発防止'],
    anchorSpeakerIndexes: [0, 1, 1, 0, 0, 2],
    anchors: [
      ['decision', '異常検知から通知までの閾値を15分から5分へ変更することで合意します。'],
      ['action', '監視ダッシュボードの更新は監視担当の私が2026年10月7日までに行います。'],
      ['proposal', 'データベースの遅延が原因かもしれませんが、ログ確認前なので断定しません。'],
      ['revision', '通知先を全員にする案は撤回し、一次当番とバックアップ当番の二人に限定します。'],
      ['openQuestion', '障害時に利用者へ最初の案内を出す時点は未決定です。サポートと次回詰めます。'],
      ['action', '復旧手順の演習は基盤担当の私が2026年10月15日までに実施します。'],
    ],
  },
  {
    id: 'product-roadmap', title: '製品ロードマップ策定', durationMinutes: 245, utteranceCount: 1020,
    speakers: ['進行', '企画', '開発', '設計', '品質', '営業', 'サポート', '分析'], topics: ['優先順位', '検索', '通知', 'モバイル', '料金', '計測', 'サポート', '公開時期'],
    anchorSpeakerIndexes: [0, 7, 1, 0, 0, 1],
    anchors: [
      ['decision', '次期リリースでは検索の改善を最優先にすることで合意しました。'],
      ['action', '検索の利用状況の集計は分析担当の私が2026年10月14日までに提出します。'],
      ['proposal', '月額料金の改定は提案段階で、採用するかどうかは決まっていません。'],
      ['revision', 'モバイル版を次期リリースへ入れるという先ほどの方針を変更し、次々期の候補に移します。'],
      ['openQuestion', '通知の初期設定を有効にするかは未決定です。利用者調査後に判断します。'],
      ['action', 'サポート向けの変更点一覧は企画担当の私が2026年10月20日までに作ります。'],
    ],
  },
  {
    id: 'operations-handoff', title: '運用引き継ぎ', durationMinutes: 210, utteranceCount: 440,
    speakers: ['現担当', '次担当', '管理者'], topics: ['監視手順', '夜間受付', '権限', 'バックアップ', '問い合わせ', '緊急連絡'],
    anchorSpeakerIndexes: [0, 0, 1, 0, 0, 1],
    anchors: [
      ['decision', '夜間の一次受付は次担当が引き受け、管理者がバックアップすることに決めました。'],
      ['action', '監視手順書の更新は現担当の私が2026年10月8日までに完了します。'],
      ['proposal', 'バックアップ頻度を毎日にする案はありますが、容量を確認するまで保留します。'],
      ['revision', '緊急連絡は電話を先にする予定を変更し、専用チャネルへの通知を先にします。'],
      ['openQuestion', '権限棚卸しの承認者はまだ決まっていません。管理者が確認します。'],
      ['action', '引き継ぎ演習は次担当の私が2026年10月18日までに実施します。'],
    ],
  },
  {
    id: 'dense-workshop', title: 'API移行の技術検討', durationMinutes: 310, utteranceCount: 1500,
    speakers: ['進行', 'API', '基盤', 'クライアント', '品質', 'セキュリティ', '運用', '文書'], topics: ['互換性', '認証', '移行手順', '性能', '監視', '文書', '例外処理', '公開'],
    anchorSpeakerIndexes: [0, 7, 1, 0, 0, 4],
    anchors: [
      ['decision', '旧APIの互換期間を新API公開から90日間とすることで合意します。'],
      ['action', '移行ガイドの初稿は文書担当の私が2026年10月22日までに作成します。'],
      ['proposal', '認証方式を一度に切り替える案は提示しますが、採用は決まっていません。'],
      ['revision', '互換期間は先ほど決めた90日間から120日間に変更します。90日の決定は取り消します。'],
      ['openQuestion', '旧クライアントの利用者数が未確認なので、移行案内の対象はまだ確定できません。'],
      ['action', '負荷試験の結果を品質担当の私が2026年10月25日までに共有します。'],
    ],
  },
];

const filler = [
  '現時点の資料では{topic}の条件が揃っていません。関係する画面と運用手順を分けて確認したいです。',
  '{topic}の利用者側の影響を整理したいです。見えている課題を一覧に書き足しておきます。',
  '手元では{topic}に関係する操作を二通り試しました。数字は確認中なので後で資料を共有します。',
  '{topic}の議論で前提がずれないよう、対象と対象外をもう一度読み合わせましょう。',
  '先ほどの{topic}の説明について、例外時の扱いも考慮する必要がありそうです。',
  '{topic}は窓口によって説明が違う可能性があります。実際の手順を照らし合わせます。',
  '資料の{topic}の箇所に注記があります。この数字の根拠を次の確認項目として残します。',
  '{topic}については現場で起きるケースをいくつか挙げ、影響範囲を整理しましょう。',
  'ここまでの{topic}の論点を確認します。まだ判断に必要な情報が揃っていない点があります。',
  '{topic}の説明は理解しました。関連する問い合わせの傾向も資料に反映したいです。',
];

// Discussion moves to another agenda item and later returns to earlier ones.
const topicRoute = [0, 1, 2, 0, 3, 4, 2, 5, 1, 6, 0, 7, 3, 5];

for (const [scenarioIndex, config] of scenarios.entries()) {
  const anchorPositions = [0.08, 0.24, 0.42, 0.63, 0.78, 0.95].map((fraction) => Math.floor(config.utteranceCount * fraction));
  const anchorAt = new Map(anchorPositions.map((position, index) => [position, index]));
  const anchors = [];
  const utterances = [];
  let state = (scenarioIndex + 1) * 1_000_003;
  const random = () => ((state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const durationMs = config.durationMinutes * 60_000;
  for (let i = 0; i < config.utteranceCount; i++) {
    const anchorIndex = anchorAt.get(i);
    const routeIndex = Math.floor(i / config.utteranceCount * topicRoute.length);
    const topic = config.topics[topicRoute[routeIndex] % config.topics.length];
    const speakerIndex = anchorIndex === undefined ? Math.floor(random() * config.speakers.length) : config.anchorSpeakerIndexes[anchorIndex];
    const [kind, anchorText] = anchorIndex === undefined ? [null, null] : config.anchors[anchorIndex];
    const text = anchorText ?? filler[Math.floor(random() * filler.length)].replace('{topic}', topic);
    if (kind === 'action' && !text.includes(config.speakers[speakerIndex])) throw new Error(`Action speaker mismatch: ${config.id} ${i}`);
    const startMs = Math.floor(i / config.utteranceCount * durationMs);
    const speakingMs = Math.min(28_000, Math.max(3_000, text.length * 190));
    const publicId = `U${String(i + 1).padStart(6, '0')}`;
    utterances.push({ publicId, speakerUserId: `user-${speakerIndex + 1}`, startMs, endMs: Math.min(durationMs, startMs + speakingMs), topic, text });
    if (kind) anchors.push({ kind, publicId, text });
  }
  const fixture = {
    id: config.id, title: config.title, synthetic: true, durationMinutes: config.durationMinutes,
    speakers: config.speakers.map((displayName, index) => ({ userId: `user-${index + 1}`, displayName })),
    anchors, utterances,
  };
  const path = join(outputDir, `${config.id}.json`);
  writeFileSync(path, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ id: fixture.id, durationMinutes: fixture.durationMinutes, speakers: fixture.speakers.length, utterances: fixture.utterances.length, anchors: fixture.anchors.length, path }));
}
