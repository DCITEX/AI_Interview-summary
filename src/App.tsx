import React, { useState, useRef, useEffect } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality, Type } from '@google/genai';
import { TranscriptItem, RagDocument, AppStatus, SpeakerRole } from './types';
import { TEMPLATES, MODEL_NAMES } from './constants';
import { createPcmBlob, arrayBufferToBase64 } from './services/audioUtils';
import TranscriptView from './components/TranscriptView';
import SummaryPanel from './components/SummaryPanel';
import { Mic, AlertCircle, PlayCircle, StopCircle, Menu, X, Wand2, Loader2, RotateCcw } from 'lucide-react';

const App: React.FC = () => {
  // --- State ---
  const [status, setStatus] = useState<AppStatus>(AppStatus.IDLE);
  const [transcripts, setTranscripts] = useState<TranscriptItem[]>([]);
  const [summary, setSummary] = useState<string>('');
  const [documents, setDocuments] = useState<RagDocument[]>([]);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const [sessionId, setSessionId] = useState<string>(Date.now().toString()); // Used to force reset child components
  const [hasPostProcessed, setHasPostProcessed] = useState(false); // Tracks if AI diarization has been done
  const [isSessionFinished, setIsSessionFinished] = useState(false); // Tracks if recording has finished at least once

  // --- Refs ---
  const sessionRef = useRef<any>(null); 
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  
  // Buffers for Transcript accumulation
  const activeTranscriptIdRef = useRef<string | null>(null);
  const lastUpdateTimeRef = useRef<number>(0);

  // --- Effects ---

  // Clean up on unmount
  useEffect(() => {
    return () => {
      stopRecording();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Logic: Recording (Gemini Live + MediaRecorder) ---

  const startRecording = async () => {
    if (!process.env.API_KEY) {
      setErrorMsg("API Key not found.");
      return;
    }

    setStatus(AppStatus.CONNECTING);
    setErrorMsg(null);
    setRecordedBlob(null); // Clear previous recording
    activeTranscriptIdRef.current = null; // Reset current bubble
    audioChunksRef.current = []; // Clear chunks

    try {
      // 1. Audio Setup - Robust Error Handling
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error("お使いのブラウザはマイク録音をサポートしていません。");
      }

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (err: any) {
        console.error("Microphone Access Error:", err);
        let message = "マイクへのアクセスに失敗しました。";
        
        if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError' || err.message?.includes('device not found')) {
            message = "マイクが見つかりません。デバイスが接続されているか確認してください。";
        } else if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
            message = "マイクの使用が許可されていません。ブラウザのアドレスバーから許可設定を行ってください。";
        } else if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
            message = "マイクにアクセスできません。他のアプリケーション（ZoomやTeamsなど）がマイクを使用していないか確認してください。";
        }
        
        throw new Error(message);
      }

      streamRef.current = stream;
      
      const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
      const audioContext = new AudioContext({ sampleRate: 16000 });
      // Resume audio context if it's suspended (browser autoplay policy)
      if (audioContext.state === 'suspended') {
        await audioContext.resume();
      }
      audioContextRef.current = audioContext;

      // --- Parallel Recording Setup (for Post-Processing) ---
      // 32kbps ensures ~1 hour fits in ~15-20MB, which is safe for Gemini inline data limit.
      const mimeType = 'audio/webm;codecs=opus';
      const options = MediaRecorder.isTypeSupported(mimeType) 
        ? { mimeType, bitsPerSecond: 32000 } 
        : { bitsPerSecond: 32000 };
      
      const mediaRecorder = new MediaRecorder(stream, options);
      mediaRecorderRef.current = mediaRecorder;
      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };
      // Start with 1000ms timeslice to ensure we get data incrementally.
      mediaRecorder.start(1000);
      // -----------------------------------------------------

      // 2. Connect to Live API
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const sessionPromise = ai.live.connect({
        model: MODEL_NAMES.LIVE,
        callbacks: {
            onopen: () => {
              console.log("Gemini Live Connected");
              setStatus(AppStatus.RECORDING);

              const source = audioContext.createMediaStreamSource(stream);
              const processor = audioContext.createScriptProcessor(4096, 1, 1);
              scriptProcessorRef.current = processor;

              processor.onaudioprocess = (e) => {
                 const inputData = e.inputBuffer.getChannelData(0);
                 const pcmBlob = createPcmBlob(inputData);
                 sessionPromise.then(session => {
                     return session.sendRealtimeInput({ media: pcmBlob });
                 }).catch(e => {
                     console.debug("Audio send skipped:", e);
                 });
              };

              source.connect(processor);
              processor.connect(audioContext.destination);
            },
            onmessage: (msg: LiveServerMessage) => {
               // Handle transcription
               if (msg.serverContent?.inputTranscription) {
                  const text = msg.serverContent.inputTranscription.text;
                  if (text) {
                     handleTranscriptChunk(text);
                  }
               }
            },
            onclose: () => {
                console.log("Gemini Live Closed");
                // Only consider it an error if we didn't intend to stop
                // But since we can't easily distinguish remote close vs local close here without state,
                // we rely on the stopRecording logic to handle cleanup.
                // If closed unexpectedly, user will see recording stop.
                if (status === AppStatus.RECORDING) {
                    // Try to save whatever we have
                    stopRecording().then(() => {
                        setErrorMsg("サーバーとの接続が切断されました（録音データは保存されました）。");
                    });
                }
            },
            onerror: (err) => {
                console.error("Gemini Live Error", err);
                if (status === AppStatus.CONNECTING) {
                    setErrorMsg("接続エラーが発生しました。ネットワーク状況を確認して再接続してください。");
                    setStatus(AppStatus.ERROR);
                } 
                // Don't auto-stop on minor errors, wait for onclose or user action unless critical
            }
        },
        config: {
            responseModalities: [Modality.AUDIO], 
            inputAudioTranscription: {}, 
            systemInstruction: `
            あなたは就労移行支援事業所の面談記録を行う、非常に厳格な書記です。
            以下のルールを絶対厳守して、ユーザーの音声を正確な日本語で書き起こしてください。

            【最重要ルール】
            1. **完全な聞き取りのみ**: 音声としてはっきり聞こえた言葉だけを書き取ってください。
            2. **捏造・補完の禁止**: 音声に含まれていない情報は、絶対に追記しないでください。
            3. **推測の禁止**: 文脈や支援員の言葉から推測して、利用者の発言を勝手に作らないでください。
            4. **役割**: あなたは会話アシスタントではありません。返答は不要です。

            【整形ルール】
            - "あー"、"えーっと" などのフィラーは削除。
            - 文脈に合わせて句読点を付与。
            `,
            speechConfig: {
                voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } }
            }
        }
      });

      sessionRef.current = await sessionPromise;

    } catch (e: any) {
      console.error(e);
      // Clean up if setup failed
      if (streamRef.current) {
          streamRef.current.getTracks().forEach(track => track.stop());
          streamRef.current = null;
      }
      setErrorMsg(`${e.message}`);
      setStatus(AppStatus.ERROR);
    }
  };

  const stopRecording = async () => {
    // 1. Stop Live API components
    if (scriptProcessorRef.current) {
        scriptProcessorRef.current.disconnect();
        scriptProcessorRef.current = null;
    }
    if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
        streamRef.current = null;
    }
    if (audioContextRef.current) {
        audioContextRef.current.close();
        audioContextRef.current = null;
    }
    if (sessionRef.current) {
        try {
            // @ts-ignore
            sessionRef.current.close();
        } catch(e) {}
        sessionRef.current = null;
    }

    // 2. Stop MediaRecorder
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.requestData();
        await new Promise<void>(resolve => {
            const timeout = setTimeout(() => resolve(), 1000);
            if (!mediaRecorderRef.current) { clearTimeout(timeout); return resolve(); }
            mediaRecorderRef.current.onstop = () => {
                clearTimeout(timeout);
                resolve();
            };
            mediaRecorderRef.current.stop();
        });
    }

    if (audioChunksRef.current.length > 0) {
        const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        setRecordedBlob(blob);
        // Automatically trigger analysis
        analyzeAudioAndDiarize(blob);
    }

    activeTranscriptIdRef.current = null;
    setStatus(AppStatus.IDLE);
    setIsSessionFinished(true);
  };

  // --- Logic: Reset Session ---
  const resetSession = async () => {
    if (status === AppStatus.RECORDING) {
         if (!window.confirm("録音を停止して、データをリセットしますか？\n(現在の録音は保存されません)")) return;
    } else if (transcripts.length > 0 || summary || documents.length > 0 || recordedBlob) {
         if (!window.confirm("現在の面談データをすべて消去して、新しい面談を開始しますか？\n(未保存のデータは失われます)")) return;
    }
    
    // Cleanup synchronous
    if (scriptProcessorRef.current) {
        scriptProcessorRef.current.disconnect();
        scriptProcessorRef.current = null;
    }
    if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
        streamRef.current = null;
    }
    if (audioContextRef.current) {
        audioContextRef.current.close();
        audioContextRef.current = null;
    }
    if (sessionRef.current) {
        try {
            // @ts-ignore
            sessionRef.current.close();
        } catch(e) {}
        sessionRef.current = null;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        try { mediaRecorderRef.current.stop(); } catch(e) {}
    }
    
    // Reset State
    setStatus(AppStatus.IDLE);
    setTranscripts([]);
    setSummary('');
    setDocuments([]);
    setRecordedBlob(null);
    setErrorMsg(null);
    setHasPostProcessed(false);
    setIsSessionFinished(false);
    
    activeTranscriptIdRef.current = null;
    audioChunksRef.current = [];
    
    // CRITICAL: Update sessionId to force unmount/remount of children components
    // This ensures internal state of SummaryPanel/TranscriptView is wiped.
    setSessionId(Date.now().toString());
  };

  // --- Logic: Transcript Management ---

  const handleTranscriptChunk = (text: string) => {
    if (!text.trim()) return;

    setTranscripts(prev => {
        const now = Date.now();
        return processTranscriptUpdate(prev, text, now, 'Staff');
    });
  };
  
  const processTranscriptUpdate = (
      currentTranscripts: TranscriptItem[], 
      text: string, 
      now: number,
      speaker: SpeakerRole
  ) => {
      const newTranscripts = [...currentTranscripts];
      const lastId = activeTranscriptIdRef.current;
      const lastItemIndex = newTranscripts.findIndex(t => t.id === lastId);
      const lastItem = lastItemIndex !== -1 ? newTranscripts[lastItemIndex] : null;

      const TIME_THRESHOLD_MS = 3000; 
      const isRecent = (now - lastUpdateTimeRef.current) < TIME_THRESHOLD_MS;

      if (lastItem && lastItem.speaker === speaker && isRecent) {
          newTranscripts[lastItemIndex] = {
              ...lastItem,
              text: lastItem.text + text,
              isFinal: false 
          };
          lastUpdateTimeRef.current = now;
      } else {
          const newId = now.toString();
          activeTranscriptIdRef.current = newId;
          lastUpdateTimeRef.current = now;
          
          newTranscripts.push({
              id: newId,
              speaker: speaker,
              text: text,
              timestamp: new Date(),
              isFinal: true
          });
      }
      return newTranscripts;
  };

  const updateTranscript = (id: string, newText: string) => {
    setTranscripts(prev => prev.map(t => t.id === id ? { ...t, text: newText } : t));
  };

  // --- Logic: Post-Processing ---

  const analyzeAudioAndDiarize = async (blobToAnalyze?: Blob) => {
    const targetBlob = blobToAnalyze || recordedBlob;
    if (!targetBlob || !process.env.API_KEY) return;
    
    setStatus(AppStatus.PROCESSING);
    setErrorMsg(null);

    try {
        const arrayBuffer = await targetBlob.arrayBuffer();
        const base64Audio = arrayBufferToBase64(arrayBuffer);

        // Check if data is too large (approx 19MB to be safe for 20MB limit)
        if (base64Audio.length > 19 * 1024 * 1024) {
             throw new Error("録音データが大きすぎます（約60分以上）。CSVエクスポートで保存してください。");
        }

        const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: {
                parts: [
                    { inlineData: { mimeType: targetBlob.type || 'audio/webm', data: base64Audio } },
                    { text: `
                    この音声は就労移行支援事業所での面談記録です。以下の手順で処理してください。
                    
                    1. 音声全体を正確に書き起こしてください。
                    2. 話者分離を行ってください。主な話者は「支援員(Staff)」と「利用者(Client)」です。
                    3. 音声に含まれていない情報の捏造は絶対にしないでください。
                    4. 結果をJSON配列で出力してください。
                    ` }
                ]
            },
            config: {
                responseMimeType: "application/json",
                responseSchema: {
                    type: Type.ARRAY,
                    items: {
                        type: Type.OBJECT,
                        properties: {
                            speaker: { type: Type.STRING, enum: ['Staff', 'Client'] },
                            text: { type: Type.STRING }
                        },
                        required: ['speaker', 'text']
                    }
                }
            }
        });

        const jsonText = response.text;
        if (!jsonText) throw new Error("Empty response");
        const parsed = JSON.parse(jsonText);
        
        const newTranscripts: TranscriptItem[] = parsed.map((item: any, index: number) => ({
            id: `post-process-${index}`,
            speaker: item.speaker as SpeakerRole,
            text: item.text,
            timestamp: new Date(),
            isFinal: true
        }));

        setTranscripts(newTranscripts);
        setHasPostProcessed(true);

    } catch (e: any) {
        console.error("Diarization error:", e);
        setErrorMsg(`分析処理に失敗しました: ${e.message}`);
    } finally {
        setStatus(AppStatus.IDLE);
    }
  };

  // --- Logic: RAG & Summary ---
  
  const handleFileUpload = async (files: FileList) => {
    const newDocs: RagDocument[] = [];
    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        
        if (file.type.startsWith('image/') || file.type === 'application/pdf') {
             // Binary handling for Images/PDF
             const reader = new FileReader();
             reader.onload = (e) => {
                 const result = e.target?.result as string;
                 const base64 = result.split(',')[1];
                 setDocuments(prev => [...prev, {
                     id: Date.now() + '-' + i,
                     name: file.name,
                     content: base64, // Store base64
                     type: file.type === 'application/pdf' ? 'application/pdf' : 'image/jpeg' // simplify mime
                 } as any]);
             };
             reader.readAsDataURL(file);
        } else {
             // Text handling
             const text = await file.text();
             newDocs.push({
                id: Date.now() + '-' + i,
                name: file.name,
                content: text,
                type: 'text/plain'
            });
        }
    }
    if (newDocs.length > 0) {
        setDocuments(prev => [...prev, ...newDocs]);
    }
  };

  const removeDocument = (id: string) => {
    setDocuments(prev => prev.filter(d => d.id !== id));
  };

  const generateSummary = async (templateId: string, customInstruction: string) => {
    if (!process.env.API_KEY) return;
    setStatus(AppStatus.PROCESSING);
    
    try {
        const template = TEMPLATES.find(t => t.id === templateId);
        
        // 1. Prepare Text Context from Transcripts
        const transcriptText = `【面談記録】\n${transcripts.map(t => `[${t.timestamp.toLocaleTimeString()}] ${t.speaker === 'Staff' ? '支援員' : '利用者'}: ${t.text}`).join('\n')}`;
        
        // 2. Prepare Prompt Text
        const promptText = `${template?.prompt}\n${customInstruction ? `追加指示: ${customInstruction}` : ''}\n\n対象データ:\n${transcriptText}`;

        // 3. Build Parts for Multimodal Request
        const parts: any[] = [{ text: promptText }];

        // 4. Add RAG Documents
        if (documents.length > 0) {
            parts.push({ text: "\n\n【参照資料】\n以下の資料も考慮して要約を作成してください。" });
            
            documents.forEach(doc => {
                if (doc.type === 'text/plain') {
                    parts.push({ text: `\n--- ${doc.name} ---\n${doc.content}\n----------------\n` });
                } else {
                    // Binary (PDF/Image)
                    parts.push({ 
                        inlineData: { 
                            mimeType: doc.type, 
                            data: doc.content 
                        } 
                    });
                    parts.push({ text: `(上記は資料: ${doc.name})` });
                }
            });
        }

        const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
        const response = await ai.models.generateContent({
            model: MODEL_NAMES.SUMMARY,
            contents: { parts }
        });

        setSummary(response.text || "要約生成失敗");
    } catch (e: any) {
        setErrorMsg(`要約生成エラー: ${e.message}`);
    } finally {
        setStatus(AppStatus.IDLE);
    }
  };

  // --- Render ---

  return (
    <div className="flex flex-col h-screen bg-slate-50 text-slate-800 font-sans">
      
      {/* Header */}
      <header className="h-16 bg-white border-b border-slate-200 flex items-center justify-between px-4 md:px-6 shadow-sm z-20">
         <div className="flex items-center gap-2 md:gap-3 flex-shrink-0">
             <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center text-white">
                 <Mic size={20} />
             </div>
             <h1 className="font-bold text-sm md:text-lg text-slate-800 tracking-tight whitespace-nowrap">面談AI要約</h1>
         </div>
         
         <div className="flex items-center gap-2 md:gap-4 flex-shrink-0">
             <button 
                onClick={resetSession}
                className="flex items-center gap-1.5 px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-lg transition-colors text-sm font-medium"
                title="初期化"
             >
                <RotateCcw size={18} />
                <span className="hidden md:inline">リセット</span>
             </button>

            <span className={`hidden sm:flex px-3 py-1 rounded-full text-xs font-medium items-center gap-1.5 ${
                status === AppStatus.RECORDING 
                    ? 'bg-red-50 text-red-600 border border-red-100 animate-pulse'
                    : 'bg-slate-100 text-slate-500'
            }`}>
                <div className={`w-2 h-2 rounded-full ${status === AppStatus.RECORDING ? 'bg-red-500' : 'bg-slate-400'}`} />
                {status === AppStatus.RECORDING ? '録音中' : '待機中'}
            </span>
            {/* Simple status dot for mobile */}
            <div className={`sm:hidden w-3 h-3 rounded-full ${status === AppStatus.RECORDING ? 'bg-red-500 animate-pulse' : 'bg-slate-300'}`} />

            <button 
                className="md:hidden p-2 text-slate-600 hover:bg-slate-100 rounded-lg"
                onClick={() => setIsMobileMenuOpen(true)}
            >
                <Menu size={24} />
            </button>
         </div>
      </header>

      {/* Main Layout */}
      <main className="flex-1 flex overflow-hidden relative">
        <div className="flex-1 flex flex-col relative overflow-hidden">
             {errorMsg && (
                 <div className="m-4 p-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg flex items-center gap-2 animate-fade-in">
                     <AlertCircle size={16} /> {errorMsg}
                     <button onClick={() => setErrorMsg(null)} className="ml-auto"><X size={14}/></button>
                 </div>
             )}
             
             {status === AppStatus.PROCESSING && !summary && (
                  <div className="absolute inset-0 bg-white/50 z-20 flex items-center justify-center backdrop-blur-sm">
                      <div className="bg-white p-6 rounded-2xl shadow-xl flex flex-col items-center gap-3">
                          <Loader2 className="animate-spin text-indigo-600" size={32} />
                          <p className="font-bold text-slate-700">AIが音声を分析中...</p>
                      </div>
                  </div>
             )}
             
             <div className="flex-1 overflow-y-auto bg-slate-50/50">
                 <TranscriptView 
                    key={sessionId} // Force remount on reset
                    transcripts={transcripts}
                    onEdit={updateTranscript}
                    isRecording={status === AppStatus.RECORDING}
                 />
             </div>

             <div className="absolute bottom-8 left-0 right-0 flex flex-col items-center gap-4 z-10 pointer-events-none">
                 <div className="pointer-events-auto">
                    {(status === AppStatus.IDLE || status === AppStatus.ERROR || (status === AppStatus.PROCESSING && summary)) && !hasPostProcessed && !isSessionFinished ? (
                        <button
                            onClick={startRecording}
                            className="flex items-center gap-2 px-8 py-4 bg-indigo-600 hover:bg-indigo-700 text-white rounded-full shadow-xl shadow-indigo-500/30 font-bold transition-all transform hover:scale-105 active:scale-95 border-4 border-white"
                        >
                            <PlayCircle size={24} /> 面談を開始
                        </button>
                    ) : (
                        status === AppStatus.RECORDING ? (
                            <button
                                onClick={stopRecording}
                                className="flex items-center gap-2 px-8 py-4 bg-red-500 hover:bg-red-600 text-white rounded-full shadow-xl shadow-red-500/30 font-bold transition-all transform hover:scale-105 active:scale-95 border-4 border-white"
                            >
                                <StopCircle size={24} /> 面談を終了
                            </button>
                        ) : null
                    )}
                 </div>
             </div>
        </div>

        <div className="hidden md:block w-[400px] h-full z-10">
            <SummaryPanel 
                key={sessionId} // Force remount on reset
                status={status}
                summary={summary}
                onGenerate={generateSummary}
                onFileUpload={handleFileUpload}
                documents={documents}
                onRemoveDocument={removeDocument}
            />
        </div>

        {isMobileMenuOpen && (
            <div className="fixed inset-0 z-50 md:hidden flex justify-end">
                <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setIsMobileMenuOpen(false)} />
                <div className="w-[85%] max-w-sm h-full relative z-10 bg-white shadow-2xl animate-slide-in-right">
                    <div className="absolute top-4 left-4 font-bold text-slate-700 flex items-center gap-2">
                       <Mic size={18} className="text-indigo-600"/> メニュー
                    </div>
                    <button onClick={() => setIsMobileMenuOpen(false)} className="absolute top-4 right-4 p-2 text-slate-400">
                        <X />
                    </button>
                    <div className="mt-12 h-full">
                        <SummaryPanel 
                            key={sessionId}
                            status={status}
                            summary={summary}
                            onGenerate={generateSummary}
                            onFileUpload={handleFileUpload}
                            documents={documents}
                            onRemoveDocument={removeDocument}
                        />
                    </div>
                </div>
            </div>
        )}
      </main>
    </div>
  );
};

export default App;