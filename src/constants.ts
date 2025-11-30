import { SummaryTemplate } from './types';

export const TEMPLATES: SummaryTemplate[] = [
  {
    id: 'monitoring',
    name: 'モニタリング (Monitoring)',
    description: '日々の活動状況や体調変化の確認用',
    prompt: `
以下の面談記録に基づき、就労移行支援のモニタリング報告書形式で要約してください。
構成:
1. 現在の体調・メンタル状況
2. 訓練の進捗状況
3. 生活リズム（睡眠・食事など）
4. 今後の目標・課題
`
  },
  {
    id: 'assessment',
    name: 'アセスメント (Assessment)',
    description: '初期評価や課題の再評価用',
    prompt: `
以下の面談記録に基づき、アセスメントシート形式で要約してください。
構成:
1. 本人の希望（就労意欲、職種など）
2. 就労に向けた強み（ストレングス）
3. 就労阻害要因・課題
4. 必要な配慮事項
5. 支援方針の提案
`
  },
  {
    id: 'review',
    name: '支援計画振り返り (Review)',
    description: '個別支援計画の達成度確認用',
    prompt: `
以下の面談記録に基づき、支援計画の振り返りを作成してください。
構成:
1. 期間中の目標達成度（A/B/C評価とその理由）
2. 本人の自己評価
3. 支援員からの他者評価
4. 次期の目標設定案
`
  },
  {
    id: 'free',
    name: '自由形式 (Free)',
    description: '一般的な要約',
    prompt: '面談の内容を重要なポイントを箇条書きで整理し、簡潔に要約してください。'
  }
];

export const MODEL_NAMES = {
  LIVE: 'gemini-2.5-flash-native-audio-preview-09-2025',
  SUMMARY: 'gemini-2.5-flash',
};
