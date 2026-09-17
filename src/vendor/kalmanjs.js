/**
 * Vendored from: https://github.com/wouterbulten/kalmanjs (MIT License)
 * Copyright 2015-2018 Wouter Bulten — src/kalman.js, aynen alındı (1D filtre).
 * Self-host: npm/CDN yok, dosya repoda. Sadece hız kanalı yumuşatmada kullanılıyor.
 * @preserve MIT License (wouterbulten/kalmanjs)
 */
export default class KalmanFilter {
  constructor({ R = 1, Q = 1, A = 1, B = 0, C = 1 } = {}) {
    this.R = R
    this.Q = Q
    this.A = A
    this.C = C
    this.B = B
    this.cov = NaN
    this.x = NaN
  }
  filter(z, u = 0) {
    if (isNaN(this.x)) {
      this.x = (1 / this.C) * z
      this.cov = (1 / this.C) * this.Q * (1 / this.C)
    } else {
      const predX = this.predict(u)
      const predCov = this.uncertainty()
      const K = predCov * this.C * (1 / (this.C * predCov * this.C + this.Q))
      this.x = predX + K * (z - this.C * predX)
      this.cov = predCov - K * this.C * predCov
    }
    return this.x
  }
  predict(u = 0) {
    return this.A * this.x + this.B * u
  }
  uncertainty() {
    return this.A * this.cov * this.A + this.R
  }
  lastMeasurement() {
    return this.x
  }
  setMeasurementNoise(noise) {
    this.Q = noise
  }
  setProcessNoise(noise) {
    this.R = noise
  }
}
