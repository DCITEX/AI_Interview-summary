import React, { useRef, useEffect } from 'react';
import { TranscriptItem, SpeakerRole } from '../types';
import { User, FilePenLine, Bot, Stethoscope, AudioLines, Download } from 'lucide-react';

interface TranscriptViewProps {
  transcripts: TranscriptItem[];
  onEdit: (id: string, newText: string) => void;
  isRecording: boolean;
}

const TranscriptView: React.FC<TranscriptViewProps> = ({ 
  transcripts, 
  onEdit, 
  isRecording,
}) => {
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when recording (only relevant if we were showing text, but kept for logic safety)
  useEffect(() => {
    if (isRecording && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [transcripts, isRecording]);

  const handleDownloadCsv = () => {
    if (transcripts.length === 0) return;
    
    // BOM for Excel to open UTF-8 correctly
    const bom = new Uint8Array([0xEF, 0xBB, 0xBF]);
    let csvContent = "時刻,話者,内容\n";
    
    transcripts.forEach(t => {
        const time = t.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const speaker = t.speaker === 'Staff' ? '支援員' : (t.speaker === 'Client' ? '利用者' : 'AI');
        // Escape quotes
        const safeText = `"${t.text.replace(/"/g, '""')}"`;
        csvContent += `${time},${speaker},${safeText}\n`;
    });

    const blob = new Blob([bom, csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.setAttribute("download", `面談記録_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const getSpeakerLabel = (role: SpeakerRole) => {
    switch (role) {
      case 'Staff': return '支援員';
      case 'Client': return '利用者';
      case 'AI': return 'AI';
      default: return role;
    }
  };

  const getSpeakerStyles = (role: SpeakerRole) => {
    switch (role) {
      case 'Staff': return {
        container: 'flex-row', // Left aligned
        bubble: 'bg-indigo-50 border-indigo-100 text-slate-800',
        icon: 'bg-indigo-600 text-white',
        label: 'text-indigo-600',
        align: 'items-start'
      };
      case 'Client': return {
        container: 'flex-row-reverse', // Right aligned
        bubble: 'bg-emerald-50 border-emerald-100 text-slate-800',
        icon: 'bg-emerald-500 text-white',
        label: 'text-emerald-600',
        align: 'items-end'
      };
      default: return {
        container: 'flex-row',
        bubble: 'bg-white border-slate-200',
        icon: 'bg-slate-200 text-slate-600',
        label: 'text-slate-500',
        align: 'items-start'
      };
    }
  };

  // --- View: Idle State (No Data) ---
  if (transcripts.length === 0 && !isRecording) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-slate-400 p-8 text-center">
        <div className="w-20 h-20 bg-white border border-slate-200 rounded-full flex items-center justify-center mb-6 shadow-sm">
          <Bot size={40} className="text-slate-300" />
        </div>
        <h3 className="text-lg font-bold text-slate-600 mb-2">面談を開始する準備ができました</h3>
        <p className="text-sm max-w-xs mx-auto mb-8">
          録音ボタンを押して面談を開始してください。<br/>
          会話内容は自動的に記録されます。
        </p>
      </div>
    );
  }

  // --- View: Recording State (Animation) ---
  if (isRecording) {
      return (
          <div className="flex flex-col items-center justify-center h-full text-slate-500">
              <div className="relative flex items-center justify-center mb-8">
                  {/* Pulse Animation */}
                  <div className="absolute w-32 h-32 bg-indigo-100 rounded-full animate-ping opacity-75"></div>
                  <div className="absolute w-24 h-24 bg-indigo-200 rounded-full animate-pulse opacity-80"></div>
                  <div className="relative w-16 h-16 bg-white border-4 border-indigo-500 rounded-full flex items-center justify-center z-10 shadow-lg">
                      <AudioLines size={24} className="text-indigo-600 animate-bounce" />
                  </div>
              </div>
              
              <h3 className="text-xl font-bold text-slate-700 mb-2 tracking-tight">面談を記録中...</h3>
              <p className="text-sm text-slate-400 max-w-xs text-center leading-relaxed">
                  音声を聞き取っています。<br/>
                  画面の表示は停止していますが、記録は継続されています。
              </p>
          </div>
      );
  }

  // --- View: Transcript History (Post-Recording) ---
  return (
    <div className="flex flex-col h-full">
        {/* Scrollable History */}
        <div className="flex-1 overflow-y-auto p-6 pb-48">
            <div className="max-w-3xl mx-auto w-full flex flex-col gap-6">
                
                {/* Tools Header */}
                <div className="flex justify-end mb-4 animate-fade-in">
                    <button 
                        onClick={handleDownloadCsv}
                        className="flex items-center gap-1 text-xs font-bold text-indigo-600 bg-indigo-50 hover:bg-indigo-100 px-3 py-1.5 rounded-full transition-colors"
                    >
                        <Download size={14} /> CSV出力
                    </button>
                </div>

                {transcripts.map((item) => {
                    const styles = getSpeakerStyles(item.speaker);
                    
                    return (
                    <div key={item.id} className={`group flex gap-4 transition-all duration-500 ${styles.container}`}>
                        
                        {/* Icon Column */}
                        <div className="flex-shrink-0 mt-1 flex flex-col items-center gap-1">
                        <div 
                            className={`w-10 h-10 rounded-full flex items-center justify-center shadow-sm ${styles.icon}`}
                        >
                            {item.speaker === 'Staff' ? <Stethoscope size={18} /> : <User size={18} />}
                        </div>
                        </div>

                        {/* Bubble Column */}
                        <div className={`flex flex-col max-w-[85%] ${styles.align}`}>
                        <div className="flex items-center gap-2 mb-1 px-1">
                            <span className={`text-xs font-bold ${styles.label}`}>
                                {getSpeakerLabel(item.speaker)}
                            </span>
                            <span className="text-[10px] text-slate-400 font-mono">
                                {item.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            </span>
                        </div>

                        <div className={`relative px-5 py-3 rounded-2xl shadow-sm border ${styles.bubble} ${item.speaker === 'Staff' ? 'rounded-tl-none' : 'rounded-tr-none'}`}>
                            <textarea
                            value={item.text}
                            onChange={(e) => onEdit(item.id, e.target.value)}
                            className="w-full text-[15px] bg-transparent border-transparent resize-none focus:ring-0 p-0 leading-relaxed overflow-hidden"
                            rows={Math.max(1, Math.ceil(item.text.length / 35))}
                            style={{ minHeight: '1.5rem', width: '100%' }}
                            />
                            
                            <div className="mt-1 flex justify-between items-center h-4">
                                <span />
                                <FilePenLine size={12} className="text-slate-400 opacity-0 group-hover:opacity-100 transition-opacity" />
                            </div>
                        </div>
                        </div>
                    </div>
                    );
                })}
                <div ref={bottomRef} />
            </div>
        </div>
    </div>
  );
};

export default TranscriptView;