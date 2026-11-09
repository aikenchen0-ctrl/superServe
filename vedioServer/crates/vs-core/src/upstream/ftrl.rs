// SPDX-License-Identifier: MIT
// Copyright (c) 2026 RillML contributors
// 改编自 hello-yunshu/rill-ml，提交9602750202f56ed860fc8815bb91e81083d0ffdb：
// src/models/ftrl.rs 的权重及梯度更新，src/loss/log_loss.rs 的稳定 sigmoid。
// 改为有界坐标表、固定超参数和批量提交；在线只导出权重，不保留优化器状态。

use crate::DomainError;

const ALPHA: f64 = 0.1;
const BETA: f64 = 1.0;
const L1: f64 = 0.01;
const L2: f64 = 1.0;

#[derive(Clone, Copy, Default)]
struct Param {
    z: f64,
    n: f64,
}

impl Param {
    fn weight(self, intercept: bool) -> f64 {
        let l1 = if intercept { 0.0 } else { L1 };
        if self.z.abs() <= l1 {
            0.0
        } else {
            -(self.z - self.z.signum() * l1) / (L2 + (BETA + self.n.sqrt()) / ALPHA)
        }
    }

    fn next(self, gradient: f64, weight: f64) -> Result<Self, DomainError> {
        let squared = gradient * gradient;
        let n = self.n + squared;
        let sigma = (n.sqrt() - self.n.sqrt()) / ALPHA;
        let z = self.z + gradient - sigma * weight;
        if (gradient != 0.0 && squared == 0.0)
            || ![squared, n, sigma, z].iter().all(|value| value.is_finite())
        {
            return Err(DomainError::Invalid("ftrl_numeric_state"));
        }
        Ok(Self { z, n })
    }
}

pub(crate) fn sigmoid(value: f64) -> f64 {
    if value >= 0.0 {
        1.0 / (1.0 + (-value).exp())
    } else {
        let e = value.exp();
        e / (1.0 + e)
    }
}

pub(crate) struct Ftrl {
    params: Vec<Param>,
}

impl Ftrl {
    pub(crate) fn new(dimensions: usize) -> Self {
        Self {
            params: vec![Param::default(); dimensions],
        }
    }

    pub(crate) fn learn<const N: usize>(
        &mut self,
        features: &[f64; N],
        domain_offset: usize,
        positive: bool,
    ) -> Result<(), DomainError> {
        let weights = |offset: usize, index: usize| {
            self.params[offset + index].weight(offset == 0 && index == 0)
        };
        let logit: f64 = features
            .iter()
            .enumerate()
            .map(|(i, value)| value * (weights(0, i) + weights(domain_offset, i)))
            .sum();
        let gradient = sigmoid(logit) - f64::from(positive);
        let mut global = [Param::default(); N];
        let mut domain = [Param::default(); N];
        // 同一样本的所有坐标先计算成功，再提交，数值失败不会留下半次更新。
        for (i, value) in features.iter().enumerate() {
            global[i] = self.params[i].next(gradient * value, weights(0, i))?;
            domain[i] =
                self.params[domain_offset + i].next(gradient * value, weights(domain_offset, i))?;
        }
        self.params[..N].copy_from_slice(&global);
        self.params[domain_offset..domain_offset + N].copy_from_slice(&domain);
        Ok(())
    }

    pub(crate) fn weights(&self) -> Vec<f64> {
        self.params
            .iter()
            .enumerate()
            .map(|(i, param)| param.weight(i == 0))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copied_coordinate_equations_match_an_independent_first_update() {
        let mut optimizer = Ftrl::new(4);
        optimizer.learn(&[1.0, 0.5], 2, true).unwrap();
        let weights = optimizer.weights();
        assert!((weights[0] - 0.5 / 16.0).abs() < 1e-14);
        assert!((weights[1] - 0.24 / 13.5).abs() < 1e-14);
        assert!((weights[2] - 0.49 / 16.0).abs() < 1e-14);
        assert_eq!(weights[3], weights[1]);
        let before = weights;
        assert!(optimizer.learn(&[1.0, f64::NAN], 2, false).is_err());
        assert_eq!(optimizer.weights(), before);
        assert_eq!(sigmoid(-1000.0), 0.0);
        assert_eq!(sigmoid(1000.0), 1.0);
    }
}
