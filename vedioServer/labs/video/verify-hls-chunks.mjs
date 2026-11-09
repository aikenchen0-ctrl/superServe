import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: {
  ffmpeg: { type: "string" }, source: { type: "string" },
  publication: { type: "string" }, output: { type: "string" },
} });
if (Object.values(values).length !== 4) throw new Error("请指定--ffmpeg、--source、--publication、--output");
const output = path.resolve(values.output);
if (/^[cC]:/.test(output) || !process.env.TEMP || /^[cC]:/.test(process.env.TEMP)) {
  throw new Error("验证输出与临时目录必须位于非C盘");
}
const root = path.resolve(values.publication);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const source = path.resolve(values.source);
const publication = JSON.parse(await readFile(path.join(root, "publication.json"), "utf8"));
const report = {
  schema: "hls-chunks-independent-decode-v1",
  layout: publication.layout, source_sha256: digest(await readFile(source)),
  track_results: [], valid: false, scope: "完整轨道独立FFmpeg copyts逐行解码对照，不是实时弱网、原生或CPU测量",
};
async function decode(input, destination, trackIndex) {
  const child = spawn(values.ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-xerror", "-n", "-copyts", "-i", input,
    "-map", `0:${trackIndex}`, "-f", "framehash", "-hash", "sha256", destination,
  ], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (value) => { stderr += value; });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (code !== 0) throw new Error(`独立解码失败：${stderr}`);
  const text = await readFile(destination, "utf8");
  return text.split(/\r?\n/).filter((line) => line && !line.startsWith("#"));
}
for (const [index, track] of publication.tracks.entries()) {
  const parts = [];
  for (const hash of [track.init_sha256, ...track.segments.map((segment) => segment.sha256)]) {
    const bytes = await readFile(path.join(root, "media", hash));
    if (digest(bytes) !== hash) throw new Error("待解码对象指纹不符");
    parts.push(bytes);
  }
  const joined = path.join(root, `verify-${track.kind}.mp4`);
  await writeFile(joined, Buffer.concat(parts), { flag: "wx" });
  const original = await decode(source, path.join(root, `source-${track.kind}.framehash`), index);
  const actual = await decode(joined, path.join(root, `decoded-${track.kind}.framehash`), 0);
  if (!original.length || original.length !== actual.length
      || original.some((line, position) => line !== actual[position])) {
    throw new Error(`轨道${track.kind}的解码内容或时间线不一致`);
  }
  report.track_results.push({
    kind: track.kind, decoded_records: actual.length, rows_equal: true,
    source_rows_sha256: digest(original.join("\n")),
    decoded_rows_sha256: digest(actual.join("\n")),
    media_objects: track.segments.length, internal_chunks: track.segments.reduce((sum, segment) => sum + segment.chunk_count, 0),
    joined_bytes: parts.reduce((sum, bytes) => sum + bytes.length, 0),
  });
}
report.valid = true;
await writeFile(output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify(report, null, 2));
