# MP4 测试夹具

`h264-aac-tail.mp4` 是本项目用测试画面和合成正弦波生成的两秒视频，没有用户数据或外部媒体。
生成器为本机 FFmpeg 8.0，视频为 H.264、160×96、12 fps，音频为 AAC、24 kHz。
该文件的播放索引在媒体数据之后，用于验证真实编码载荷不会被改写。

长度为24984字节，SHA256为
`31f13210c4792575a4eace900480c5c15396cf9fad28765dbdf69a69ebbbe7f2`。

生成命令：

```powershell
ffmpeg -hide_banner -loglevel error -n `
  -f lavfi -i testsrc2=size=160x96:rate=12 `
  -f lavfi -i sine=frequency=440:sample_rate=24000 `
  -t 2 -map 0:v:0 -map 1:a:0 -map_metadata -1 `
  -c:v libx264 -preset medium -crf 30 -pix_fmt yuv420p -threads 1 -g 12 `
  -c:a aac -b:a 32k -fflags +bitexact -flags:v +bitexact -flags:a +bitexact `
  h264-aac-tail.mp4
```

Rust 测试直接读取该夹具，无需安装FFmpeg。独立解码验证另用FFmpeg比较输入与HTTP读回结果，
避免用同一个容器处理库自证可播放。FFmpeg不属于服务运行依赖。
