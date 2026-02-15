import { YoutubeTranscript } from 'youtube-transcript';

const YOUTUBE_URL_PATTERNS = [
  /^https?:\/\/(www\.)?youtube\.com\/watch\?/i,
  /^https?:\/\/youtu\.be\//i,
  /^https?:\/\/(www\.)?youtube\.com\/shorts\//i,
];

export function isYouTubeUrl(url: string): boolean {
  return YOUTUBE_URL_PATTERNS.some((pattern) => pattern.test(url));
}

export function extractVideoId(url: string): string | null {
  try {
    const parsed = new URL(url);

    // youtube.com/watch?v=VIDEO_ID
    if (parsed.hostname.includes('youtube.com') && parsed.searchParams.has('v')) {
      return parsed.searchParams.get('v');
    }

    // youtu.be/VIDEO_ID
    if (parsed.hostname === 'youtu.be') {
      const id = parsed.pathname.slice(1).split('/')[0];
      return id || null;
    }

    // youtube.com/shorts/VIDEO_ID
    const shortsMatch = parsed.pathname.match(/\/shorts\/([^/?]+)/);
    if (shortsMatch?.[1]) {
      return shortsMatch[1];
    }
  } catch {
    // Invalid URL
  }
  return null;
}

export async function fetchYouTubeTranscript(
  url: string,
): Promise<{ text: string; videoId: string }> {
  const videoId = extractVideoId(url);
  if (!videoId) {
    throw new Error('Could not extract a video ID from the YouTube URL.');
  }

  const segments = await YoutubeTranscript.fetchTranscript(videoId);
  if (!segments || segments.length === 0) {
    throw new Error(
      'No transcript available for this video. The video may not have captions enabled.',
    );
  }

  const text = segments.map((segment) => segment.text).join(' ');
  return { text, videoId };
}
