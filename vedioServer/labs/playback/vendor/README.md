# 播放器复用来源

- 发布包：`hls.js@1.7.4`，npm官方注册表。
- 发布提交：`142fcab1fd0de99beafb0e1b07102ec674a9ddf9`。
- 发布包完整性：`sha512-3GlxGdPvT2YHvQYOt+yOzT/DEior/qJVNIylHA77kgeoBTdQQqi70GwefNEUmHQeNGyjC8U62+bruqW/Tpm+tg==`。
- `hls.min.js` SHA256：`cfc70cc9e9fc63d071919e087670abc760c8fd1bc889b88588026e4d22193bbe`。
- `hls.worker.js` SHA256：`8553e459962fdbb5813fc2d2cb45d171c7f9e91cfb82a3e44789e438e61aa743`。

发布包校验通过后，原样复制上述两个文件及上游`LICENSE`。无源码修改。
Apache-2.0完整条款见同目录`Apache-2.0.txt`，上游版权声明见`LICENSE`。
升级须重新核对发布身份、字节指纹和浏览器播放，不随页面加载从CDN拉取浮动版本。
这是浏览器媒体引擎依赖，第一方服务和业务控制面仍使用Rust。
