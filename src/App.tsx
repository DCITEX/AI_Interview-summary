import React, { useState, useRef, useEffect } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { TranscriptItem, RagDocument, AppStatus } from './types';
import { TEMPLATES, MODEL_NAMES } from './constants';
import { createPcmBlob, arrayBufferToBase64 } from './services/audioUtils';
import TranscriptView from './components/TranscriptView';
import SummaryPanel from './components/SummaryPanel';
import { Mic, AlertCircle, PlayCircle, StopCircle, Menu, X, RotateCcw, Loader2 } from 'lucide-react';

const App: React.FC = () => {
  // --- State ---
  const [status, setStatus] = useState<AppStatus>(AppStatus.IDLE);
  const [transcripts, setTranscripts] = useState<TranscriptItem[]>([]);
  const [summary, setSummary] = useState<string>('');
  const [documents, setDocuments] = useState<RagDocument[]>([]);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
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
  
  // --- API Key Initialization ---
  // Safely retrieve API key handling different environments
  const getApiKey = () => {
    try {
      // Check Vite env
      // @ts-ignore
      if (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_API_KEY) {
        // @ts-ignore
        return import.meta.env.VITE_API_KEY;
      }
    } catch (e) {}
    
    try {
      // Check Node env (fallback)
      // @ts-ignore
      if (typeof process !== 'undefined' && process.env && process.env.API_KEY) {
        // @ts-ignore
        return process.env.API_KEY;
      }
    } catch (e) {}
    
    return undefined;
  };
  
  const apiKey = getApiKey();
  
  // --- Helpers ---
  const updateTranscript = (id: string, text: string, isFinal: boolean) => {
    setTranscripts(prev => {
      const existing = prev.find(t => t.id === id);
      if (existing) {
        return prev.map(t => t.id === id ? { ...t, text, isFinal } : t);
      } else {
        return [...prev, {
          id,
          speaker: 'Staff', // Default to Staff during live recording
          text,
          timestamp: new Date(),
          isFinal
        }];
      }
    });
  };

  // --- Actions ---

  const startRecording = async () => {
    if (!apiKey) {
      setErrorMsg("APIキーが設定されていません。.envファイルを確認してください。");
      return;
    }

    setErrorMsg(null);
    setTranscripts([]);
    setSummary('');
    audioChunksRef.current = [];
    
    try {
      setStatus(AppStatus.CONNECTING);

      // 1. Setup Audio Stream
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ 
            audio: {
                sampleRate: 16000,
                channelCount: 1,
                echoCancellation: true,
                noiseSuppression: true
            } 
        });
      } catch (err: any) {
        if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
            throw new Error("マイクが見つかりません。マイクが接続されているか確認してください。");
        } else if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
            throw new Error("マイクの使用が許可されていません。ブラウザの設定でマイクへのアクセスを許可してください。");
        } else if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
            throw new Error("マイクにアクセスできません。他のアプリケーション（Zoomなど）がマイクを使用していないか確認してください。");
        } else {
            throw new Error("マイクの初期化に失敗しました: " + err.message);
        }
      }
      
      streamRef.current = stream;

      // 2. Setup MediaRecorder for background recording (Full Quality for Post-Processing)
      // Use a lower bitrate to prevent massive file sizes on long recordings
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') 
        ? 'audio/webm;codecs=opus' 
        : 'audio/webm';
        
      const mediaRecorder = new MediaRecorder(stream, { 
        mimeType,
        audioBitsPerSecond: 64000 // 64kbps is sufficient for voice
      });
      
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };
      mediaRecorder.start(1000); // Time slice 1s to ensure data is saved incrementally
      mediaRecorderRef.current = mediaRecorder;

      // 3. Setup AudioContext for Realtime API
      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      // Ensure context is running (fixes some browser autoplay policies)
      await audioContext.resume();
      audioContextRef.current = audioContext;

      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      
      // 4. Connect to Gemini Live API
      const ai = new GoogleGenAI({ apiKey });
      const session = await ai.live.connect({
        model: MODEL_NAMES.LIVE,
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
          systemInstruction: `
あなたは面談の書記です。ユーザーの発言を聞き取り、正確な日本語の書き起こしテキストを生成してください。
返答や会話は一切しないでください。あなたの役割は「inputTranscription」イベントを発生させることだけです。
音声認識が誤りやすい、以下の点に注意してください：
- "あー"、"えー" などのフィラーは削除して、整った文章にしてください。
- 文脈に合わせて適切な句読点を補ってください。
- 音声に含まれていない情報は絶対に追記しないこと（ハルシネーション対策）。
          `,
          inputAudioTranscription: { model: "google-speech-to-text-japanese" },
        },
        callbacks: {
          onopen: () => {
            console.log("Gemini Live Connected");
            setStatus(AppStatus.RECORDING);
          },
          onmessage: (msg: LiveServerMessage) => {
            // We only care about transcriptions
            const text = msg.serverContent?.inputTranscription?.text;
            if (text) {
              // Optionally handle live transcriptions if needed
            }
          },
          onclose: () => {
             console.log("Gemini Live Disconnected");
          },
          onerror: (err) => {
            console.error("Gemini Live Error:", err);
            if (status === AppStatus.RECORDING) {
                // If we get an error while recording, try to save what we have
                stopRecording(true); 
                setErrorMsg("サーバー接続が切れました（データは保存されました）");
            }
          }
        }
      });

      sessionRef.current = session;

      // 5. Start Streaming Audio
      processor.onaudioprocess = (e) => {
        const inputData = e.inputBuffer.getChannelData(0);
        const pcmBlob = createPcmBlob(inputData);
        session.sendRealtimeInput({ media: pcmBlob });
      };

      source.connect(processor);
      processor.connect(audioContext.destination);
      scriptProcessorRef.current = processor;

    } catch (e: any) {
      console.error(e);
      setErrorMsg(e.message || "録音の開始に失敗しました");
      setStatus(AppStatus.IDLE);
      // Clean up if partially started
      if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
    }
  };

  const stopRecording = async (isError = false) => {
    if (status !== AppStatus.RECORDING && status !== AppStatus.CONNECTING) return;

    // 1. Stop Gemini Session
    if (sessionRef.current) {
      sessionRef.current = null;
    }

    // 2. Stop Audio Processing
    if (scriptProcessorRef.current) {
      scriptProcessorRef.current.disconnect();
      scriptProcessorRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }

    // 3. Stop Media Recorder and Save Blob
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.requestData(); 
      
      const blobPromise = new Promise<Blob>((resolve) => {
        if (!mediaRecorderRef.current) {
             resolve(new Blob([], { type: 'audio/webm' }));
             return;
        }
        
        mediaRecorderRef.current.onstop = () => {
            const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
            resolve(blob);
        };
        mediaRecorderRef.current.stop();
      });

      // Wait for blob then proceed
      const blob = await blobPromise;
      setRecordedBlob(blob);
      setIsSessionFinished(true);

      if (!isError) {
        // Automatically start analysis
        analyzeAudioAndDiarize(blob);
      } else {
        setStatus(AppStatus.IDLE);
      }
    } else {
        setStatus(AppStatus.IDLE);
        setIsSessionFinished(true);
    }
  };

  const analyzeAudioAndDiarize = async (audioBlob: Blob) => {
    if (!apiKey) return;
    setStatus(AppStatus.PROCESSING);
    setErrorMsg(null);

    try {
        const ai = new GoogleGenAI({ apiKey });
        
        // Convert Blob to Base64
        const buffer = await audioBlob.arrayBuffer();
        const base64Audio = arrayBufferToBase64(buffer);

        // Prompt for Diarization
        const response = await ai.models.generateContent({
            model: MODEL_NAMES.SUMMARY,
            contents: {
                parts: [
                    {
                        inlineData: {
                            mimeType: "audio/webm",
                            data: base64Audio
                        }
                    },
                    {
                        text: `
この音声は、就労移行支援事業所での「支援員(Staff)」と「利用者(Client)」の面談記録です。
以下の手順で処理を行ってください：

1. 話者を「Staff」と「Client」に分離してください。
   - 敬語を使っている、質問している、指導している方が「Staff」です。
   - 自身の体調や状況を話している方が「Client」です。
2. 音声認識の誤りを修正し、自然な日本語の書き起こしを作成してください。
   - "あー"、"えー" などのフィラーは削除。
   - 文脈に沿って句読点を付与。
   - 音声に含まれていない情報は絶対に追記しないこと（ハルシネーション対策）。
3. 結果を以下のJSON形式で出力してください。
   [
     { "speaker": "Staff", "text": "...", "timestamp": "00:00" },
     { "speaker": "Client", "text": "...", "timestamp": "00:05" }
   ]
`
                    }
                ]
            },
            config: {
                responseMimeType: "application/json"
            }
        });

        let jsonText = response.text || "";
        
        // Robust JSON cleaning
        // 1. Try to find the first array brackets
        const match = jsonText.match(/\[[\s\S]*\]/);
        if (match) {
            jsonText = match[0];
        } else {
            // Fallback: cleanup common markdown
            jsonText = jsonText.replace(/```json\s*/g, '').replace(/```/g, '').trim();
        }

        let result;
        try {
            result = JSON.parse(jsonText);
        } catch (e) {
            console.error("JSON parse error:", jsonText);
            throw new Error("AIの応答をJSONとして解析できませんでした。");
        }

        // Convert to internal TranscriptItem format
        const newTranscripts: TranscriptItem[] = result.map((item: any, index: number) => ({
            id: `auto-${index}`,
            speaker: (item.speaker === 'Staff' || item.speaker === 'Client') ? item.speaker : 'Staff',
            text: item.text,
            timestamp: new Date(),
            isFinal: true
        }));

        setTranscripts(newTranscripts);
        setHasPostProcessed(true);
        setStatus(AppStatus.IDLE);

    } catch (e: any) {
        console.error(e);
        setErrorMsg("AI分析中にエラーが発生しました: " + e.message);
        setStatus(AppStatus.IDLE);
    }
  };

  const generateSummary = async (templateId: string, customInstruction: string) => {
    if (!apiKey) return;
    if (transcripts.length === 0 && documents.length === 0) {
      alert("要約する内容（会話ログまたは資料）がありません。");
      return;
    }
    
    setStatus(AppStatus.PROCESSING);
    
    try {
      const template = TEMPLATES.find(t => t.id === templateId);
      const promptText = template ? template.prompt : '';
      
      // Construct conversation log
      const conversationLog = transcripts
        .map(t => `[${t.speaker}]: ${t.text}`)
        .join('\n');

      const ai = new GoogleGenAI({ apiKey });

      // Construct parts: Text Prompt + Images/PDFs
      const parts: any[] = [];

      // 1. Text Prompt (Conversation + Instructions)
      let fullPrompt = `
【指示】
${promptText}

【追加指示】
${customInstruction}

【会話ログ】
${conversationLog.length > 0 ? conversationLog : "(会話ログなし)"}
`;
      // If there are text documents, append them to the prompt text
      const textDocs = documents.filter(d => d.type === 'text/plain' || d.type === 'application/json');
      if (textDocs.length > 0) {
        fullPrompt += `\n\n【参照資料テキスト】\n`;
        textDocs.forEach(d => {
            fullPrompt += `--- ${d.name} ---\n${d.content}\n\n`;
        });
      }

      // Add the main text part
      parts.push({ text: fullPrompt });

      // 2. Binary Documents (Images/PDFs)
      documents.forEach(doc => {
        if (doc.type !== 'text/plain' && doc.type !== 'application/json') {
            // content is base64 string
            parts.push({
                inlineData: {
                    mimeType: doc.type,
                    data: doc.content
                }
            });
        }
      });

      const response = await ai.models.generateContent({
        model: MODEL_NAMES.SUMMARY,
        contents: { parts: parts },
        config: {
            systemInstruction: "あなたは就労移行支援事業所の熟練した支援員です。客観的かつ専門的な視点で記録を作成してください。音声や資料に含まれていない情報は絶対に捏造しないでください。",
        }
      });

      setSummary(response.text || '');
    } catch (e: any) {
      console.error(e);
      setErrorMsg("要約の生成に失敗しました: " + e.message);
    } finally {
      setStatus(AppStatus.IDLE);
    }
  };

  const handleFileUpload = async (files: FileList) => {
    const newDocs: RagDocument[] = [];
    
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      
      try {
        let content = '';
        let docType: string = 'text/plain';

        if (file.type === 'application/pdf') {
            docType = 'application/pdf';
            content = await fileToBase64(file);
        } else if (file.type.startsWith('image/')) {
            if (file.type === 'image/png') docType = 'image/png';
            else if (file.type === 'image/webp') docType = 'image/webp';
            else docType = 'image/jpeg';
            content = await fileToBase64(file);
        } else {
            docType = 'text/plain';
            content = await file.text();
        }

        newDocs.push({
          id: Math.random().toString(36).substr(2, 9),
          name: file.name,
          content: content,
          type: docType as RagDocument['type'] // Explicit cast to allow broader types
        });
      } catch (e) {
        console.error("File read error", e);
      }
    }
    
    setDocuments(prev => [...prev, ...newDocs]);
  };

  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const result = reader.result as string;
            // Remove Data URL prefix (e.g. "data:image/png;base64,")
            const base64 = result.split(',')[1];
            resolve(base64);
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
  };

  const removeDocument = (id: string) => {
    setDocuments(prev => prev.filter(d => d.id !== id));
  };

  const resetSession = () => {
    if (!window.confirm("現在の記録をすべて削除して、初期状態に戻しますか？\n（保存していないデータは失われます）")) {
        return;
    }
    // Stop any ongoing processes
    if (status === AppStatus.RECORDING) {
        if (sessionRef.current) sessionRef.current = null;
        if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
    }

    // Reset All States
    setTranscripts([]);
    setSummary('');
    setDocuments([]);
    setRecordedBlob(null);
    setHasPostProcessed(false);
    setIsSessionFinished(false);
    setErrorMsg(null);
    setStatus(AppStatus.IDLE);
    setSessionId(Date.now().toString()); // Force remount children
  };

  // --- Render ---
  return (
    <div className="flex flex-col h-screen bg-slate-50 text-slate-900">
      
      {/* Header */}
      <header className="flex-shrink-0 bg-white border-b border-slate-200 px-4 py-3 flex items-center justify-between shadow-sm z-10 h-16">
        <div className="flex items-center gap-3">
            <div className="bg-indigo-600 text-white p-2 rounded-lg">
                <Mic size={20} />
            </div>
            <h1 className="text-lg md:text-xl font-bold text-slate-800 tracking-tight">
                面談AI要約 <span className="hidden sm:inline text-slate-400 font-normal">| Assistant</span>
            </h1>
        </div>
        
        <div className="flex items-center gap-3">
             {/* Reset Button */}
             <button 
                onClick={resetSession}
                className="flex items-center gap-2 text-slate-500 hover:text-red-600 hover:bg-red-50 px-3 py-2 rounded-lg transition-colors"
                title="リセット"
             >
                <RotateCcw size={18} />
                <span className="hidden md:inline text-sm font-medium">リセット</span>
             </button>

             {/* Status Badge */}
             <div className={`hidden md:flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-bold border ${
                status === AppStatus.RECORDING ? 'bg-red-50 text-red-600 border-red-100 animate-pulse' : 
                status === AppStatus.PROCESSING ? 'bg-amber-50 text-amber-600 border-amber-100' :
                'bg-slate-100 text-slate-500 border-slate-200'
             }`}>
                <div className={`w-2 h-2 rounded-full ${
                    status === AppStatus.RECORDING ? 'bg-red-500' : 
                    status === AppStatus.PROCESSING ? 'bg-amber-500' :
                    'bg-slate-400'
                }`} />
                {status === AppStatus.IDLE && '待機中'}
                {status === AppStatus.CONNECTING && '接続中...'}
                {status === AppStatus.RECORDING && '記録中'}
                {status === AppStatus.PROCESSING && 'AI分析中...'}
             </div>

             {/* Mobile Menu Toggle */}
             <button 
                className="md:hidden p-2 text-slate-600 hover:bg-slate-100 rounded-lg"
                onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
             >
                {isMobileMenuOpen ? <X size={24} /> : <Menu size={24} />}
             </button>
        </div>
      </header>

      {/* Error Banner */}
      {errorMsg && (
        <div className="bg-red-50 border-b border-red-200 px-4 py-2 flex items-center justify-between animate-slide-down">
            <div className="flex items-center gap-2 text-sm text-red-700 font-medium">
                <AlertCircle size={16} />
                {errorMsg}
            </div>
            <button onClick={() => setErrorMsg(null)} className="text-red-400 hover:text-red-700">
                <X size={16} />
            </button>
        </div>
      )}

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden relative">
        
        {/* Left Panel: Transcript / Recording */}
        <div className={`flex-1 flex flex-col h-full relative transition-all duration-300 ${isMobileMenuOpen ? 'hidden md:flex' : 'flex'}`}>
            <TranscriptView 
                key={`${sessionId}-transcript`}
                transcripts={transcripts} 
                onEdit={(id, text) => updateTranscript(id, text, true)}
                isRecording={status === AppStatus.RECORDING}
            />
            
            {/* Floating Controls */}
            <div className="absolute bottom-8 left-1/2 transform -translate-x-1/2 flex items-center gap-4 z-20">
                {!isSessionFinished && status === AppStatus.IDLE && !hasPostProcessed && (
                    <button
                        onClick={startRecording}
                        className="flex items-center gap-3 bg-indigo-600 hover:bg-indigo-700 text-white px-8 py-4 rounded-full shadow-xl shadow-indigo-500/30 transition-all hover:scale-105 font-bold text-lg"
                    >
                        <PlayCircle size={24} /> 面談を開始
                    </button>
                )}

                {status === AppStatus.RECORDING && (
                    <button
                        onClick={() => stopRecording()}
                        className="flex items-center gap-3 bg-red-500 hover:bg-red-600 text-white px-8 py-4 rounded-full shadow-xl shadow-red-500/30 transition-all hover:scale-105 font-bold text-lg animate-pulse"
                    >
                        <StopCircle size={24} /> 面談を終了
                    </button>
                )}
            </div>

            {/* Analysis Overlay */}
            {status === AppStatus.PROCESSING && (
                <div className="absolute inset-0 bg-white/80 backdrop-blur-sm z-30 flex flex-col items-center justify-center">
                    <Loader2 size={48} className="text-indigo-600 animate-spin mb-4" />
                    <h3 className="text-xl font-bold text-slate-800">AIが分析中...</h3>
                    <p className="text-slate-500 mt-2">話者の分離と文章の整型を行っています</p>
                </div>
            )}
        </div>

        {/* Right Panel: Summary & Tools */}
        <div className={`
            fixed md:relative inset-y-0 right-0 w-full md:w-96 bg-white z-40 transform transition-transform duration-300 shadow-2xl md:shadow-none
            ${isMobileMenuOpen ? 'translate-x-0' : 'translate-x-full md:translate-x-0'}
        `}>
            <SummaryPanel 
                key={`${sessionId}-summary`}
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
  );
};

export default App;