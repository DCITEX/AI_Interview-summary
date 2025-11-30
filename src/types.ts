export type SpeakerRole = 'Staff' | 'Client' | 'AI';

export interface TranscriptItem {
  id: string;
  speaker: SpeakerRole; // Changed from string to SpeakerRole for better type safety
  text: string;
  timestamp: Date;
  isFinal: boolean;
}

export interface SummaryTemplate {
  id: string;
  name: string;
  description: string;
  prompt: string;
}

export interface RagDocument {
  id: string;
  name: string;
  content: string;
  type: 'text/plain' | 'application/json'; // Simplified for this demo
}

export enum AppStatus {
  IDLE = 'IDLE',
  CONNECTING = 'CONNECTING',
  RECORDING = 'RECORDING',
  PROCESSING = 'PROCESSING',
  ERROR = 'ERROR',
}

export interface GenerationConfig {
  templateId: string;
  customInstructions: string;
}