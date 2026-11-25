import { runProcess } from "./process.js";
import { tools } from "./tools.js";

export interface LoudnessMeasurement { version: 1; integratedLufs: number; truePeakDbtp: number; }

export function validLoudness(value: unknown): value is LoudnessMeasurement {
  const m = value as LoudnessMeasurement | undefined;
  return m?.version === 1 && Number.isFinite(m.integratedLufs) && m.integratedLufs >= -70 && m.integratedLufs <= 5 &&
    Number.isFinite(m.truePeakDbtp) && m.truePeakDbtp >= -100 && m.truePeakDbtp <= 20;
}

export function parseLoudness(stderr: string): LoudnessMeasurement | undefined {
  const start = stderr.lastIndexOf("{");
  const end = stderr.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const stats = JSON.parse(stderr.slice(start, end + 1));
    if (typeof stats.input_i !== "string" || typeof stats.input_tp !== "string" || !stats.input_i.trim() || !stats.input_tp.trim()) return undefined;
    const result = { version: 1, integratedLufs: Number(stats.input_i), truePeakDbtp: Number(stats.input_tp) } as const;
    return validLoudness(result) ? result : undefined;
  } catch { return undefined; }
}

export async function measureLoudness(file: string, signal: AbortSignal) {
  const { ffmpeg, env } = tools();
  if (!ffmpeg) return undefined;
  const result = await runProcess(ffmpeg, ["-nostdin", "-hide_banner", "-nostats", "-loglevel", "info",
    "-protocol_whitelist", "file,pipe", "-threads", "1", "-filter_threads", "1", "-i", file,
    "-map", "0:a:0", "-vn", "-sn", "-dn", "-af", "loudnorm=I=-18:TP=-1:LRA=11:print_format=json",
    "-f", "null", "-"], env, 20_000, 128 * 1024, signal);
  return result.code === 0 ? parseLoudness(result.stderr) : undefined;
}
