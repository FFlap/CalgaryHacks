declare module 'youtube-transcript-plus' {
  export type TranscriptRawSegment = {
    offset: number | string;
    text: string;
  };

  export type TranscriptFetchParams = {
    url: string;
    lang?: string;
    userAgent?: string;
    method?: 'GET' | 'POST';
    body?: string;
    headers?: Record<string, string>;
  };

  export type TranscriptFetchHook = (params: TranscriptFetchParams) => Promise<Response>;

  export function fetchTranscript(
    videoId: string,
    options?: {
      lang?: string;
      videoFetch?: TranscriptFetchHook;
      playerFetch?: TranscriptFetchHook;
      transcriptFetch?: TranscriptFetchHook;
    },
  ): Promise<TranscriptRawSegment[]>;
}
