// ---------------------------------------------------------------------------
// Sunshine log latency parser
// ---------------------------------------------------------------------------
//
// Sunshine writes periodic Debug lines to its log every ~20s while streaming:
//   Frame processing latency (min/max/avg): 0.00ms/5.70ms/0.03ms
//   Network: frame's overall network latency (min/max/avg): 0.05ms/0.21ms/0.09ms
//   NvEnc: encoded frame sizes in kB (min/max/avg): 10.91/15.15/12.65
//
// This module finds the latest log, reads its tail, and extracts the most
// recent occurrence of each metric. No I/O happens at module load — callers
// invoke functions explicitly.

import * as fs from 'fs';
import * as path from 'path';

export interface MetricTriple {
  min: number;
  max: number;
  avg: number;
}

export interface LatencySnapshot {
  frameProcessingMs: MetricTriple | null;
  networkMs: MetricTriple | null;
  encodedSizeKb: MetricTriple | null;
  // Path of the log we read; useful for the UI to show provenance.
  logPath: string | null;
  // True if logs directory exists and a log file was found.
  found: boolean;
  // Optional human-readable error if we hit one.
  error?: string;
}

export const EMPTY_SNAPSHOT: LatencySnapshot = {
  frameProcessingMs: null,
  networkMs: null,
  encodedSizeKb: null,
  logPath: null,
  found: false,
};

/**
 * Returns the absolute path of the newest sunshine-*.log in `dir`, or null.
 * Never throws — returns null on any I/O error.
 */
export function findLatestLog(dir: string): string | null {
  try {
    if (!fs.existsSync(dir)) { return null; }
    const entries = fs.readdirSync(dir);
    const candidates = entries
      .filter((name) => /^sunshine-.*\.log$/i.test(name))
      .map((name) => {
        const full = path.join(dir, name);
        try {
          return { full, mtime: fs.statSync(full).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((x): x is { full: string; mtime: number } => x !== null);
    if (candidates.length === 0) { return null; }
    candidates.sort((a, b) => b.mtime - a.mtime);
    return candidates[0].full;
  } catch {
    return null;
  }
}

/**
 * Reads the last `bytes` of `filePath` and returns it as a string. If the
 * file is smaller, returns the whole file. Never throws — returns ''
 * on any error.
 */
export function readTail(filePath: string, bytes: number): string {
  try {
    const stat = fs.statSync(filePath);
    const start = Math.max(0, stat.size - bytes);
    const fd = fs.openSync(filePath, 'r');
    try {
      const length = stat.size - start;
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, start);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

const RE_FRAME_PROC = /Frame processing latency \(min\/max\/avg\):\s*([\d.]+)ms\/([\d.]+)ms\/([\d.]+)ms/g;
const RE_NETWORK = /frame'?s? overall network latency \(min\/max\/avg\):\s*([\d.]+)ms\/([\d.]+)ms\/([\d.]+)ms/g;
const RE_ENC_SIZE = /NvEnc:.*encoded frame sizes in kB \(min\/max\/avg\):\s*([\d.]+)\/([\d.]+)\/([\d.]+)/g;

function lastMatch(re: RegExp, text: string): MetricTriple | null {
  re.lastIndex = 0;
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    last = m;
  }
  if (!last) { return null; }
  return {
    min: Number(last[1]),
    max: Number(last[2]),
    avg: Number(last[3]),
  };
}

/**
 * Extracts the most recent occurrence of each metric from a tail of log
 * text. Missing metrics return null; never throws.
 */
export function parseLatencyTail(text: string): {
  frameProcessingMs: MetricTriple | null;
  networkMs: MetricTriple | null;
  encodedSizeKb: MetricTriple | null;
} {
  return {
    frameProcessingMs: lastMatch(RE_FRAME_PROC, text),
    networkMs: lastMatch(RE_NETWORK, text),
    encodedSizeKb: lastMatch(RE_ENC_SIZE, text),
  };
}

/**
 * High-level entry point: find latest log in `dir`, read its tail, parse,
 * and return a snapshot. Never throws.
 */
export function readLatencySnapshot(dir: string, tailBytes = 64 * 1024): LatencySnapshot {
  const logPath = findLatestLog(dir);
  if (!logPath) {
    return {
      ...EMPTY_SNAPSHOT,
      error: `No Sunshine logs found in ${dir}`,
    };
  }
  const text = readTail(logPath, tailBytes);
  const parsed = parseLatencyTail(text);
  return {
    ...parsed,
    logPath,
    found: true,
  };
}
