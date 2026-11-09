#[cfg(target_arch = "wasm32")]
mod web {
    use vs_core::playback::TimeBufferControl;
    use wasm_bindgen::prelude::*;

    fn integer(value: f64) -> Result<u32, JsError> {
        if !value.is_finite()
            || value.fract() != 0.0
            || !(0.0..=f64::from(u32::MAX)).contains(&value)
        {
            return Err(JsError::new("播放反馈必须为有效非负整数"));
        }
        Ok(value as u32)
    }

    /// Web外壳只转换整数和错误；加载判定全部复用共享Rust模块。
    #[wasm_bindgen]
    pub struct BufferTimeGate {
        control: TimeBufferControl,
    }

    #[wasm_bindgen]
    impl BufferTimeGate {
        #[wasm_bindgen(constructor)]
        pub fn new(min_buffer_ms: f64, max_buffer_ms: f64) -> Result<BufferTimeGate, JsError> {
            Ok(Self {
                control: TimeBufferControl::new(integer(min_buffer_ms)?, integer(max_buffer_ms)?)
                    .map_err(|error| JsError::new(&error.to_string()))?,
            })
        }

        pub fn should_load(
            &mut self,
            buffered_media_ms: f64,
            playback_rate_milli: f64,
        ) -> Result<bool, JsError> {
            self.control
                .should_load(integer(buffered_media_ms)?, integer(playback_rate_milli)?)
                .map_err(|error| JsError::new(&error.to_string()))
        }

        pub fn reset(&mut self) {
            self.control.reset();
        }
    }
}
