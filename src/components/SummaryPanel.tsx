import React, { useState } from 'react';
import { TEMPLATES } from '../constants';
import { RagDocument, AppStatus } from '../types';
import { FileText, Sparkles, Download, Copy, Trash2, Loader2, UploadCloud } from 'lucide-react';

interface SummaryPanelProps {
  status: AppStatus;
  summary: string;
  onGenerate: (templateId: string, customInstruction: string) => void;
  onFileUpload: (files: FileList) => void;
  documents: RagDocument[];
  onRemoveDocument: (id: string) => void;
}

const SummaryPanel: React.FC<SummaryPanelProps> = ({
  status,
  summary,
  onGenerate,
  onFileUpload,
  documents,
  onRemoveDocument
}) => {
  const [selectedTemplate, setSelectedTemplate] = useState(TEMPLATES[0].id);
  const [customInstruction, setCustomInstruction] = useState('');

  const isGenerating = status === AppStatus.PROCESSING;
  const hasSummary = summary.length > 0;

  const handleCopy = () => {
    navigator.clipboard.writeText(summary);
    alert('コピーしました');
  };

  const handleDownload = () => {
    const blob = new Blob([summary], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `面談要約_${new Date().toISOString().slice(0, 10)}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="h-full flex flex-col bg-white border-l border-slate-200 shadow-xl overflow-hidden">
      {/* Header */}
      <div className="p-4 border-b border-slate-100 bg-slate-50/50">
        <h2 className="text-lg font-bold text-slate-800 flex items-center gap-2">
          <Sparkles size={20} className="text-indigo-500" />
          AI要約生成
        </h2>
        <p className="text-xs text-slate-500 mt-1">
          テンプレートと資料を選択して要約を作成します
        </p>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        
        {/* RAG / Documents Section */}
        <div className="space-y-3">
          <label className="text-sm font-semibold text-slate-700 flex justify-between items-center">
            参照資料 (RAG)
            <span className="text-[10px] bg-slate-100 text-slate-500 px-2 py-0.5 rounded-full">Optional</span>
          </label>
          
          <div className="relative group border-2 border-dashed border-slate-300 rounded-lg p-4 hover:bg-slate-50 transition-colors text-center cursor-pointer">
             <input 
                type="file" 
                multiple 
                accept=".txt,.md,.json" 
                onChange={(e) => e.target.files && onFileUpload(e.target.files)} 
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
             />
             <UploadCloud className="mx-auto text-slate-400 mb-2" size={24} />
             <p className="text-xs text-slate-500">
               テキストファイルをドラッグ＆ドロップ<br/>またはクリックしてアップロード
             </p>
          </div>

          {documents.length > 0 && (
            <div className="flex flex-col gap-2">
              {documents.map(doc => (
                <div key={doc.id} className="flex items-center justify-between text-xs bg-indigo-50 text-indigo-700 p-2 rounded border border-indigo-100">
                  <span className="truncate max-w-[180px] flex items-center gap-1">
                    <FileText size={12} /> {doc.name}
                  </span>
                  <button onClick={() => onRemoveDocument(doc.id)} className="text-indigo-400 hover:text-red-500">
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Template Selection */}
        <div className="space-y-3">
          <label className="text-sm font-semibold text-slate-700">出力テンプレート</label>
          <div className="grid grid-cols-1 gap-2">
            {TEMPLATES.map((t) => (
              <button
                key={t.id}
                onClick={() => setSelectedTemplate(t.id)}
                className={`text-left p-3 rounded-lg border transition-all ${
                  selectedTemplate === t.id
                    ? 'bg-indigo-600 text-white border-indigo-600 shadow-md ring-2 ring-indigo-200'
                    : 'bg-white text-slate-600 border-slate-200 hover:border-indigo-300 hover:bg-slate-50'
                }`}
              >
                <div className="text-sm font-bold">{t.name}</div>
                <div className={`text-xs mt-1 ${selectedTemplate === t.id ? 'text-indigo-100' : 'text-slate-400'}`}>
                  {t.description}
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Custom Instructions */}
        <div className="space-y-3">
          <label className="text-sm font-semibold text-slate-700">追加指示 (任意)</label>
          <textarea
            value={customInstruction}
            onChange={(e) => setCustomInstruction(e.target.value)}
            placeholder="例: 「課題」の項目を重点的に詳しく書いてください。"
            className="w-full text-sm border border-slate-300 rounded-lg p-2 focus:ring-2 focus:ring-indigo-500 focus:border-transparent min-h-[80px]"
          />
        </div>

        {/* Generate Button */}
        <button
          onClick={() => onGenerate(selectedTemplate, customInstruction)}
          disabled={isGenerating || status === AppStatus.RECORDING}
          className={`w-full py-3 rounded-lg font-bold flex items-center justify-center gap-2 transition-all shadow-lg ${
            isGenerating
              ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
              : 'bg-indigo-600 hover:bg-indigo-700 text-white hover:shadow-indigo-500/30'
          }`}
        >
          {isGenerating ? (
            <>
              <Loader2 className="animate-spin" size={18} /> 生成中...
            </>
          ) : (
            <>
              <Sparkles size={18} /> 要約を実行
            </>
          )}
        </button>

        {/* Result Area */}
        {hasSummary && (
          <div className="mt-6 space-y-3 animate-slide-up">
            <div className="flex items-center justify-between">
              <label className="text-sm font-semibold text-slate-700">生成結果</label>
              <div className="flex gap-2">
                <button onClick={handleCopy} className="p-1.5 text-slate-500 hover:bg-slate-100 rounded" title="コピー">
                  <Copy size={16} />
                </button>
                <button onClick={handleDownload} className="p-1.5 text-slate-500 hover:bg-slate-100 rounded" title="保存">
                  <Download size={16} />
                </button>
              </div>
            </div>
            <div className="w-full h-96 p-4 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-800 overflow-y-auto whitespace-pre-wrap font-mono">
              {summary}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default SummaryPanel;
