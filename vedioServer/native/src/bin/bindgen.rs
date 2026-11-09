// SPDX-License-Identifier: MPL-2.0
// 改编UniFFI固定版本的命令入口；仅开发工具启用，不进入播放器运行库。
fn main() {
    uniffi::uniffi_bindgen_main();
}
